/**
 * Sync engine: checkout / sync / pull / tavern-change handling. See docs/architecture.md §3.
 *
 * Per item and target we keep a base hash B (the data both sides last agreed on).
 * W = hash of the workspace files encoded; T = hash reported by the tavern.
 *   W == B, T == B  in sync
 *   W != B, T == B  local changes  -> sync pushes
 *   W == B, T != B  tavern changes -> pull (automatic on item.changed)
 *   W != B, T != B  conflict       -> never overwritten silently
 */
import { hashData } from '../../shared/hash.js';
import { ERR, MSG, ProtocolError, RENAME_KINDS, assertAvatarRequest, assertItemRef, assertNewItemName, parsePresetId } from '../../shared/protocol.js';
import { newItem } from './defaults.js';
import { CODECS, codecFor } from './codec/index.js';
import { assignEntryUids } from './codec/lorebook.js';
import { CHARACTER_PARTS, META_FILE as ITEM_META_FILE, migrateExclude, omitParts, presentParts, restoreParts } from './codec/character.js';
import { detectFrameworks } from './codec/frameworks.js';
import { assemble, changedSlots, merge3, sameSlot as same, slotLabel, slotRows, slotsOf } from './codec/slots.js';
import { safeSegment } from './codec/text.js';
import { isItemEntry } from './vcs/vcs.js';
import { isProjectFolder } from './workspace/workspace.js';

/** Re-merge attempts when the tavern changes again between our merge and the write (rule 6). */
const MAX_MERGE_ATTEMPTS = 2;
/** Undo steps kept per item (in memory, for this run of the companion). */
const UNDO_LIMIT = 30;
/** Editor auto-saves this close together count as one undo step (typing a sentence is one step, not five). */
const UNDO_MERGE_MS = 1500;

/** Name of the lorebook a character is bound to (data.extensions.world), if any. */
function linkedWorldName(card) {
    const name = card?.data?.extensions?.world;
    return typeof name === 'string' && name.trim() ? name : undefined;
}

/** A card with its name set in both places the tavern keeps it (V1 field and data.name). */
function renameCharacter(card, name) {
    return { ...card, name, ...(card.data && typeof card.data === 'object' ? { data: { ...card.data, name } } : {}) };
}

/** A card linking to the lorebook `world` (data.extensions.world). */
function relinkWorld(card, world) {
    const data = card.data && typeof card.data === 'object' ? card.data : {};
    return { ...card, data: { ...data, extensions: { ...(data.extensions ?? {}), world } } };
}
import { diffPaths } from './codec/object-path.js';

/** 预设工坊's saved prompts: a workspace file outside the items, versioned with them. */
export const COLLECTION_FILE = 'workshop/prompts.json';

const ENTRY_TEMPLATE = 'worldinfo-entry';

const MB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const mb = bytes => `${(bytes / MB).toFixed(bytes < 10 * MB ? 2 : 1)} MB`;

export class SyncEngine {
    /**
     * @param {{workspace: import('./workspace/workspace.js').Workspace, targets: import('./targets.js').TargetRegistry, log?: Function}} deps
     */
    constructor({ workspace, targets, log = () => {} }) {
        this.ws = workspace;
        this.targets = targets;
        this.log = log;
        /** @type {Map<string, Promise>} per-item serialization */
        this.locks = new Map();
        /** @type {Map<string, {status: string, error?: string}>} last workspace evaluation per item */
        this.local = new Map();
        /** Called after the version history changed (server: tells Studio to refresh). */
        this.onHistory = () => {};
        this.snapshotTimer = null;
        /**
         * Undo / redo per item path: {undo: files[], redo: files[], after, at, mergeable}. Each step is a snapshot
         * of the item folder taken before a write made through the companion; `after` fingerprints the files that
         * write left, so a change made anywhere else (an editor, a pull) is noticed and never undone blindly.
         * @type {Map<string, {undo: Record<string,string>[], redo: Record<string,string>[], after: string, at: number, mergeable: boolean}>}
         */
        this.edits = new Map();
    }

    /** Runs fn exclusively for one item path. */
    withLock(path, fn) {
        const prev = this.locks.get(path) ?? Promise.resolve();
        const run = prev.then(fn);
        const settled = run.then(() => {}, () => {}); // chain tail never rejects
        this.locks.set(path, settled);
        settled.then(() => { if (this.locks.get(path) === settled) this.locks.delete(path); });
        return run;
    }

    /**
     * Writes the uids encoding gives hand-written lorebook entries into their files (codec/lorebook.js
     * assignEntryUids). Called before data goes to a tavern: from then on the uid is the entry's identity there.
     */
    async #persistEntryUids(item) {
        if (item.kind !== 'lorebook') return;
        const assigned = assignEntryUids(await this.ws.readItemFiles(item.path));
        for (const [rel, text] of Object.entries(assigned)) await this.ws.writeItemFile(item.path, rel, text);
    }

    async encodeItem(item) {
        const data = await this.#encodeFiles(item.kind, await this.ws.readItemFiles(item.path));
        return { data, hash: await hashData(data) };
    }

    /** Item data from an item folder's files (the workspace's, a version's, or a folder being imported). */
    async #encodeFiles(kind, files) {
        const options = kind === 'lorebook' ? { entryTemplate: await this.ws.loadTemplate(ENTRY_TEMPLATE) } : undefined;
        return codecFor(kind).encode(files, options);
    }

    // ---- item editing (Studio editors, docs/studio-design.md §6) -----------------------------------------------

    /**
     * Structured data of a workspace item and its workspace hash; lorebooks also return the new-entry template.
     * Characters come without the parts that are not extracted (`omitted`, see omitParts): the editor only loads what
     * the user took out to edit, and hands `omitted` back when saving so those parts are kept as stored.
     */
    async readItemData(path) {
        const item = this.requireItem(path);
        const { data, hash } = await this.encodeItem(item);
        const out = { path: item.path, kind: item.kind, data, hash };
        if (item.kind === 'lorebook') out.entryTemplate = (await this.decodeOptions(item)).template ?? null;
        if (item.kind === 'character') Object.assign(out, omitParts(data, item.layout?.exclude ?? []));
        return out;
    }

    /**
     * Writes edited data to the workspace files when `hash` still matches them (else `conflict`: changed elsewhere).
     * `omitted` (characters): parts the editor did not load, put back from the workspace.
     */
    async writeItemData(path, { data, hash, omitted } = {}) {
        const item = this.requireItem(path);
        if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ProtocolError(ERR.BAD_REQUEST, 'data must be an object');
        if (omitted !== undefined && (item.kind !== 'character' || !Array.isArray(omitted) || omitted.some(p => !CHARACTER_PARTS.includes(p)))) {
            throw new ProtocolError(ERR.BAD_REQUEST, `omitted must list character parts: ${CHARACTER_PARTS.join(', ')}`);
        }
        return this.withLock(item.path, async () => {
            const current = await this.encodeItem(item);
            if (hash !== current.hash) throw new ProtocolError(ERR.CONFLICT, `${item.path} 在别处被修改了`, { hash: current.hash });
            if (omitted?.length) restoreParts(data, current.data, omitted);
            return { path: item.path, hash: await this.#undoable(item, () => this.writeItem(item, data), { mergeable: true }) };
        });
    }

    /**
     * Lorebook entry operations applied together (single edits, batch edits and group moves are all op lists):
     * {op:'set', uid, patch, unset?} merges fields; {op:'create', entry?} adds an entry from the template with a new
     * uid at the end of the display order; {op:'delete', uid}. `hash` guards against concurrent file edits.
     */
    async editEntries(path, { hash, ops } = {}) {
        const item = this.requireItem(path);
        if (item.kind !== 'lorebook') throw new ProtocolError(ERR.BAD_REQUEST, 'Only lorebooks have entries');
        if (!Array.isArray(ops) || !ops.length) throw new ProtocolError(ERR.BAD_REQUEST, 'ops must be a non-empty array');
        return this.withLock(item.path, async () => {
            const current = await this.encodeItem(item);
            if (hash !== current.hash) throw new ProtocolError(ERR.CONFLICT, `${item.path} 在别处被修改了`, { hash: current.hash });
            const data = structuredClone(current.data);
            const entries = (data.entries ??= {});
            const template = (await this.decodeOptions(item)).template ?? {};
            const created = [];
            const values = () => Object.values(entries).filter(e => e && typeof e === 'object');
            const keyOf = uid => {
                const key = Object.keys(entries).find(k => entries[k]?.uid === uid) ?? (entries[String(uid)] ? String(uid) : null);
                if (key === null) throw new ProtocolError(ERR.NOT_FOUND, `条目 uid ${uid} 不存在`);
                return key;
            };
            for (const op of ops) {
                if (op?.op === 'set') {
                    if (op.patch !== undefined && (op.patch === null || typeof op.patch !== 'object')) throw new ProtocolError(ERR.BAD_REQUEST, 'patch must be an object');
                    const entry = entries[keyOf(op.uid)];
                    Object.assign(entry, structuredClone(op.patch ?? {}), { uid: entry.uid });
                    for (const field of op.unset ?? []) if (field !== 'uid') delete entry[field];
                } else if (op?.op === 'create') {
                    const uid = Math.max(-1, ...values().map(e => (Number.isInteger(e.uid) ? e.uid : -1)), ...Object.keys(entries).filter(k => /^\d+$/.test(k)).map(Number)) + 1;
                    const displayIndex = Math.max(-1, ...values().map(e => (Number.isInteger(e.displayIndex) ? e.displayIndex : -1))) + 1;
                    entries[String(uid)] = { ...structuredClone(template), displayIndex, ...structuredClone(op.entry ?? {}), uid };
                    created.push(uid);
                } else if (op?.op === 'delete') {
                    delete entries[keyOf(op.uid)];
                } else {
                    throw new ProtocolError(ERR.BAD_REQUEST, `Unknown entry op: ${op?.op}`);
                }
            }
            return { path: item.path, hash: await this.#undoable(item, () => this.writeItem(item, data), { mergeable: true }), created };
        });
    }

    // ---- item files (Studio's file view: the files a split item is made of, edited like VS Code would) ---------

    /** Files of an item folder: the codec's (card.json, regex/…, character_book/…) and the user's own. */
    async itemFiles(path) {
        const item = this.requireItem(path);
        const files = await this.ws.readItemFiles(item.path);
        const owns = codecFor(item.kind).owns;
        return {
            path: item.path,
            files: Object.keys(files).sort().map(rel => ({ rel, size: Buffer.byteLength(files[rel], 'utf8'), owned: owns(rel), readOnly: rel === ITEM_META_FILE })),
        };
    }

    /** One file with a hash of its text, which a later write must present. */
    async readItemFile(path, { file } = {}) {
        const item = this.requireItem(path);
        const text = await this.#itemFileText(item, file);
        return { path: item.path, file, text, hash: await hashData(text) };
    }

    /**
     * Replaces an existing file when it still has `hash` (else `conflict`). The item is then re-read exactly as after
     * an external edit (auto-sync included); a file that no longer parses marks the item invalid, as in VS Code.
     */
    async writeItemFile(path, { file, text, hash } = {}) {
        const item = this.requireItem(path);
        if (typeof text !== 'string') throw new ProtocolError(ERR.BAD_REQUEST, 'text must be a string');
        if (file === ITEM_META_FILE) throw new ProtocolError(ERR.BAD_REQUEST, `${ITEM_META_FILE} 由 TavernCellar 维护，不能在这里编辑`);
        const written = await this.withLock(item.path, async () => {
            const current = await this.#itemFileText(item, file);
            if (hash !== await hashData(current)) throw new ProtocolError(ERR.CONFLICT, `${file} 在别处被修改了`, { hash: await hashData(current) });
            await this.#undoable(item, () => this.ws.writeItemFile(item.path, file, text), { mergeable: true });
            return { path: item.path, file, hash: await hashData(text) };
        });
        await this.onFilesChanged(item.path);
        return { ...written, error: this.local.get(item.path)?.error ?? null };
    }

    async #itemFileText(item, file) {
        let text;
        try {
            text = await this.ws.readItemFile(item.path, file);
        } catch (error) {
            throw new ProtocolError(ERR.BAD_REQUEST, error.message);
        }
        if (text === null) throw new ProtocolError(ERR.NOT_FOUND, `${item.path}/${file} 不存在`);
        return text;
    }

    async writeItem(item, data) {
        const codec = codecFor(item.kind);
        await this.ws.writeItemFiles(item.path, codec.decode(data, await this.decodeOptions(item)), codec.owns);
        const { hash } = await this.encodeItem(item);
        return hash;
    }

    // ---- undo / redo (Studio's 撤回 / 取消撤回, docs/versioning.md §6) ----------------------------------------

    /** Fingerprint of an item folder's files (undo steps compare it to notice changes made elsewhere). */
    async #filesPrint(path) {
        return hashData(await this.ws.readItemFiles(path));
    }

    /**
     * Runs a write of an item's files (caller holds the item lock) and records the files before it as one undo step.
     * A change made elsewhere since the last recorded write (external editor, pull, merge) starts the stack over:
     * stepping back across it would silently drop that change. `mergeable` writes (editor auto-saves) within
     * UNDO_MERGE_MS of the previous one join its step.
     */
    async #undoable(item, write, { mergeable = false } = {}) {
        const before = await this.ws.readItemFiles(item.path);
        const beforePrint = await hashData(before);
        const result = await write();
        const afterPrint = await this.#filesPrint(item.path);
        if (afterPrint === beforePrint) return result;
        let stack = this.edits.get(item.path);
        if (!stack || stack.after !== beforePrint) stack = { undo: [], redo: [], after: '', at: 0, mergeable: false };
        const now = Date.now();
        const join = mergeable && stack.mergeable && stack.undo.length && now - stack.at < UNDO_MERGE_MS;
        if (!join) {
            stack.undo.push(before);
            if (stack.undo.length > UNDO_LIMIT) stack.undo.shift();
        }
        stack.redo = [];
        stack.after = afterPrint;
        stack.at = now;
        stack.mergeable = mergeable;
        this.edits.set(item.path, stack);
        return result;
    }

    /** Whether undo / redo can run for an item now (false when its files changed elsewhere since). */
    async undoState(path) {
        const stack = this.edits.get(path);
        if (!stack || (!stack.undo.length && !stack.redo.length)) return { undo: false, redo: false };
        const valid = stack.after === await this.#filesPrint(path).catch(() => '');
        return { undo: valid && stack.undo.length > 0, redo: valid && stack.redo.length > 0 };
    }

    /** 撤回: puts the item's files back as they were before the last write made through the companion. */
    undo(path) { return this.#step(path, 'undo'); }

    /** 取消撤回: redoes the last undone step. */
    redo(path) { return this.#step(path, 'redo'); }

    async #step(path, dir) {
        const item = this.requireItem(path);
        const result = await this.withLock(item.path, async () => {
            const stack = this.edits.get(item.path);
            const from = dir === 'undo' ? stack?.undo : stack?.redo;
            if (!from?.length) throw new ProtocolError(ERR.BAD_REQUEST, dir === 'undo' ? '没有可以撤回的修改' : '没有可以取消的撤回');
            const current = await this.ws.readItemFiles(item.path);
            if (stack.after !== await hashData(current)) {
                this.edits.delete(item.path);
                throw new ProtocolError(ERR.CONFLICT, `${item.path} 之后在别处被修改过（外部编辑或从酒馆取回），不能再撤回那之前的修改`);
            }
            const files = from.pop();
            (dir === 'undo' ? stack.redo : stack.undo).push(current);
            await this.ws.writeItemFiles(item.path, files, codecFor(item.kind).owns);
            stack.after = await this.#filesPrint(item.path);
            stack.at = 0;
            stack.mergeable = false;
            return { path: item.path, undo: stack.undo.length > 0, redo: stack.redo.length > 0 };
        });
        this.log(`${dir === 'undo' ? 'undid' : 'redid'} an edit of ${item.path}`);
        await this.onFilesChanged(item.path);
        return { ...result, hash: (await this.encodeItem(item).catch(() => null))?.hash ?? null };
    }

    /**
     * Lorebooks: the entry template snapshot to lay out against. An item keeps the snapshot taken at its first
     * checkout (so a tavern upgrade that changes defaults cannot shift its files); new items take the tavern's
     * current template.
     */
    async decodeOptions(item) {
        if (item.kind === 'character') return { exclude: item.layout?.exclude ?? [] };
        if (item.kind === 'preset') {
            const id = Object.values(item.bindings ?? {})[0]?.id;
            if (id) return { apiId: parsePresetId(id).apiId };
            // Unbound (made in Cellar): the apiId recorded when it was created.
            const files = await this.ws.readItemFiles(item.path).catch(() => ({}));
            try { return { apiId: JSON.parse(files['cellar-item.json'] ?? 'null')?.apiId ?? undefined }; } catch { return { apiId: undefined }; }
        }
        if (item.kind !== 'lorebook') return undefined;
        const files = await this.ws.readItemFiles(item.path).catch(() => ({}));
        try {
            const meta = JSON.parse(files['cellar-item.json'] ?? 'null');
            if (meta && Object.prototype.hasOwnProperty.call(meta, 'template')) return { template: meta.template };
        } catch { /* unreadable meta: fall through to the tavern template */ }
        return { template: (await this.ws.loadTemplate(ENTRY_TEMPLATE)) ?? null };
    }

    /**
     * Re-lays out items written by an older codec version (e.g. regex still inside card.json). The content is
     * encoded from the old files and decoded into the current layout, so hashes and sync state stay valid.
     * Items whose files cannot be encoded right now (user mid-edit) are left alone and retried next start.
     */
    /**
     * Changes which parts of a character are extracted (`exclude` lists the ones that are not, see CHARACTER_PARTS)
     * and re-lays out its files. Only the layout changes: the content hash must stay the same, otherwise nothing is
     * saved.
     */
    async setLayout(path, { exclude = [] } = {}) {
        const item = this.requireItem(path);
        if (item.kind !== 'character') throw new ProtocolError(ERR.BAD_REQUEST, 'Only characters have a configurable layout');
        const unknown = exclude.filter(p => !CHARACTER_PARTS.includes(p));
        if (unknown.length) throw new ProtocolError(ERR.BAD_REQUEST, `Unknown parts: ${unknown.join(', ')}`);
        return this.withLock(path, async () => {
            const before = await this.encodeItem(item);
            const previous = item.layout;
            item.layout = exclude.length ? { exclude: [...new Set(exclude)] } : undefined;
            if (!item.layout) delete item.layout;
            const hash = await this.writeItem(item, before.data);
            if (hash !== before.hash) {
                item.layout = previous;
                await this.writeItem(item, before.data);
                throw new ProtocolError(ERR.HOST_ERROR, 'Re-layout would change the content; layout not changed');
            }
            await this.ws.saveManifest();
            this.log(`layout of ${path}: ${exclude.length ? `not extracting ${exclude.join(', ')}` : 'everything extracted'}`);
            return { path, layout: item.layout ?? { exclude: [] } };
        });
    }

    async upgradeLayouts() {
        let manifestChanged = false;
        for (const item of this.ws.manifest.items) {
            await this.withLock(item.path, async () => {
                const files = await this.ws.readItemFiles(item.path).catch(() => null);
                const codec = codecFor(item.kind);
                let version = 0;
                try { version = JSON.parse(files?.['cellar-item.json'] ?? '{}').codec ?? 0; } catch { return; }
                if (!files || version >= codec.version) return;
                const previous = item.layout;
                // Characters: part ids of the old codec -> today's (see migrateExclude).
                const exclude = item.kind === 'character' ? migrateExclude(item.layout?.exclude, version) : null;
                let before = null;
                try {
                    before = await this.encodeItem(item);
                    if (exclude) {
                        if (exclude.length) item.layout = { ...item.layout, exclude };
                        else delete item.layout;
                    }
                    const hash = await this.writeItem(item, before.data);
                    if (hash !== before.hash) throw new Error('content changed during re-layout');
                    if (exclude) manifestChanged = true;
                    this.log(`upgraded layout of ${item.path} (codec ${version} -> ${codec.version})`);
                } catch (error) {
                    if (previous) item.layout = previous;
                    if (before && exclude) await this.writeItem(item, before.data).catch(() => {});
                    this.log(`could not upgrade layout of ${item.path}: ${error.message}`);
                }
            });
        }
        if (manifestChanged) await this.ws.saveManifest();
    }

    requireItem(path) {
        const item = this.ws.getItem(path);
        if (!item) throw new ProtocolError(ERR.NOT_FOUND, `No workspace item at ${path}`);
        return item;
    }

    /** Resolves which bound + connected target to use for an item. */
    resolveBinding(item, targetSpec) {
        const targetId = this.#pickTarget(item, targetSpec);
        const conn = this.targets.tryGet(targetId);
        if (!conn) throw new ProtocolError(ERR.NOT_CONNECTED, `Target ${targetId} is not connected`);
        return { targetId, binding: item.bindings[targetId], link: conn.link };
    }

    /** The binding `targetSpec` (id or prefix) names, or else the only available one (live first). */
    #pickTarget(item, targetSpec) {
        const bound = Object.keys(item.bindings ?? {});
        if (targetSpec) {
            const matches = bound.filter(id => id === targetSpec || id.startsWith(targetSpec));
            if (matches.length !== 1) throw new ProtocolError(ERR.BAD_REQUEST, `Item ${item.path} has no unique binding for "${targetSpec}"`);
            return matches[0];
        }
        const connected = bound.filter(id => this.targets.tryGet(id));
        const live = connected.filter(id => this.targets.tryGetLive(id));
        const candidates = live.length === 1 ? live : connected;
        if (candidates.length !== 1) {
            throw new ProtocolError(candidates.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED,
                candidates.length ? `Item ${item.path} is bound to several available taverns; specify a target` : `No bound tavern of ${item.path} is connected or configured for offline access`);
        }
        return candidates[0];
    }

    // ---- connection lifecycle --------------------------------------------

    async onTargetConnected(target, capabilities, link) {
        if (this.ws.rememberTarget(target)) await this.ws.saveManifest();
        if (capabilities?.worldInfoEntryTemplate && typeof capabilities.worldInfoEntryTemplate === 'object') {
            await this.ws.saveTemplate(ENTRY_TEMPLATE, capabilities.worldInfoEntryTemplate);
        }
        await link.request(MSG.WATCH_SET, { items: this.ws.watchList(target.id) });
        // Edits made while this tavern was offline (mode 'wait'): push the auto-sync ones now, without holding up the handshake.
        this.pushPendingAutoSync(target.id).catch(error => this.log(`catch-up sync for ${target.id} failed: ${error.message}`));
    }

    /**
     * Pushes auto-sync items with local changes to one target (or every reachable target) over whatever link may write:
     * a live link, or an offline link in mode 'write'. Conflicts are recorded as usual, never overwritten.
     */
    async pushPendingAutoSync(onlyTargetId) {
        const results = [];
        for (const item of [...this.ws.manifest.items]) {
            for (const [targetId, binding] of Object.entries(item.bindings ?? {})) {
                if (!binding.autoSync || binding.pin || (onlyTargetId && targetId !== onlyTargetId)) continue;
                const conn = this.#writableConn(targetId);
                if (!conn) continue;
                const result = await this.withLock(item.path, async () => {
                    const state = this.ws.getSyncState(item.path, targetId) ?? {};
                    if (state.conflict) return null;
                    const local = await this.encodeItem(item).catch(() => null);
                    if (!local || local.hash === state.base) return null;
                    try {
                        return await this.#syncLocked(item, targetId, binding, conn.link, false);
                    } catch (error) {
                        this.log(`pending sync of ${item.path} -> ${targetId} failed: ${error.message}`);
                        return { path: item.path, target: targetId, result: 'failed', error: error.message };
                    }
                });
                if (result) results.push(result);
            }
        }
        return results;
    }

    /** Called after offline modes change: a tavern switched to 'write' while closed gets its pending auto-sync items now. */
    async flushPending() {
        return this.pushPendingAutoSync();
    }

    /** Live link, or an offline link whose tavern allows writing while closed; null otherwise. */
    #writableConn(targetId) {
        const live = this.targets.tryGetLive(targetId);
        if (live) return live;
        return this.targets.offlineMode(targetId) === 'write' ? this.targets.tryGet(targetId) : null;
    }

    /** Offline writes follow the tavern's offline mode; 'wait' keeps the tavern's files untouched until it starts. */
    #assertCanWrite(targetId) {
        if (this.targets.offlineMode(targetId) === 'wait') {
            throw new ProtocolError(ERR.WAITING_FOR_TAVERN,
                `${targetId} is not running and set to sync after it starts; start the tavern, or switch it to write while closed`);
        }
    }

    async pushWatchList(targetId) {
        const conn = this.targets.tryGetLive(targetId);
        if (conn) await conn.link.request(MSG.WATCH_SET, { items: this.ws.watchList(targetId) });
    }

    // ---- operations --------------------------------------------------------

    async catalog(targetSpec, { kind, query, offset, limit }) {
        const { target, link } = this.targets.resolve(targetSpec);
        const result = await link.request(MSG.CATALOG_LIST, { kind, query, offset, limit });
        const items = result.items.map(entry => {
            const found = this.ws.findBinding(target.id, kind, entry.id);
            return found ? { ...entry, checkedOut: found.item.path } : entry;
        });
        return { target: target.id, total: result.total, items };
    }

    /**
     * Checks out one item into its kind folder or the project folder `folder`. For characters, `withWorld` also
     * checks out the lorebook named in data.extensions.world into the same folder (or reuses it when it is already
     * checked out from the same tavern, so a book shared by several cards exists once). The link itself is not
     * stored: status derives it from the card each time.
     */
    async checkout(targetSpec, { kind, id, exclude, withWorld = false, folder }) {
        const result = await this.checkoutOne(targetSpec, { kind, id, exclude, folder });
        if (kind !== 'character' || !withWorld || !result.worldName) return result;
        const name = result.worldName;
        const existing = this.ws.findBinding(result.target, 'lorebook', name);
        if (existing) return { ...result, world: { name, path: existing.item.path, checkedOut: false } };
        try {
            const book = await this.checkoutOne(result.target, { kind: 'lorebook', id: name, folder });
            return { ...result, world: { name, path: book.path, checkedOut: true }, warnings: [...result.warnings, ...book.warnings] };
        } catch (error) {
            return { ...result, warnings: [...result.warnings, { code: 'world-checkout-failed', name, detail: error.message }] };
        }
    }

    async checkoutOne(targetSpec, { kind, id, exclude, folder }) {
        const { target, link } = this.targets.resolve(targetSpec);
        assertItemRef({ kind, id });
        this.ws.itemFolder(kind, folder);
        const existing = this.ws.findBinding(target.id, kind, id);
        if (existing) throw new ProtocolError(ERR.BAD_REQUEST, `${kind} "${id}" is already checked out at ${existing.item.path}`);
        if (exclude !== undefined && (kind !== 'character' || !Array.isArray(exclude) || exclude.some(p => !CHARACTER_PARTS.includes(p)))) {
            throw new ProtocolError(ERR.BAD_REQUEST, `exclude must list character parts: ${CHARACTER_PARTS.join(', ')}`);
        }
        const remote = await link.request(MSG.ITEM_GET, { kind, id });
        const path = this.ws.allocateItemPath(kind, id, folder);
        const item = { path, kind, bindings: { [target.id]: { id, autoSync: false } }, ...(exclude?.length ? { layout: { exclude } } : {}) };
        return this.withLock(path, async () => {
            this.ws.manifest.items.push(item);
            const written = await this.writeItem(item, remote.data);
            await this.#agree(item, target.id, remote.data, remote.hash);
            await this.ws.saveManifest();
            await this.ws.saveState();
            await this.#deployed(item, target.id);
            await this.#markOrigin(item);
            await this.pushWatchList(target.id);
            const warnings = [];
            if (written !== remote.hash) {
                const paths = diffPaths(remote.data, (await this.encodeItem(item)).data);
                warnings.push({ code: 'round-trip', paths });
                this.log(`round-trip differences in ${path}: ${paths.join(', ') || '(key order only)'}`);
            }
            this.log(`checked out ${kind} "${id}" -> ${path}`);
            const worldName = kind === 'character' ? linkedWorldName(remote.data) : undefined;
            return { path, target: target.id, hash: remote.hash, warnings, frameworks: kind === 'character' ? detectFrameworks(remote.data) : [], ...(worldName ? { worldName } : {}) };
        });
    }

    async sync(path, { target: targetSpec, force = false } = {}) {
        const item = this.requireItem(path);
        const { targetId, binding, link } = this.resolveBinding(item, targetSpec);
        if (binding.pin) {
            throw new ProtocolError(ERR.BAD_REQUEST, `${path} 在这个酒馆固定在版本 ${binding.pin.slice(0, 8)}；要同步最新内容，先改为跟随最新`, { pinned: binding.pin });
        }
        return this.withLock(path, () => this.#syncLocked(item, targetId, binding, link, force));
    }

    async #syncLocked(item, targetId, binding, link, force, attempt = 0) {
        const state = this.ws.getSyncState(item.path, targetId) ?? {};
        await this.#persistEntryUids(item);
        const local = await this.encodeItem(item);
        if (local.hash === state.base && !force) {
            // Nothing to send: workspace and tavern agree on the last written version, so earlier sync warnings go.
            if (state.warnings) { this.ws.setSyncState(item.path, targetId, { warnings: undefined, warnedAt: undefined }); await this.ws.saveState(); }
            return { path: item.path, target: targetId, result: 'up-to-date', hash: local.hash };
        }
        this.#assertCanWrite(targetId);
        // An open conflict is re-evaluated: the user may have resolved the conflicting slots in the files.
        if (state.conflict && !force) return this.#reconcile(item, targetId, binding, link, { push: true, attempt });
        let baseHash = state.base;
        if (force) baseHash = (await link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id })).hash;
        let result;
        try {
            result = await link.request(MSG.ITEM_PUT, { kind: item.kind, id: binding.id, data: local.data, baseHash });
        } catch (error) {
            if (error.code !== ERR.CONFLICT || force) throw error;
            if (attempt >= MAX_MERGE_ATTEMPTS) {
                await this.#markConflict(item, targetId, binding, link, error.details?.currentHash);
                throw error;
            }
            // The tavern changed since the base: merge slot by slot and try again against its current version.
            return this.#reconcile(item, targetId, binding, link, { push: true, attempt: attempt + 1 });
        }
        const warnings = [...(result.warnings ?? [])];
        if (result.hash !== local.hash) {
            // The stored data differs from what we sent (identity fields such as a character's avatar,
            // or host normalization the plugin reported above): adopt what the tavern actually stored.
            await this.writeItem(item, result.data);
            if (warnings.length) warnings.push({ code: 'workspace-updated' });
        }
        await this.#agree(item, targetId, result.data ?? local.data, result.hash);
        // Kept until the next agreement so the sync matrix can show them (e.g. fields the tavern kept).
        if (warnings.length) this.ws.setSyncState(item.path, targetId, { warnings, warnedAt: new Date().toISOString() });
        await this.ws.saveState();
        await this.#deployed(item, targetId);
        this.log(`synced ${item.path} -> ${targetId}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
        return { path: item.path, target: targetId, result: 'synced', hash: result.hash, warnings };
    }

    /**
     * Both sides changed since the base: three-way merge per slot (codec/slots.js).
     * Clean -> the merged data goes to the workspace, the base moves to the tavern's version, and with `push` the
     * merge is written back (re-checked against the tavern's hash, rule 6). Conflicting slots keep the workspace
     * value; all other slots are merged into the workspace, and nothing is written to the tavern until resolved.
     * Without a usable base snapshot (items synced before slot merge existed) the whole item is one conflict.
     */
    async #reconcile(item, targetId, binding, link, { push, attempt = 0 }) {
        const state = this.ws.getSyncState(item.path, targetId) ?? {};
        const remote = await link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id });
        const local = await this.encodeItem(item).catch(() => null);
        if (local && local.hash === remote.hash) {
            await this.#agree(item, targetId, remote.data, remote.hash);
            await this.ws.saveState();
            await this.#deployed(item, targetId);
            return { path: item.path, target: targetId, result: 'up-to-date', hash: remote.hash };
        }
        const base = await this.ws.loadBase(item.path, targetId);
        // The snapshot is the agreed tavern version, or the advanced base saved by a merge that left conflicts.
        const baseUsable = local && base !== undefined && (await hashData(base)) === (state.mergeBase ?? state.base);
        const { data, conflicts, base: nextBase } = baseUsable ? merge3(item.kind, base, local.data, remote.data) : { data: local?.data, conflicts: ['*'] };
        if (baseUsable && (await hashData(data)) !== local.hash) {
            // Tavern edits come into the workspace and join the draft like any other change (docs/versioning.md §2).
            await this.writeItem(item, data);
            await this.#draftChanged();
        }
        if (conflicts.length) {
            if (baseUsable) {
                await this.ws.saveBase(item.path, targetId, nextBase);
                this.ws.setSyncState(item.path, targetId, { mergeBase: await hashData(nextBase) });
            }
            await this.#recordConflict(item, targetId, remote, conflicts);
            const labels = conflicts.map(slot => (slot === '*' ? '整项' : slotLabel(slot, slotsOf(item.kind, local?.data ?? {}).get(slot)))).join('、');
            throw new ProtocolError(ERR.CONFLICT, `${item.path} 与酒馆在这些地方都有修改：${labels}`, { slots: conflicts });
        }
        await this.#agree(item, targetId, remote.data, remote.hash);
        await this.ws.saveState();
        this.log(`merged ${item.path} with ${targetId}`);
        const mergedHash = await hashData(data);
        if (mergedHash === remote.hash) await this.#deployed(item, targetId);
        if (mergedHash === remote.hash || !push) return { path: item.path, target: targetId, result: 'merged', hash: mergedHash, pending: mergedHash !== remote.hash };
        const pushed = await this.#syncLocked(item, targetId, binding, link, false, attempt);
        return { ...pushed, result: 'merged', merged: true };
    }

    /** Records that workspace and tavern agree on `data`: the base hash and the base snapshot used for merging. */
    async #agree(item, targetId, data, hash) {
        this.ws.setSyncState(item.path, targetId, { base: hash, tavern: hash, mergeBase: undefined, conflict: undefined, warnings: undefined, warnedAt: undefined });
        await this.ws.saveBase(item.path, targetId, data);
        await this.ws.clearConflict(item.path, targetId);
    }

    async pull(path, { target: targetSpec, force = false } = {}) {
        const item = this.requireItem(path);
        const { targetId, binding, link } = this.resolveBinding(item, targetSpec);
        return this.withLock(path, async () => {
            if (binding.pin) {
                // Pinned: pulling takes the tavern's edits made after the pinned version into the workspace, and the
                // binding follows the workspace again. An unchanged tavern has nothing to give (the workspace is ahead).
                const remote = await link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id });
                const state = this.ws.getSyncState(item.path, targetId) ?? {};
                if (remote.hash === state.base && !force) return { path: item.path, target: targetId, result: 'up-to-date', hash: remote.hash, pinned: binding.pin };
                await this.#unpin(item, targetId);
            }
            const state = this.ws.getSyncState(item.path, targetId) ?? {};
            const local = await this.encodeItem(item).catch(() => null); // unreadable files count as local changes
            if (!force && local?.hash !== state.base) {
                const result = await this.#reconcile(item, targetId, binding, link, { push: false });
                this.log(`pulled ${item.path} <- ${targetId} (${result.result})`);
                return result.result === 'up-to-date' ? { ...result, result: 'pulled' } : result;
            }
            const remote = await link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id });
            await this.writeItem(item, remote.data);
            await this.#agree(item, targetId, remote.data, remote.hash);
            await this.ws.saveState();
            await this.#deployed(item, targetId);
            this.log(`pulled ${item.path} <- ${targetId}`);
            return { path: item.path, target: targetId, result: 'pulled', hash: remote.hash };
        });
    }

    async setAutoSync(path, { target: targetSpec, enabled }) {
        const item = this.requireItem(path);
        const bound = Object.keys(item.bindings ?? {});
        const targetId = targetSpec ? bound.find(id => id === targetSpec || id.startsWith(targetSpec)) : (bound.length === 1 ? bound[0] : null);
        if (!targetId) throw new ProtocolError(ERR.BAD_REQUEST, `Specify which binding of ${path} to change`);
        item.bindings[targetId].autoSync = Boolean(enabled);
        await this.ws.saveManifest();
        return { path, target: targetId, autoSync: item.bindings[targetId].autoSync };
    }

    /**
     * Removes one binding of an item: the workspace files stay, the tavern is not touched, and the sync state,
     * base snapshot and conflict for that tavern are forgotten. `bind` binds the item again.
     */
    async unbind(path, { target: targetSpec }) {
        const item = this.requireItem(path);
        const bound = Object.keys(item.bindings ?? {});
        const targetId = targetSpec ? bound.find(id => id === targetSpec || id.startsWith(targetSpec)) : (bound.length === 1 ? bound[0] : null);
        if (!targetId) throw new ProtocolError(ERR.BAD_REQUEST, `Specify which binding of ${path} to remove`);
        return this.withLock(path, async () => {
            delete item.bindings[targetId];
            await this.ws.forgetSync(item.path, targetId);
            await this.ws.vcs.dropDeployed(targetId, item.path).catch(() => {});
            await this.ws.saveManifest();
            await this.ws.saveState();
            await this.pushWatchList(targetId).catch(error => this.log(`watch list for ${targetId} not updated: ${error.message}`));
            this.log(`unbound ${item.path} from ${targetId}`);
            return { path: item.path, target: targetId, result: 'unbound' };
        });
    }

    /**
     * Takes an item out of the workspace: all its bindings, sync state, base snapshots and conflicts are forgotten and
     * (unless `keepFiles`) the files the codec wrote are deleted; the user's own files in the folder stay. The
     * taverns are never touched. Earlier versions remain in the version history.
     */
    async remove(path, { keepFiles = false } = {}) {
        const item = this.requireItem(path);
        return this.withLock(path, async () => {
            const targets = Object.keys(item.bindings ?? {});
            for (const targetId of targets) await this.ws.vcs.dropDeployed(targetId, item.path).catch(() => {});
            await this.ws.vcs.dropOrigin(item.path).catch(() => {});
            const kept = await this.ws.removeItem(item.path, codecFor(item.kind).owns, { deleteFiles: !keepFiles });
            this.local.delete(item.path);
            this.edits.delete(item.path);
            for (const targetId of targets) {
                await this.pushWatchList(targetId).catch(error => this.log(`watch list for ${targetId} not updated: ${error.message}`));
            }
            this.log(`removed ${item.path} from the workspace${keepFiles ? ' (files kept)' : ''}`);
            return { path: item.path, result: 'removed', kept: keepFiles ? null : kept };
        });
    }

    /**
     * Moves an item to the project folder `folder` (empty: back to its kind folder), named by the workspace's one
     * naming rule (Workspace.movePath). Everything kept under the item path follows: its files (the user's own
     * included), sync state, base snapshots, an open conflict, version pointers and tags, undo steps. Bindings and
     * so the taverns' watch lists do not change. The old path is kept in `formerPaths`, so the item's history still
     * lists, reads and restores the versions from before.
     */
    async moveItem(path, { folder } = {}) {
        const item = this.requireItem(path);
        return this.withLock(item.path, async () => {
            const from = item.path;
            const to = this.ws.movePath(item, folder);
            if (to === from) return { path: from, from, result: 'unchanged' };
            await this.#moveTo(item, to);
            return { path: to, from, result: 'moved' };
        });
    }

    /** Moves an item folder and everything kept under its path (caller holds the item lock); see moveItem. */
    async #moveTo(item, to) {
        const from = item.path;
        // Version refs first (all or nothing), then the files; a failed file move puts the refs back, so either the
        // whole item moved or nothing did.
        const vcs = await this.versions();
        await vcs.renameItem(from, to);
        try {
            await this.ws.moveItem(item, to);
        } catch (error) {
            await vcs.renameItem(to, from).catch(e => this.log(`version history: ${e.message}`));
            throw error;
        }
        for (const map of [this.edits, this.local]) {
            if (!map.has(from)) continue;
            map.set(to, map.get(from));
            map.delete(from);
        }
        await this.#draftChanged();
        this.log(`moved ${from} -> ${to}`);
    }

    // ---- renaming in the taverns (docs/architecture.md §3 改名) ------------------------------------------------

    /**
     * Renames a bound character or lorebook in every tavern it is bound to (`item.rename`: the tavern's own rename,
     * which also moves a character's chats), so the binding ids, the workspace card's name and — when the folder was
     * named after the item — the folder follow (moved like moveItem, history included). All bindings must be live,
     * support `item.rename` and be in sync (no local or tavern changes, no conflict, not pinned); this is checked for
     * every binding before anything changes.
     * Renaming a lorebook relinks the workspace cards that link to it (#relink). Characters with `withWorld`: the
     * linked lorebook is renamed to the new card name too, when it had the card's old name (else it keeps its name
     * and the link: warning `world-name-differs`); both are checked before either is renamed.
     */
    async renameItem(path, { name, withWorld = false } = {}) {
        const item = this.requireItem(path);
        if (withWorld && item.kind !== 'character') throw new ProtocolError(ERR.BAD_REQUEST, 'withWorld 只用于角色卡');
        const { local } = await this.#renameCheck(item, name);
        const warnings = [];
        let book = null;
        const world = withWorld ? this.#worldOf(item, local.data) : null;
        if (world && !world.item) warnings.push({ code: 'world-not-in-workspace', name: world.name });
        else if (world && world.name !== this.#tavernName(item, local.data)) warnings.push({ code: 'world-name-differs', name: world.name });
        else if (world) {
            await this.#renameCheck(world.item, name);
            book = world.item;
        }
        const result = await this.#renameOne(item, name);
        result.warnings.unshift(...warnings);
        if (!book) return result;
        const bookFrom = book.path;
        try {
            const renamed = await this.#renameOne(book, name);
            result.world = { name, path: renamed.path, from: bookFrom, renamed: true };
            result.warnings.push(...renamed.warnings);
        } catch (error) {
            result.world = { name: world.name, path: book.path, renamed: false };
            result.warnings.push({ code: 'world-rename-failed', name: world.name, detail: error.message });
        }
        return result;
    }

    /** The name an item has in a tavern's UI: a card's own name, else the name its id gives. */
    #tavernName(item, data) {
        return item.kind === 'character' ? (data?.data?.name ?? data?.name ?? this.ws.itemName(item)) : this.ws.itemName(item);
    }

    /**
     * The lorebook a card links to (data.extensions.world) and the workspace item it resolves to for the card's first
     * binding (null when not in the workspace); undefined when the card links none. Status shows the same link.
     */
    #worldOf(card, data) {
        const name = linkedWorldName(data);
        if (!name) return undefined;
        return { name, item: this.ws.findWorld(name, Object.keys(card.bindings ?? {})[0], card.path) };
    }

    /** Refuses a rename that could not be done in every binding; nothing has changed when it throws. */
    async #renameCheck(item, name) {
        if (!RENAME_KINDS.includes(item.kind)) throw new ProtocolError(ERR.BAD_REQUEST, '只能给角色卡和世界书改名');
        assertNewItemName(name);
        const targets = Object.keys(item.bindings ?? {});
        if (!targets.length) throw new ProtocolError(ERR.BAD_REQUEST, `${item.path} 没有绑定酒馆；改名改的是酒馆里的名称，未发布的项在发布时起名`);
        const local = await this.encodeItem(item);
        // Case-insensitive: names are file names, and the taverns refuse a case-only rename the same way.
        if (this.#tavernName(item, local.data).toLowerCase() === name.toLowerCase()) throw new ProtocolError(ERR.BAD_REQUEST, `新名称与现在的名称相同（不区分大小写）：${name}`);
        const newId = item.kind === 'character' ? `${name}.png` : name;
        for (const targetId of targets) {
            const binding = item.bindings[targetId];
            const label = this.#targetLabel(targetId);
            const conn = this.targets.tryGetLive(targetId);
            if (!conn) throw new ProtocolError(ERR.BAD_REQUEST, `${label} 没有在运行：改名需要酒馆在运行（打开酒馆后再试）`);
            if (!(conn.target.rename >= 1)) throw new ProtocolError(ERR.BAD_REQUEST, `${label} 的 Cellar Link 太旧，不支持改名；请更新插件`);
            if (binding.pin) throw new ProtocolError(ERR.BAD_REQUEST, `${item.path} 在 ${label} 固定在某个版本；先改为跟随最新再改名`);
            const state = this.ws.getSyncState(item.path, targetId) ?? {};
            if (state.conflict || local.hash !== state.base) throw new ProtocolError(ERR.BAD_REQUEST, `${item.path} 与 ${label} 还没有同步一致；先同步再改名`);
            const remote = await conn.link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id });
            if (remote.hash !== state.base) throw new ProtocolError(ERR.BAD_REQUEST, `${label} 里的「${binding.id}」有还没取回的修改；先取回再改名`);
            const other = this.ws.findBinding(targetId, item.kind, newId);
            if (other && other.item !== item) throw new ProtocolError(ERR.CONFLICT, `${item.kind} "${newId}" 已绑定在 ${other.item.path}`, { kind: item.kind, id: newId });
            // From the tavern's list (what its own rename checks), not by reading the item: a missing item is a
            // backend error the tavern may show to the user (tt does), and the list gives the existing id's real case.
            const { items } = await conn.link.request(MSG.CATALOG_LIST, { kind: item.kind, query: newId, limit: 500 });
            const existing = items.find(entry => entry.id.toLowerCase() === newId.toLowerCase());
            if (existing) throw new ProtocolError(ERR.CONFLICT, `${label} 里已有同名的${item.kind === 'lorebook' ? '世界书' : '角色卡'}：${name}`, { kind: item.kind, id: existing.id });
        }
        return { local };
    }

    /** Renames one checked item (#renameCheck) in each binding, then moves its folder; lorebooks relink their cards. */
    async #renameOne(item, name) {
        const cards = item.kind === 'lorebook' ? await this.#cardsLinkingTo(item) : [];
        const oldName = this.ws.itemName(item);
        const result = await this.withLock(item.path, () => this.#renameLocked(item, name));
        for (const card of cards) {
            const relinked = await this.#relink(card, oldName, name);
            result.warnings.push(...relinked.warnings);
            (result.relinked ??= []).push(relinked.path);
        }
        return result;
    }

    /**
     * `item.rename` timed out (a throttled or busy tavern page): the tavern may have renamed the item anyway, and a
     * binding left on the old id would fail every later sync. Reads the tavern once more — the old id gone and the
     * new one there means it was renamed, and that read stands in for the response. Anything else: null (it failed).
     */
    async #renamedAnyway(targetId, kind, oldId, name, error) {
        if (error?.code !== ERR.TIMEOUT) return null;
        const conn = this.targets.tryGetLive(targetId);
        if (!conn) return null;
        const newId = kind === 'character' ? `${name}.png` : name;
        const read = id => conn.link.request(MSG.ITEM_GET, { kind, id }).catch(e => (e?.code === ERR.NOT_FOUND ? null : Promise.reject(e)));
        try {
            const [old, renamed] = [await read(oldId), await read(newId)];
            if (old || !renamed) return null;
            this.log(`rename of ${oldId} in ${targetId} timed out, but the tavern has ${newId}: taking it`);
            return { kind, id: newId, data: renamed.data, hash: renamed.hash, warnings: [{ code: 'rename-confirmed-late', target: targetId }] };
        } catch {
            return null;
        }
    }

    async #renameLocked(item, name) {
        const from = item.path;
        const oldName = this.ws.itemName(item);
        const done = [];
        const warnings = [];
        let failure;
        for (const targetId of Object.keys(item.bindings)) {
            const binding = item.bindings[targetId];
            const state = this.ws.getSyncState(item.path, targetId) ?? {};
            let result;
            try {
                const conn = this.targets.tryGetLive(targetId);
                if (!conn) throw new ProtocolError(ERR.NOT_CONNECTED, `${this.#targetLabel(targetId)} 已断开`);
                result = await conn.link.request(MSG.ITEM_RENAME, { kind: item.kind, id: binding.id, name, baseHash: state.base });
            } catch (error) {
                result = await this.#renamedAnyway(targetId, item.kind, binding.id, name, error);
                if (!result) {
                    failure = error;
                    break;
                }
            }
            item.bindings[targetId] = { ...binding, id: result.id };
            const local = await this.encodeItem(item);
            if (result.hash !== local.hash) await this.writeItem(item, result.data);
            await this.#agree(item, targetId, result.data, result.hash);
            await this.ws.saveManifest();
            await this.ws.saveState();
            warnings.push(...(result.warnings ?? []));
            done.push(targetId);
            this.log(`renamed ${item.path} in ${targetId}: ${binding.id} -> ${result.id}`);
        }
        if (done.length) {
            const to = this.ws.renamedPath(item, oldName);
            if (to !== item.path) await this.#moveTo(item, to);
            for (const targetId of done) {
                await this.#deployed(item, targetId);
                await this.pushWatchList(targetId).catch(error => this.log(`watch list for ${targetId} not updated: ${error.message}`));
            }
        }
        if (failure) {
            if (!done.length) throw failure;
            throw new ProtocolError(failure.code ?? ERR.HOST_ERROR,
                `${failure.message}（已在 ${done.map(id => this.#targetLabel(id)).join('、')} 改名为「${name}」，现在在 ${item.path}；这个酒馆里仍是旧名称）`, { path: item.path, renamed: done });
        }
        return { path: item.path, from, result: 'renamed', ids: Object.fromEntries(done.map(id => [id, item.bindings[id].id])), warnings };
    }

    /** Workspace cards whose lorebook link (#worldOf) resolves to `book`. */
    async #cardsLinkingTo(book) {
        const cards = [];
        for (const card of this.ws.manifest.items) {
            if (card.kind !== 'character') continue;
            const data = await this.encodeItem(card).then(r => r.data, () => null);
            if (data && this.#worldOf(card, data)?.item === book) cards.push(card);
        }
        return cards;
    }

    /**
     * A lorebook a card links to was renamed from `oldName` to `name`: the card's link is changed in the workspace,
     * and synced to each tavern where the card was in sync and the tavern is live (the normal sync path, so the
     * tavern card links to the renamed book). Elsewhere the change waits as a local change (`world-link-not-synced`).
     */
    async #relink(card, oldName, name) {
        return this.withLock(card.path, async () => {
            const warnings = [];
            const local = await this.encodeItem(card);
            if (linkedWorldName(local.data) !== oldName) return { path: card.path, warnings };
            const ready = Object.keys(card.bindings ?? {}).filter(targetId => {
                const state = this.ws.getSyncState(card.path, targetId) ?? {};
                return !state.conflict && !card.bindings[targetId].pin && state.base === local.hash && this.targets.tryGetLive(targetId);
            });
            await this.writeItem(card, relinkWorld(local.data, name));
            for (const targetId of Object.keys(card.bindings ?? {})) {
                const label = this.#targetLabel(targetId);
                if (!ready.includes(targetId)) {
                    warnings.push({ code: 'world-link-not-synced', path: card.path, label });
                    continue;
                }
                try {
                    await this.#syncLocked(card, targetId, card.bindings[targetId], this.targets.tryGetLive(targetId).link, false);
                } catch (error) {
                    warnings.push({ code: 'world-link-not-synced', path: card.path, label, detail: error.message });
                }
            }
            this.log(`relinked ${card.path}: lorebook ${oldName} -> ${name}`);
            return { path: card.path, warnings };
        });
    }

    // ---- avatars (docs/architecture.md §3 换头像) -----------------------------------------------------------

    /**
     * Replaces a bound character's avatar in every tavern it is bound to (`item.avatar`). The image lives in the
     * tavern only; the card data stays, so sync state is not required to be in agreement. Every binding must be
     * reachable for writing (live with `capabilities.avatar`, or offline in mode 'write'); checked before anything
     * changes. A returned card hash other than the base (the tavern re-serialized it, or had changes of its own) goes
     * the way of any tavern-side change: onItemChanged for live links, the status' tavern-changes offline.
     * @param {{image: string}} body image: base64 PNG
     */
    async setAvatar(path, { image } = {}) {
        const item = this.requireItem(path);
        if (item.kind !== 'character') throw new ProtocolError(ERR.BAD_REQUEST, '只有角色卡有头像');
        const targets = Object.keys(item.bindings ?? {});
        if (!targets.length) throw new ProtocolError(ERR.BAD_REQUEST, `${item.path} 没有绑定酒馆；头像存在酒馆里，先发布到酒馆再换头像`);
        for (const targetId of targets) {
            assertAvatarRequest({ kind: item.kind, id: item.bindings[targetId].id, image });
            this.#avatarConn(targetId);
        }
        const done = [];
        const changed = [];
        const warnings = [];
        let failure;
        await this.withLock(item.path, async () => {
            for (const targetId of targets) {
                const { id } = item.bindings[targetId];
                try {
                    const result = await this.#avatarConn(targetId).link.request(MSG.ITEM_AVATAR, { kind: item.kind, id, image });
                    warnings.push(...(result.warnings ?? []));
                    if (result.hash !== this.ws.getSyncState(item.path, targetId)?.base) changed.push({ targetId, id, hash: result.hash });
                    done.push(targetId);
                    this.log(`avatar of ${item.path} replaced in ${targetId}`);
                } catch (error) {
                    failure = error;
                    break;
                }
            }
        });
        for (const { targetId, id, hash } of changed) {
            if (this.targets.tryGetLive(targetId)) await this.onItemChanged(targetId, { kind: item.kind, id, hash });
        }
        if (failure) {
            if (!done.length) throw failure;
            throw new ProtocolError(failure.code ?? ERR.HOST_ERROR,
                `${failure.message}（已在 ${done.map(id => this.#targetLabel(id)).join('、')} 换了头像；这个酒馆里仍是旧头像）`, { path: item.path, done });
        }
        return { path: item.path, result: 'avatar-set', ids: Object.fromEntries(targets.map(id => [id, item.bindings[id].id])), avatarAt: Date.now(), warnings };
    }

    /** The link that can change an avatar in this tavern now, else a ProtocolError saying why not. */
    #avatarConn(targetId) {
        const label = this.#targetLabel(targetId);
        const live = this.targets.tryGetLive(targetId);
        if (live) {
            if (!(live.target.avatar >= 1)) throw new ProtocolError(ERR.BAD_REQUEST, `${label} 的 Cellar Link 太旧，不支持换头像；请更新插件`);
            return live;
        }
        if (!this.targets.tryGet(targetId)) throw new ProtocolError(ERR.BAD_REQUEST, `${label} 没有连接，也没有设置离线访问：打开酒馆后再换头像`);
        const conn = this.#writableConn(targetId);
        if (!conn) throw new ProtocolError(ERR.BAD_REQUEST, `${label} 没有在运行，并且设为等酒馆启动再同步：打开酒馆后再换头像，或在设置里改为不开酒馆也同步`);
        return conn;
    }

    /**
     * Copies Cellar-format item folders from anywhere on disk into the workspace as unbound items: `source` is one
     * item folder (with cellar-item.json) or a folder of them. Each goes to `<folder>/<name>` (folder: default the
     * source folder's name; names by the workspace naming rule). A folder whose files do not read as its kind is
     * reported in `items[].error` and not taken in.
     */
    async importItems({ source, folder } = {}) {
        if (typeof source !== 'string' || !source.trim()) throw new ProtocolError(ERR.BAD_REQUEST, 'source 应为要导入的文件夹路径');
        const found = await this.ws.itemFoldersAt(source.trim());
        if (!found.length) throw new ProtocolError(ERR.BAD_REQUEST, `${source} 里没有 Cellar 格式的资料项（含 cellar-item.json 的文件夹）`);
        const into = folder || safeSegment(source.trim().split(/[\\/]/).filter(Boolean).pop() ?? '');
        const items = [];
        for (const entry of found) {
            try {
                if (entry.error) throw new Error(entry.error);
                try {
                    await this.#encodeFiles(entry.kind, entry.files);
                } catch (error) {
                    throw new Error(`文件无法读取：${error.message}`);
                }
                const path = this.ws.importPath(entry.kind, entry.name, into);
                await this.withLock(path, async () => {
                    await this.ws.copyIntoWorkspace(entry.dir, path);
                    const item = { path, kind: entry.kind, bindings: {} };
                    this.ws.manifest.items.push(item);
                    await this.ws.saveManifest();
                    await this.#markOrigin(item);
                });
                items.push({ source: entry.dir, path, kind: entry.kind });
                this.log(`imported ${entry.dir} -> ${path}`);
            } catch (error) {
                items.push({ source: entry.dir, error: error.message });
            }
        }
        this.onHistory();
        return { folder: into, items };
    }

    /**
     * Binds an existing workspace item to an item in a tavern (the way back from `unbind`, or adopting a tavern item
     * for a folder made elsewhere). Nothing is written on either side: identical data is recorded as in sync;
     * otherwise there is no common base, so a whole-item conflict is recorded and the user picks a side.
     */
    async bind(path, { target: targetSpec, id }) {
        const item = this.requireItem(path);
        if (typeof id !== 'string' || !id) throw new ProtocolError(ERR.BAD_REQUEST, 'id is required (avatar file name or lorebook name)');
        const { target, link } = this.targets.resolve(targetSpec);
        if (item.bindings?.[target.id]) throw new ProtocolError(ERR.BAD_REQUEST, path + ' is already bound to this tavern');
        const other = this.ws.findBinding(target.id, item.kind, id);
        if (other) throw new ProtocolError(ERR.BAD_REQUEST, item.kind + ' "' + id + '" is already bound at ' + other.item.path);
        return this.withLock(path, async () => {
            const remote = await link.request(MSG.ITEM_GET, { kind: item.kind, id });
            item.bindings = { ...(item.bindings ?? {}), [target.id]: { id, autoSync: false } };
            await this.ws.saveManifest();
            await this.pushWatchList(target.id).catch(error => this.log('watch list for ' + target.id + ' not updated: ' + error.message));
            const local = await this.encodeItem(item).catch(() => null);
            if (local && local.hash === remote.hash) {
                await this.#agree(item, target.id, remote.data, remote.hash);
                await this.ws.saveState();
                await this.#deployed(item, target.id);
                this.log('bound ' + item.path + ' to ' + target.id + ' (' + id + '), in sync');
                return { path: item.path, target: target.id, result: 'in-sync', hash: remote.hash };
            }
            await this.#recordConflict(item, target.id, remote);
            this.log('bound ' + item.path + ' to ' + target.id + ' (' + id + '), differs: whole-item conflict');
            return { path: item.path, target: target.id, result: 'conflict' };
        });
    }

    // ---- items made in Cellar (docs/studio-design.md §4.10) -------------------------------------------------

    /** Reads one item from a tavern without touching the workspace (预设工坊 picks presets straight from a tavern). */
    async readTavernItem(targetSpec, { kind, id } = {}) {
        assertItemRef({ kind, id });
        const { target, link } = this.targets.resolve(targetSpec);
        const remote = await link.request(MSG.ITEM_GET, { kind, id });
        const found = this.ws.findBinding(target.id, kind, id);
        return { target: target.id, kind, id, data: remote.data, hash: remote.hash, checkedOut: found?.item.path ?? null };
    }

    /**
     * Creates a workspace item that no tavern has yet (unbound); `publish` creates it in a tavern later. Regex: the
     * workspace holds one global regex list, so this only creates it when there is none.
     * Characters: `world` names the lorebook the card links to (`extensions.world`); the workspace lorebook of that
     * name is created too unless there is one (like `checkout` with `withWorld`). `folder`: the project folder the
     * new items go into (empty: their kind folders).
     */
    async createItem({ kind, name, world, folder } = {}) {
        if (!CODECS[kind]) throw new ProtocolError(ERR.BAD_REQUEST, `Unknown kind: ${kind}`);
        this.ws.itemFolder(kind, folder);
        if (kind === 'regex') {
            const existing = this.ws.manifest.items.find(item => item.kind === 'regex');
            if (existing) throw new ProtocolError(ERR.BAD_REQUEST, `工作区已有全局正则：${existing.path}`, { path: existing.path });
        } else {
            assertNewItemName(name);
        }
        if (world !== undefined && world !== null && world !== '') {
            if (kind !== 'character') throw new ProtocolError(ERR.BAD_REQUEST, 'world is only for characters');
            assertNewItemName(world);
        } else {
            world = undefined;
        }
        const created = await this.#createOne(kind, name, world, folder);
        if (!world) return created;
        const existing = this.ws.findWorld(world, null, created.path);
        if (existing) return { ...created, world: { name: world, path: existing.path, created: false } };
        const book = await this.#createOne('lorebook', world, undefined, folder);
        return { ...created, world: { name: world, path: book.path, created: true } };
    }

    async #createOne(kind, name, world, folder) {
        const { id, data } = newItem(kind, name, { world });
        const path = this.ws.allocateItemPath(kind, id, folder);
        const item = { path, kind, bindings: {} };
        return this.withLock(path, async () => {
            this.ws.manifest.items.push(item);
            const codec = codecFor(kind);
            const options = kind === 'preset' ? { apiId: parsePresetId(id).apiId } : await this.decodeOptions(item);
            await this.ws.writeItemFiles(path, codec.decode(data, options), codec.owns);
            await this.ws.saveManifest();
            await this.#markOrigin(item);
            this.onHistory();
            this.log(`created ${kind} ${path}`);
            return { path, kind, id };
        });
    }

    /**
     * Creates a workspace item in a tavern where it does not exist yet and binds it there, in sync. `name` is the
     * character / lorebook / preset name in the tavern; characters get their avatar file name from the tavern.
     * A name the tavern already has is refused (`conflict`, details `{ kind, id }` of the existing item): the way
     * to use that item is `bind`, which compares both sides and lets the user pick.
     * Characters with `withWorld`: the unbound workspace lorebook the card links to is published under the linked
     * name too; that step's failure is reported as a warning (`world-publish-failed`, with the same details).
     */
    async publish(path, { target: targetSpec, name, withWorld = false } = {}) {
        const result = await this.#publishOne(path, { target: targetSpec, name });
        const item = this.requireItem(path);
        const worldName = item.kind === 'character' && withWorld ? linkedWorldName(result.data) : undefined;
        const { data: _data, ...out } = result;
        if (!worldName) return out;
        const book = this.ws.findWorld(worldName, result.target, path);
        if (!book) return { ...out, warnings: [...out.warnings, { code: 'world-not-in-workspace', name: worldName }] };
        if (book.bindings?.[result.target]) return { ...out, world: { name: worldName, path: book.path, published: false } };
        try {
            const pub = await this.#publishOne(book.path, { target: result.target, name: worldName });
            return { ...out, world: { name: worldName, path: book.path, published: true }, warnings: [...out.warnings, ...pub.warnings] };
        } catch (error) {
            const warning = { code: 'world-publish-failed', name: worldName, path: book.path, detail: error.message };
            if (error.code === ERR.CONFLICT && error.details?.id) warning.existing = error.details.id;
            return { ...out, world: { name: worldName, path: book.path, published: false }, warnings: [...out.warnings, warning] };
        }
    }

    async #publishOne(path, { target: targetSpec, name } = {}) {
        const item = this.requireItem(path);
        if (item.kind === 'regex') throw new ProtocolError(ERR.BAD_REQUEST, '全局正则在每个酒馆都已存在，请用「绑定」');
        assertNewItemName(name);
        const { target, link } = this.targets.resolve(targetSpec);
        if (item.bindings?.[target.id]) throw new ProtocolError(ERR.BAD_REQUEST, `${path} 已绑定到这个酒馆`);
        if (!target.offline && !(target.create >= 1)) {
            throw new ProtocolError(ERR.BAD_REQUEST, `${target.label ?? target.id} 的 Cellar Link 太旧，不支持新建；请更新插件`);
        }
        this.#assertCanWrite(target.id);
        return this.withLock(path, async () => {
            await this.#persistEntryUids(item);
            const local = await this.encodeItem(item);
            const data = item.kind === 'character' ? renameCharacter(local.data, name) : local.data;
            const id = item.kind === 'preset' ? `${(await this.decodeOptions(item)).apiId ?? 'openai'}/${name}` : item.kind === 'character' ? undefined : name;
            const result = await link.request(MSG.ITEM_CREATE, { kind: item.kind, name, ...(id ? { id } : {}), data });
            const other = this.ws.findBinding(target.id, item.kind, result.id);
            if (other) throw new ProtocolError(ERR.CONFLICT, `${item.kind} "${result.id}" 已绑定在 ${other.item.path}`);
            item.bindings = { ...(item.bindings ?? {}), [target.id]: { id: result.id, autoSync: false } };
            if (result.hash !== local.hash) await this.writeItem(item, result.data);
            await this.#agree(item, target.id, result.data, result.hash);
            await this.ws.saveManifest();
            await this.ws.saveState();
            await this.#deployed(item, target.id);
            await this.pushWatchList(target.id).catch(error => this.log(`watch list for ${target.id} not updated: ${error.message}`));
            this.log(`published ${path} -> ${target.id} (${result.id})`);
            return { path, target: target.id, id: result.id, hash: result.hash, data: result.data, warnings: result.warnings ?? [] };
        });
    }

    // ---- events ----------------------------------------------------------

    /** Tavern reported a change of a watched item. */
    async onItemChanged(targetId, { kind, id, hash }) {
        const found = this.ws.findBinding(targetId, kind, id);
        if (!found) return;
        const { item, binding } = found;
        await this.withLock(item.path, async () => {
            const state = this.ws.getSyncState(item.path, targetId) ?? {};
            if (hash === state.base) return; // echo of our own write
            const conn = this.targets.tryGetLive(targetId);
            if (!conn) return;
            const local = await this.encodeItem(item).catch(() => null);
            const remote = await conn.link.request(MSG.ITEM_GET, { kind, id: binding.id });
            if (remote.hash === state.base) return;
            if (binding.pin) {
                // Pinned: the workspace is not this tavern's source right now. Only note the change; the user pulls
                // it in or pushes the pinned version again (docs/versioning.md §3).
                this.ws.setSyncState(item.path, targetId, { tavern: remote.hash });
                await this.ws.saveState();
                this.log(`tavern change on pinned ${item.path} <- ${targetId}: kept in the tavern, not pulled`);
                return;
            }
            if (local && local.hash === state.base) {
                await this.writeItem(item, remote.data);
                await this.#agree(item, targetId, remote.data, remote.hash);
                await this.ws.saveState();
                await this.#deployed(item, targetId);
                this.log(`tavern change pulled: ${item.path} <- ${targetId}`);
            } else {
                // Both sides changed: merge; auto-sync items push the merge back right away.
                const push = binding.autoSync && Boolean(this.#writableConn(targetId));
                await this.#reconcile(item, targetId, binding, conn.link, { push })
                    .catch(error => this.log(`tavern change on ${item.path}: ${error.message}`));
            }
        });
    }

    /** Workspace files of an item changed on disk (debounced by the watcher). */
    async onFilesChanged(path) {
        const item = this.ws.getItem(path);
        if (!item) return;
        await this.withLock(path, async () => {
            let local;
            try {
                local = await this.encodeItem(item);
                this.local.set(path, { status: 'ok' });
            } catch (error) {
                this.local.set(path, { status: 'invalid', error: error.message });
                this.log(`cannot read ${path}: ${error.message}`);
                return;
            }
            for (const [targetId, binding] of Object.entries(item.bindings ?? {})) {
                const state = this.ws.getSyncState(path, targetId) ?? {};
                if (!binding.autoSync || binding.pin || local.hash === state.base || state.conflict) continue;
                // Live link, or the tavern's files when it is closed and set to write offline; 'wait' pushes on connect.
                const conn = this.#writableConn(targetId);
                if (!conn) continue;
                try {
                    await this.#syncLocked(item, targetId, binding, conn.link, false);
                } catch (error) {
                    this.log(`auto sync of ${path} -> ${targetId} failed: ${error.message}`);
                }
            }
        });
    }

    async #markConflict(item, targetId, binding, link, currentHash) {
        const remote = await link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id }).catch(() => null);
        if (remote) await this.#recordConflict(item, targetId, remote);
        else {
            this.ws.setSyncState(item.path, targetId, { tavern: currentHash, conflict: { at: new Date().toISOString() } });
            await this.ws.saveState();
        }
    }

    async #recordConflict(item, targetId, remote, slots = ['*']) {
        const file = await this.ws.saveConflict(item.path, targetId, { kind: item.kind, hash: remote.hash, data: remote.data, slots });
        this.ws.setSyncState(item.path, targetId, { tavern: remote.hash, conflict: { at: new Date().toISOString(), file, slots } });
        await this.ws.saveState();
        this.log(`CONFLICT ${item.path} <-> ${targetId} (${slots.join(', ')}); tavern version saved to ${file}`);
    }

    /** Conflicting slots of one binding with both sides' values (and the base value when known), for the conflict view. */
    async conflictDetails(path, { target: targetSpec } = {}) {
        const item = this.requireItem(path);
        const bound = Object.keys(item.bindings ?? {});
        const targetId = targetSpec ? bound.find(id => id === targetSpec || id.startsWith(targetSpec)) : bound.find(id => this.ws.getSyncState(path, id)?.conflict);
        const conflict = targetId && this.ws.getSyncState(path, targetId)?.conflict;
        if (!conflict) return { path, target: targetId ?? null, slots: [] };
        const [local, saved, base] = await Promise.all([
            this.encodeItem(item).then(r => r.data, () => null),
            this.ws.loadConflict(path, targetId),
            this.ws.loadBase(path, targetId),
        ]);
        const l = slotsOf(item.kind, local ?? {}), t = slotsOf(item.kind, saved?.data ?? {});
        const wanted = conflict.slots ?? ['*'];
        const slots = wanted.includes('*')
            ? [{ slot: '*', label: '整项', workspace: { value: null, present: local != null }, tavern: { value: null, present: Boolean(saved) }, base: { value: null, present: false },
                // No base to merge against: show what differs between the two sides, slot by slot, to choose from.
                differences: slotRows({ workspace: l, tavern: t, base: new Map() }, changedSlots(l, t)) }]
            : slotRows({ workspace: l, tavern: t, base: base ? slotsOf(item.kind, base) : null }, wanted);
        return { path, kind: item.kind, target: targetId, at: conflict.at, slots };
    }

    /**
     * What syncing or pulling one binding would carry (the 「查看差异」 view of 本地有修改 / 酒馆有修改): the slots
     * where the workspace or the tavern's current version differs from the last synced version (the base), as
     * conflict-view rows with `changed` naming the sides that moved. Without a usable base snapshot the rows compare
     * the two sides directly (`changed` lists both); an unreachable tavern counts as unknown.
     */
    async changeDetails(path, { target: targetSpec } = {}) {
        const item = this.requireItem(path);
        const targetId = this.#pickTarget(item, targetSpec);
        const state = this.ws.getSyncState(path, targetId) ?? {};
        const link = this.targets.tryGet(targetId)?.link;
        const [local, remote, base] = await Promise.all([
            this.encodeItem(item),
            link ? link.request(MSG.ITEM_GET, { kind: item.kind, id: item.bindings[targetId].id }) : null,
            this.ws.loadBase(path, targetId),
        ]);
        const baseUsable = base !== undefined && (await hashData(base)) === (state.mergeBase ?? state.base);
        const sides = {
            workspace: slotsOf(item.kind, local.data),
            tavern: remote ? slotsOf(item.kind, remote.data) : null,
            base: baseUsable ? slotsOf(item.kind, base) : null,
        };
        const known = Object.values(sides).filter(Boolean);
        const slots = slotRows(sides, changedSlots(...known)).map(row => ({
            ...row,
            changed: ['workspace', 'tavern'].filter(s => sides[s] && (!sides.base || !same(sides[s].get(row.slot), sides.base.get(row.slot)))),
        }));
        return { path, kind: item.kind, target: targetId, slots };
    }

    /**
     * Applies the user's choice for every conflicting slot: 'workspace', 'tavern', or {value} (merged by hand;
     * {delete: true} removes the slot). The tavern version the user reviewed (saved with the conflict) becomes the
     * base, then a normal sync runs: unchanged tavern -> written back; changed again -> merged against it, so
     * newer tavern edits are neither lost nor overwritten. Without a writable link the result stays local.
     */
    async resolveConflict(path, { target: targetSpec, choices } = {}) {
        const item = this.requireItem(path);
        const { targetId, binding, link } = this.resolveBinding(item, targetSpec);
        if (!choices || typeof choices !== 'object') throw new ProtocolError(ERR.BAD_REQUEST, 'choices is required');
        return this.withLock(path, async () => {
            const state = this.ws.getSyncState(path, targetId) ?? {};
            const saved = state.conflict && await this.ws.loadConflict(path, targetId);
            if (!saved) throw new ProtocolError(ERR.BAD_REQUEST, `${path} has no recorded conflict with ${targetId}`);
            const wanted = state.conflict.slots ?? ['*'];
            const missing = wanted.filter(slot => !(slot in choices));
            if (missing.length) throw new ProtocolError(ERR.BAD_REQUEST, `No choice for: ${missing.join(', ')}`, { slots: missing });
            const local = await this.encodeItem(item).catch(() => null);
            let data;
            if (wanted.includes('*')) {
                const c = choices['*'];
                if (c === 'tavern') data = saved.data;
                else if (c === 'workspace' && local) data = local.data;
                else throw new ProtocolError(ERR.BAD_REQUEST, 'The whole-item conflict takes "workspace" or "tavern"');
            } else {
                if (!local) throw new ProtocolError(ERR.BAD_REQUEST, `${path} cannot be read; fix its files first`);
                const merged = slotsOf(item.kind, local.data);
                const tavern = slotsOf(item.kind, saved.data);
                for (const slot of wanted) {
                    const c = choices[slot];
                    let value;
                    if (c === 'workspace') continue;
                    else if (c === 'tavern') value = tavern.get(slot);
                    else if (c && typeof c === 'object' && c.delete === true) value = undefined;
                    else if (c && typeof c === 'object' && 'value' in c) value = c.value;
                    else throw new ProtocolError(ERR.BAD_REQUEST, `Bad choice for ${slot}`);
                    if (value === undefined) merged.delete(slot);
                    else merged.set(slot, value);
                }
                data = assemble(item.kind, merged);
            }
            await this.writeItem(item, data);
            await this.#agree(item, targetId, saved.data, saved.hash);
            await this.ws.saveState();
            this.log(`resolved conflict of ${path} with ${targetId} (${wanted.length} slot(s))`);
            if (!this.#writableConn(targetId)) return { path, target: targetId, result: 'resolved', pending: true };
            const synced = await this.#syncLocked(item, targetId, binding, link, false);
            return { ...synced, resolved: true };
        });
    }

    // ---- version history (docs/versioning.md) -------------------------------------------------------------

    /** The workspace history, initialized on first use (an existing workspace gets its first version then). */
    async versions() {
        const vcs = this.ws.vcs;
        await vcs.ready();
        if (vcs.takeCreated()) {
            // First version of a workspace that already had bindings: in-sync ones are deployed at it.
            const head = await vcs.resolve('HEAD');
            for (const item of this.ws.manifest.items) {
                const local = await this.encodeItem(item).catch(() => null);
                for (const targetId of Object.keys(item.bindings ?? {})) {
                    const state = this.ws.getSyncState(item.path, targetId);
                    if (local && state?.base === local.hash && !state.conflict) await vcs.setDeployed(targetId, item.path, head);
                }
            }
        }
        return vcs;
    }

    #targetLabel(targetId) {
        return this.ws.manifest.targets?.[targetId]?.label ?? targetId.slice(0, 8);
    }

    /**
     * Workspace and tavern now hold the same data: snapshot it into the draft and point the deployed ref there.
     * Checkouts, pulls and merges are ordinary draft changes: only the user ends a draft (记录版本 / 打标签), as in
     * jj. History problems are logged, never fail the sync.
     */
    async #deployed(item, targetId) {
        try {
            const vcs = await this.versions();
            const oid = (await vcs.snapshot()) ?? await vcs.resolve('HEAD');
            await vcs.setDeployed(targetId, item.path, oid);
            this.onHistory();
        } catch (error) {
            this.log(`version history: ${error.message}`);
        }
    }

    /** Tavern edits merged into the workspace (not yet agreed with the tavern as a whole): into the draft. */
    async #draftChanged() {
        try {
            await (await this.versions()).snapshot();
            this.onHistory();
        } catch (error) {
            this.log(`version history: ${error.message}`);
        }
    }

    /** Debounced draft snapshot after file changes (watcher). */
    scheduleSnapshot(delayMs = 1500) {
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = setTimeout(() => {
            this.snapshotTimer = null;
            this.versions().then(vcs => vcs.snapshot()).then(() => this.onHistory(), error => this.log(`version history: ${error.message}`));
        }, delayMs);
        this.snapshotTimer.unref?.();
    }

    stopSnapshots() {
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = null;
    }

    /**
     * Draft, versions (optionally only those touching `path`) and where each binding is deployed. Item paths are
     * given as they are now: a moved item's versions from before the move are listed under its current path.
     */
    async history({ path, limit = 100 } = {}) {
        const vcs = await this.versions();
        await vcs.snapshot();
        const deployed = [];
        for (const item of this.ws.manifest.items) {
            if (path && item.path !== path) continue;
            for (const [targetId, binding] of Object.entries(item.bindings ?? {})) {
                const rev = await vcs.getDeployed(targetId, item.path);
                if (rev) deployed.push({ path: item.path, target: targetId, label: this.#targetLabel(targetId), rev, ...(binding.pin ? { pinned: true } : {}) });
            }
        }
        const versions = (await vcs.log({ paths: path ? this.#historyPaths(path) : undefined, limit: Math.min(Math.max(Number(limit) || 100, 1), 500) }))
            .map(v => ({ ...v, items: this.#asCurrent(v.items), tags: this.#tagsAsCurrent(v.tags) }));
        // A deployed draft that was amended afterwards is not in the list: show it on the version it became
        // (same parent), marked as an earlier state unless only the description changed.
        const ids = new Set(versions.map(v => v.id));
        for (const d of deployed) {
            if (ids.has(d.rev)) continue;
            const parent = await vcs.parentOf(d.rev).catch(() => undefined);
            const later = versions.find(v => (v.parents[0] ?? null) === parent);
            if (later) {
                d.shownAt = later.id;
                // Only the description changed since: same content, so the tavern has exactly this version.
                if (!(await vcs.sameContent(d.rev, later.id).catch(() => false))) d.earlier = true;
            }
        }
        return { draft: await this.#draftInfo(vcs), versions, deployed };
    }

    // One rule for items in the history: an item is every path it has had (Workspace.itemPaths, current first), and
    // history output names each item by its current path.

    /** The paths of the item at `path` (a removed item: just `path`). */
    #historyPaths(path) {
        const item = this.ws.getItem(path);
        return item ? this.ws.itemPaths(item) : [path];
    }

    /** Version entries -> current item paths (an entry from before a move names the item where it is now). */
    #asCurrent(paths) {
        return [...new Set(paths.map(p => this.ws.currentPath(p)))];
    }

    #tagsAsCurrent(tags) {
        return tags.map(t => ({ ...t, path: this.ws.currentPath(t.path) }));
    }

    async #tagsAt(vcs, oid) {
        return this.#tagsAsCurrent(await vcs.tagsAt(oid));
    }

    async #draftInfo(vcs) {
        const info = await vcs.draftInfo();
        return { ...info, items: this.#asCurrent(info.items) };
    }

    /** Files of an item in a version, at whichever of its `paths` the version has it; null when absent there. */
    async #filesAt(vcs, rev, paths) {
        for (const path of paths) {
            const files = await vcs.readItemAt(rev, path);
            if (files) return files;
        }
        return null;
    }

    /** Kind of an item folder in a version, from its cellar-item.json (items no longer in the workspace). */
    async #kindAt(vcs, rev, paths) {
        const files = await this.#filesAt(vcs, rev, paths);
        try {
            const kind = JSON.parse(files?.[ITEM_META_FILE] ?? 'null')?.kind;
            return CODECS[kind] ? kind : null;
        } catch {
            return null;
        }
    }

    /** Description of the draft (no `rev`) or of a recorded version (a note: the version keeps its id). */
    async describeDraft({ message, rev } = {}) {
        const vcs = await this.versions();
        let oid;
        try {
            oid = rev ? await vcs.describeVersion(String(rev), String(message ?? '')) : await vcs.describe(String(message ?? ''));
        } catch (error) {
            throw new ProtocolError(ERR.BAD_REQUEST, error.message);
        }
        this.onHistory();
        return { id: oid };
    }

    /** "记录版本" (存档): the chosen items (default: all in the draft) become a version; the rest stays in the draft. */
    async recordVersion({ message, paths } = {}) {
        if (paths !== undefined && (!Array.isArray(paths) || !paths.every(p => typeof p === 'string'))) throw new ProtocolError(ERR.BAD_REQUEST, 'paths 应为项路径列表');
        let oid;
        try {
            oid = await (await this.versions()).commit(String(message ?? ''), paths?.length ? paths.flatMap(p => this.#historyPaths(p)) : undefined);
        } catch (error) {
            throw new ProtocolError(ERR.BAD_REQUEST, error.message);
        }
        if (!oid) throw new ProtocolError(ERR.BAD_REQUEST, '没有新的修改可以记录');
        this.log(`recorded version ${oid.slice(0, 8)}${paths?.length ? ` (${paths.join(', ')})` : ''}`);
        this.onHistory();
        return { id: oid };
    }

    /** Tags one item at a version; on the draft that item is recorded first with `message`. */
    async tagVersion({ name, path, rev, message } = {}) {
        if (typeof name !== 'string' || !/^[^\s~^:?*[\\]+$/.test(name) || name.includes('..') || name.startsWith('/') || name.endsWith('/')) throw new ProtocolError(ERR.BAD_REQUEST, '标签名不能含空格和 ~^:?*[\\ 符号');
        if (typeof path !== 'string' || !path.includes('/')) throw new ProtocolError(ERR.BAD_REQUEST, '标签属于一项：请选择要打标签的项');
        const vcs = await this.versions();
        let oid;
        try {
            oid = await vcs.tag(name, this.#historyPaths(path), rev, message === undefined ? undefined : String(message));
        } catch (error) {
            throw new ProtocolError(ERR.BAD_REQUEST, error.message);
        }
        this.onHistory();
        return { name, path, id: oid };
    }

    async untagVersion({ name, path } = {}) {
        if (typeof name !== 'string' || typeof path !== 'string') throw new ProtocolError(ERR.BAD_REQUEST, '需要标签名与项路径');
        if (!(await (await this.versions()).untag(name, path))) throw new ProtocolError(ERR.NOT_FOUND, `${path} 没有标签 ${name}`);
        this.onHistory();
        return { name, path };
    }

    /** Item data of a version (null when the item is absent there or cannot be read); `paths`: see #historyPaths. */
    async #dataAt(vcs, rev, paths, kind) {
        const files = await this.#filesAt(vcs, rev, paths);
        if (!files) return { present: false, data: null };
        try {
            return { present: true, data: await this.#encodeFiles(kind, files) };
        } catch (error) {
            return { present: true, data: null, error: error.message };
        }
    }

    /**
     * Field-level differences between two versions (`to` defaults to the newest), per item, with the same slots and
     * labels as the conflict view. `path` limits it to one item.
     */
    async diffVersions({ from, to = 'HEAD', path } = {}) {
        const vcs = await this.versions();
        let fromId = null;
        let toId;
        try {
            fromId = from ? await vcs.resolve(from) : null;
            toId = await vcs.resolve(to);
        } catch (error) {
            throw new ProtocolError(ERR.NOT_FOUND, error.message);
        }
        const paths = path ? [path] : this.#asCurrent((await vcs.changedItems(fromId, toId)).filter(isItemEntry));
        const items = [];
        for (const p of paths) {
            const at = this.#historyPaths(p);
            const kind = this.ws.getItem(p)?.kind ?? await this.#kindAt(vcs, toId, at) ?? (fromId ? await this.#kindAt(vcs, fromId, at) : null);
            if (!kind) continue; // not an item folder (e.g. workshop/prompts.json)
            const [a, b] = await Promise.all([fromId ? this.#dataAt(vcs, fromId, at, kind) : { present: false, data: null }, this.#dataAt(vcs, toId, at, kind)]);
            const status = !a.present && b.present ? 'added' : a.present && !b.present ? 'removed' : 'changed';
            if (a.error || b.error) { items.push({ path: p, kind, status: 'unreadable', error: a.error ?? b.error, slots: [] }); continue; }
            const sa = slotsOf(kind, a.data ?? {}), sb = slotsOf(kind, b.data ?? {});
            // eolOnly: e.g. the tavern's editor saved CRLF, a real change with nothing visible in a text diff
            const slots = slotRows({ to: sb, from: sa }, changedSlots(sa, sb));
            if (slots.length || status !== 'changed') items.push({ path: p, kind, status, slots });
        }
        return { from: fromId, to: toId, items };
    }

    /** One item's data as it was in a version (预设工坊 compares it with the workspace). */
    async itemAtVersion({ rev, path } = {}) {
        if (typeof path !== 'string' || !path) throw new ProtocolError(ERR.BAD_REQUEST, 'path is required');
        const vcs = await this.versions();
        let id;
        try { id = await vcs.resolve(rev ?? 'HEAD'); } catch (error) { throw new ProtocolError(ERR.NOT_FOUND, error.message); }
        const paths = this.#historyPaths(path);
        const kind = this.ws.getItem(path)?.kind ?? await this.#kindAt(vcs, id, paths);
        if (!kind) throw new ProtocolError(ERR.NOT_FOUND, `${path} 在版本 ${id.slice(0, 8)} 中不存在`);
        const at = await this.#dataAt(vcs, id, paths, kind);
        if (!at.present) throw new ProtocolError(ERR.NOT_FOUND, `${path} 在版本 ${id.slice(0, 8)} 中不存在`);
        if (at.error) throw new ProtocolError(ERR.BAD_REQUEST, `这个版本的文件无法读取：${at.error}`);
        return { rev: id, path, kind, data: at.data };
    }

    // ---- 预设工坊 prompt collection (workshop/prompts.json, docs/workspace-format.md) -------------------------

    /** The saved prompts; `hash` guards the next write. */
    async readCollection() {
        const text = await this.ws.readExtraFile(COLLECTION_FILE);
        let collection = { version: 1, prompts: [] };
        if (text !== null) {
            try { collection = JSON.parse(text.replace(/^\uFEFF/, '')); } catch (error) { throw new ProtocolError(ERR.BAD_REQUEST, `${COLLECTION_FILE}: invalid JSON (${error.message})`); }
        }
        return { collection, hash: await hashData(collection) };
    }

    /** Replaces the collection; refused (conflict) when it changed since `hash` was read. */
    async writeCollection({ collection, hash } = {}) {
        const ok = collection && typeof collection === 'object' && !Array.isArray(collection) && Array.isArray(collection.prompts)
            && collection.prompts.every(x => x && typeof x === 'object' && x.prompt && typeof x.prompt === 'object' && !Array.isArray(x.prompt));
        if (!ok) throw new ProtocolError(ERR.BAD_REQUEST, 'collection must be { prompts: [{ prompt: {...} }] }');
        return this.withLock(COLLECTION_FILE, async () => {
            const current = await this.readCollection();
            if (hash !== current.hash) throw new ProtocolError(ERR.CONFLICT, '收藏在别处被修改，请重新加载');
            await this.ws.writeExtraFile(COLLECTION_FILE, JSON.stringify(collection, null, 2) + '\n');
            this.scheduleSnapshot();
            return { hash: await hashData(collection) };
        });
    }

    /**
     * Puts an item's files back as they were in a version (the user's other files in the folder stay). Nothing is
     * sent: the item then shows local changes and syncs the usual way (auto-sync items right away).
     */
    async restoreVersion({ rev, path } = {}) {
        const item = this.requireItem(path);
        const vcs = await this.versions();
        let id;
        try { id = await vcs.resolve(rev); } catch (error) { throw new ProtocolError(ERR.NOT_FOUND, error.message); }
        return this.#restoreTo(vcs, item, id);
    }

    /**
     * 撤销当前的修改: the item goes back to the last recorded version (the draft's parent), dropping its part of the
     * draft; an item that entered the workspace after that version goes back to how it was when it was taken out /
     * created. The same write as restoring a version, so it can be undone.
     */
    async revertItem(path) {
        const item = this.requireItem(path);
        const vcs = await this.versions();
        await vcs.snapshot();
        const point = await vcs.revertPoint(this.ws.itemPaths(item));
        if (!point) throw new ProtocolError(ERR.NOT_FOUND, `${item.path} 没有记录过的版本，也没有取出时的状态可以恢复`);
        return { ...(await this.#restoreTo(vcs, item, point.oid)), origin: point.origin };
    }

    /** Remembers the item as it is now (just taken out / created) as its 撤销当前的修改 point for the open draft. */
    async #markOrigin(item) {
        try {
            const vcs = await this.versions();
            const oid = (await vcs.snapshot()) ?? await vcs.resolve('HEAD');
            await vcs.setOrigin(item.path, oid);
        } catch (error) {
            this.log(`version history: ${error.message}`);
        }
    }

    async #restoreTo(vcs, item, id) {
        const files = await this.#filesAt(vcs, id, this.ws.itemPaths(item));
        if (!files) throw new ProtocolError(ERR.NOT_FOUND, `${item.path} 在版本 ${id.slice(0, 8)} 中不存在`);
        const result = await this.withLock(item.path, async () => {
            try { await this.#encodeFiles(item.kind, files); } catch (error) { throw new ProtocolError(ERR.BAD_REQUEST, `这个版本的文件无法读取：${error.message}`); }
            await this.#undoable(item, () => this.ws.writeItemFiles(item.path, files, codecFor(item.kind).owns));
            return { path: item.path, rev: id, hash: (await this.encodeItem(item)).hash };
        });
        await vcs.snapshot();
        this.log(`restored ${item.path} to version ${id.slice(0, 8)}`);
        this.onHistory();
        return result;
    }

    // ---- 压缩历史 (docs/versioning.md §7.1) ------------------------------------------------------------------

    /** What the history takes on disk, how much of it nothing uses any more, and the last compaction. */
    async historyStorage() {
        const vcs = await this.versions();
        return { ...(await vcs.storage({ unused: true })), compacted: this.ws.state.history?.compacted ?? null };
    }

    /**
     * Deletes the replaced draft states and files only they used, and packs the rest into one file. Every version,
     * tag, draft and deployed pointer stays. `reason` names the automatic rule that ran it.
     */
    async compactHistory({ reason = '' } = {}) {
        const vcs = await this.versions();
        await vcs.snapshot(); // the files on disk are in the draft before anything is judged unused
        const result = await vcs.compact();
        this.ws.state.history = { ...this.ws.state.history, compacted: { at: new Date().toISOString(), bytes: result.afterBytes, ...(reason ? { reason } : {}) } };
        await this.ws.saveState();
        this.log(`压缩历史${reason ? `（自动：${reason}）` : ''}：${mb(result.beforeBytes)} → ${mb(result.afterBytes)}，删除 ${result.removed} 个不再使用的对象`);
        return result;
    }

    /**
     * Automatic cleanup (设置 → 版本历史): above `maxMB` the history is compacted, but again only once it grew by a
     * fifth since the last compaction (history that is simply that big is not repacked every time); otherwise
     * unused objects older than `keepDays` are deleted.
     */
    async autoCleanHistory({ maxMB, keepDays }) {
        const vcs = await this.versions();
        const { bytes } = await vcs.storage();
        const last = this.ws.state.history?.compacted?.bytes ?? 0;
        if (bytes > maxMB * MB && bytes > last * 1.2) return this.compactHistory({ reason: `超过 ${maxMB} MB` });
        const result = await vcs.compact({ keepMs: keepDays * DAY_MS, pack: false });
        if (result.removed) this.log(`清理历史：删除 ${result.removed} 个超过 ${keepDays} 天不再使用的对象（${mb(result.beforeBytes - result.afterBytes)}）`);
        return result;
    }

    // ---- deploying versions (docs/versioning.md §3) -----------------------------------------------------

    /** The binding follows the workspace again. */
    async #unpin(item, targetId) {
        delete item.bindings[targetId].pin;
        this.ws.setSyncState(item.path, targetId, { pinHash: undefined });
        await this.ws.saveManifest();
        await this.ws.saveState();
    }

    /**
     * Pushes a version to one tavern: every item of that version bound to the tavern (or only `paths`) is written
     * as it was in the version, the workspace is left alone, and the binding is pinned there. Each write is checked
     * against the base hash like any sync: a tavern changed since the last agreement is reported, not overwritten,
     * unless `force`.
     */
    async pushVersion({ rev, target: targetSpec, paths, force = false } = {}) {
        const vcs = await this.versions();
        let id;
        try { id = await vcs.resolve(rev ?? 'HEAD'); } catch (error) { throw new ProtocolError(ERR.NOT_FOUND, error.message); }
        const { target } = this.targets.resolve(targetSpec);
        const bound = this.ws.manifest.items.filter(item => item.bindings?.[target.id]);
        // A tag names one item's version: `<item path>:<tag>`, or a tag name alone pushes the items carrying it
        // (unless items are given), never the whole snapshot.
        const tagged = typeof rev === 'string' && rev.lastIndexOf(':') > 0 ? rev.slice(0, rev.lastIndexOf(':')) : null;
        if (!paths?.length && tagged && this.ws.manifest.items.some(i => i.path === tagged)) paths = [tagged];
        if (!paths?.length && typeof rev === 'string') {
            const carrying = (await this.#tagsAt(vcs, id)).filter(t => t.name === rev).map(t => t.path);
            if (carrying.length) paths = carrying.filter(p => bound.some(i => i.path === p));
            if (carrying.length && !paths.length) throw new ProtocolError(ERR.BAD_REQUEST, `带标签 ${rev} 的项都没有绑定这个酒馆`);
        }
        let items;
        if (paths?.length) {
            items = paths.map(p => {
                const item = this.requireItem(p);
                if (!item.bindings?.[target.id]) throw new ProtocolError(ERR.BAD_REQUEST, `${p} 没有绑定这个酒馆`);
                return item;
            });
        } else {
            items = [];
            for (const item of bound) if (await this.#filesAt(vcs, id, this.ws.itemPaths(item))) items.push(item);
            if (!items.length) throw new ProtocolError(ERR.BAD_REQUEST, `版本 ${id.slice(0, 8)} 里没有绑定了这个酒馆的项`);
        }
        this.#assertCanWrite(target.id);
        const results = [];
        for (const item of items) {
            results.push(await this.withLock(item.path, () => this.#pushItem(vcs, id, item, target.id, force)).catch(error => ({
                path: item.path, result: error.code === ERR.CONFLICT ? 'tavern-changed' : 'failed', error: error.message,
            })));
        }
        this.onHistory();
        const pushed = new Set(items.map(i => i.path));
        const tags = (await this.#tagsAt(vcs, id)).filter(t => pushed.has(t.path));
        const names = [...new Set(tags.map(t => t.name))];
        return { rev: id, name: names.length === 1 ? names[0] : id.slice(0, 8), target: target.id, results };
    }

    async #pushItem(vcs, id, item, targetId, force) {
        const binding = item.bindings[targetId];
        const { link } = this.targets.tryGet(targetId) ?? {};
        if (!link) throw new ProtocolError(ERR.NOT_CONNECTED, `Target ${targetId} is not connected`);
        const version = await this.#dataAt(vcs, id, this.ws.itemPaths(item), item.kind);
        if (!version.present) throw new ProtocolError(ERR.NOT_FOUND, `${item.path} 在版本 ${id.slice(0, 8)} 中不存在`);
        if (!version.data) throw new ProtocolError(ERR.BAD_REQUEST, `这个版本的文件无法读取：${version.error}`);
        const state = this.ws.getSyncState(item.path, targetId) ?? {};
        const baseHash = force ? (await link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id })).hash : state.base;
        const result = await link.request(MSG.ITEM_PUT, { kind: item.kind, id: binding.id, data: version.data, baseHash });
        await this.#agree(item, targetId, result.data ?? version.data, result.hash);
        binding.pin = id;
        this.ws.setSyncState(item.path, targetId, { pinHash: await hashData(version.data), ...(result.warnings?.length ? { warnings: result.warnings, warnedAt: new Date().toISOString() } : {}) });
        await this.ws.saveManifest();
        await this.ws.saveState();
        await vcs.setDeployed(targetId, item.path, id);
        this.log(`pushed ${item.path} @ ${id.slice(0, 8)} -> ${targetId}`);
        return { path: item.path, result: 'pushed', hash: result.hash, warnings: result.warnings ?? [] };
    }

    /** Ends a pin: the binding follows the workspace; auto-sync bindings sync right away. */
    async follow(path, { target: targetSpec } = {}) {
        const item = this.requireItem(path);
        const bound = Object.keys(item.bindings ?? {});
        const targetId = targetSpec ? bound.find(id => id === targetSpec || id.startsWith(targetSpec)) : (bound.length === 1 ? bound[0] : null);
        if (!targetId) throw new ProtocolError(ERR.BAD_REQUEST, `Specify which binding of ${path} to change`);
        return this.withLock(path, async () => {
            const binding = item.bindings[targetId];
            if (!binding.pin) return { path, target: targetId, result: 'following' };
            await this.#unpin(item, targetId);
            this.log(`${path} -> ${targetId} follows the workspace again`);
            const conn = binding.autoSync ? this.#writableConn(targetId) : null;
            if (!conn) return { path, target: targetId, result: 'following' };
            const synced = await this.#syncLocked(item, targetId, binding, conn.link, false)
                .catch(error => ({ result: 'failed', error: error.message }));
            return { path, target: targetId, result: 'following', sync: synced.result, ...(synced.error ? { error: synced.error } : {}) };
        });
    }

    // ---- status ------------------------------------------------------------

    async status() {
        const items = [];
        const vcs = await this.versions().catch(error => { this.log(`version history: ${error.message}`); return null; });
        for (const item of this.ws.manifest.items) {
            let localHash = null;
            let frameworks;
            let parts;
            let world;
            let error;
            try {
                const local = await this.encodeItem(item);
                localHash = local.hash;
                if (item.kind === 'character') {
                    frameworks = detectFrameworks(local.data);
                    parts = presentParts(local.data);
                    const link = this.#worldOf(item, local.data);
                    if (link) world = { name: link.name, path: link.item?.path ?? null };
                }
            } catch (e) {
                error = e.message;
            }
            const bindings = await Promise.all(Object.entries(item.bindings ?? {}).map(async ([targetId, binding]) => {
                const state = this.ws.getSyncState(item.path, targetId) ?? {};
                const liveConn = this.targets.tryGetLive(targetId);
                const conn = liveConn ?? this.targets.tryGet(targetId);
                // Offline: read the tavern's current hash from its folder, so the status is real, not last known.
                let tavernHash = state.tavern;
                let tavernError;
                if (!liveConn && conn) {
                    try {
                        tavernHash = (await conn.link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id })).hash;
                    } catch (e) {
                        tavernError = e.message;
                    }
                }
                const pinned = binding.pin ? { rev: binding.pin, name: (vcs && (await this.#tagsAt(vcs, binding.pin).catch(() => [])).find(t => t.path === item.path)?.name) || binding.pin.slice(0, 8), ahead: !error && localHash !== state.pinHash } : null;
                // Pinned: the workspace moving on is not "unsynced"; only a tavern edit counts.
                const localChanged = !pinned && !error && localHash !== state.base;
                const tavernChanged = Boolean(tavernHash) && tavernHash !== state.base;
                let status = 'in-sync';
                if (state.conflict) status = 'conflict';
                else if (error && !pinned) status = 'invalid';
                else if (pinned) status = tavernChanged ? 'tavern-changes' : 'in-sync';
                else if (localChanged && tavernChanged && tavernHash !== localHash) status = 'both-changed';
                else if (localChanged && tavernHash !== localHash) status = 'local-changes';
                else if (tavernChanged && tavernHash !== localHash) status = 'tavern-changes';
                const offlineSync = this.targets.offlineMode(targetId);
                const deployed = vcs ? await vcs.getDeployed(targetId, item.path).catch(() => null) : null;
                return {
                    target: targetId, id: binding.id, autoSync: binding.autoSync,
                    connected: Boolean(liveConn), offline: !liveConn && Boolean(conn), status,
                    ...(deployed ? { deployed } : {}),
                    ...(pinned ? { pinned } : {}),
                    ...(offlineSync ? { offlineSync } : {}),
                    // Local edits held back until the tavern starts (mode 'wait').
                    ...(offlineSync === 'wait' && (status === 'local-changes' || status === 'both-changed') ? { waiting: true } : {}),
                    ...(tavernError ? { tavernError } : {}),
                    ...(state.warnings?.length ? { warnings: state.warnings, warnedAt: state.warnedAt } : {}),
                };
            }));
            const top = item.path.split('/')[0];
            items.push({ path: item.path, kind: item.kind, name: this.ws.itemName(item), ...(isProjectFolder(top) ? { project: top } : {}), hash: localHash, error, bindings, edits: await this.undoState(item.path), ...(item.layout ? { layout: item.layout } : {}), ...(frameworks ? { frameworks } : {}), ...(parts ? { parts } : {}), ...(world ? { world } : {}) });
        }
        return {
            workspace: this.ws.root,
            targets: this.targets.list(),
            offlineTargets: this.targets.listOffline(),
            // every tavern that ever connected to this workspace (names for bindings whose tavern is not reachable)
            knownTargets: Object.entries(this.ws.manifest.targets ?? {}).map(([id, t]) => ({ id, host: t.host, label: t.label })),
            items,
            // the draft as last snapshotted (the watcher snapshots shortly after file changes)
            draft: vcs ? await this.#draftInfo(vcs).catch(() => null) : null,
        };
    }
}
