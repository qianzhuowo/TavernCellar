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
import { ERR, MSG, ProtocolError } from '../../shared/protocol.js';
import { codecFor } from './codec/index.js';
import { CHARACTER_PARTS } from './codec/character.js';
import { detectFrameworks } from './codec/frameworks.js';
import { assemble, merge3, sameSlot as same, slotLabel, slotsOf } from './codec/slots.js';

/** Re-merge attempts when the tavern changes again between our merge and the write (rule 6). */
const MAX_MERGE_ATTEMPTS = 2;

/** Name of the lorebook a character is bound to (data.extensions.world), if any. */
function linkedWorldName(card) {
    const name = card?.data?.extensions?.world;
    return typeof name === 'string' && name.trim() ? name : undefined;
}
import { diffPaths } from './codec/object-path.js';

const ENTRY_TEMPLATE = 'worldinfo-entry';

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

    async encodeItem(item) {
        const files = await this.ws.readItemFiles(item.path);
        const options = item.kind === 'lorebook' ? { entryTemplate: await this.ws.loadTemplate(ENTRY_TEMPLATE) } : undefined;
        const data = codecFor(item.kind).encode(files, options);
        return { data, hash: await hashData(data) };
    }

    async writeItem(item, data) {
        const codec = codecFor(item.kind);
        await this.ws.writeItemFiles(item.path, codec.decode(data, await this.decodeOptions(item)), codec.owns);
        const { hash } = await this.encodeItem(item);
        return hash;
    }

    /**
     * Lorebooks: the entry template snapshot to lay out against. An item keeps the snapshot taken at its first
     * checkout (so a tavern upgrade that changes defaults cannot shift its files); new items take the tavern's
     * current template.
     */
    async decodeOptions(item) {
        if (item.kind === 'character') return { exclude: item.layout?.exclude ?? [] };
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
     * Changes which parts of a character are kept in card.json (`exclude`, see CHARACTER_PARTS) and re-lays out its
     * files. Only the layout changes: the content hash must stay the same, otherwise nothing is saved.
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
            this.log(`layout of ${path}: ${exclude.length ? `keeping ${exclude.join(', ')} in card.json` : 'everything split'}`);
            return { path, layout: item.layout ?? { exclude: [] } };
        });
    }

    async upgradeLayouts() {
        for (const item of this.ws.manifest.items) {
            await this.withLock(item.path, async () => {
                const files = await this.ws.readItemFiles(item.path).catch(() => null);
                const codec = codecFor(item.kind);
                let version = 0;
                try { version = JSON.parse(files?.['cellar-item.json'] ?? '{}').codec ?? 0; } catch { return; }
                if (!files || version >= codec.version) return;
                try {
                    const before = await this.encodeItem(item);
                    const hash = await this.writeItem(item, before.data);
                    if (hash !== before.hash) throw new Error('content changed during re-layout');
                    this.log(`upgraded layout of ${item.path} (codec ${version} -> ${codec.version})`);
                } catch (error) {
                    this.log(`could not upgrade layout of ${item.path}: ${error.message}`);
                }
            });
        }
    }

    requireItem(path) {
        const item = this.ws.getItem(path);
        if (!item) throw new ProtocolError(ERR.NOT_FOUND, `No workspace item at ${path}`);
        return item;
    }

    /** Resolves which bound + connected target to use for an item. */
    resolveBinding(item, targetSpec) {
        const bound = Object.keys(item.bindings ?? {});
        let targetId;
        if (targetSpec) {
            const matches = bound.filter(id => id === targetSpec || id.startsWith(targetSpec));
            if (matches.length !== 1) throw new ProtocolError(ERR.BAD_REQUEST, `Item ${item.path} has no unique binding for "${targetSpec}"`);
            targetId = matches[0];
        } else {
            const connected = bound.filter(id => this.targets.tryGet(id));
            const live = connected.filter(id => this.targets.tryGetLive(id));
            const candidates = live.length === 1 ? live : connected;
            if (candidates.length !== 1) {
                throw new ProtocolError(candidates.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED,
                    candidates.length ? `Item ${item.path} is bound to several available taverns; specify a target` : `No bound tavern of ${item.path} is connected or configured for offline access`);
            }
            targetId = candidates[0];
        }
        const conn = this.targets.tryGet(targetId);
        if (!conn) throw new ProtocolError(ERR.NOT_CONNECTED, `Target ${targetId} is not connected`);
        return { targetId, binding: item.bindings[targetId], link: conn.link };
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
                if (!binding.autoSync || (onlyTargetId && targetId !== onlyTargetId)) continue;
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
     * Checks out one item. For characters, `withWorld` also checks out the lorebook named in
     * data.extensions.world (or reuses it when it is already checked out from the same tavern, so a book shared by
     * several cards exists once). The link itself is not stored: status derives it from the card each time.
     */
    async checkout(targetSpec, { kind, id, exclude, withWorld = false }) {
        const result = await this.checkoutOne(targetSpec, { kind, id, exclude });
        if (kind !== 'character' || !withWorld || !result.worldName) return result;
        const name = result.worldName;
        const existing = this.ws.findBinding(result.target, 'lorebook', name);
        if (existing) return { ...result, world: { name, path: existing.item.path, checkedOut: false } };
        try {
            const book = await this.checkoutOne(result.target, { kind: 'lorebook', id: name });
            return { ...result, world: { name, path: book.path, checkedOut: true }, warnings: [...result.warnings, ...book.warnings] };
        } catch (error) {
            return { ...result, warnings: [...result.warnings, `绑定的世界书「${name}」未能取出：${error.message}`] };
        }
    }

    async checkoutOne(targetSpec, { kind, id, exclude }) {
        const { target, link } = this.targets.resolve(targetSpec);
        const existing = this.ws.findBinding(target.id, kind, id);
        if (existing) throw new ProtocolError(ERR.BAD_REQUEST, `${kind} "${id}" is already checked out at ${existing.item.path}`);
        if (exclude !== undefined && (kind !== 'character' || !Array.isArray(exclude) || exclude.some(p => !CHARACTER_PARTS.includes(p)))) {
            throw new ProtocolError(ERR.BAD_REQUEST, `exclude must list character parts: ${CHARACTER_PARTS.join(', ')}`);
        }
        const remote = await link.request(MSG.ITEM_GET, { kind, id });
        const path = this.ws.allocateItemPath(kind, id);
        const item = { path, kind, bindings: { [target.id]: { id, autoSync: false } }, ...(exclude?.length ? { layout: { exclude } } : {}) };
        return this.withLock(path, async () => {
            this.ws.manifest.items.push(item);
            const written = await this.writeItem(item, remote.data);
            await this.#agree(item, target.id, remote.data, remote.hash);
            await this.ws.saveManifest();
            await this.ws.saveState();
            await this.pushWatchList(target.id);
            const warnings = [];
            if (written !== remote.hash) {
                const paths = diffPaths(remote.data, (await this.encodeItem(item)).data);
                warnings.push(`Workspace files do not round-trip to the tavern data exactly; differing fields: ${paths.join(', ') || '(key order only)'}`);
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
        return this.withLock(path, () => this.#syncLocked(item, targetId, binding, link, force));
    }

    async #syncLocked(item, targetId, binding, link, force, attempt = 0) {
        const state = this.ws.getSyncState(item.path, targetId) ?? {};
        const local = await this.encodeItem(item);
        if (local.hash === state.base && !force) return { path: item.path, target: targetId, result: 'up-to-date', hash: local.hash };
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
            if (warnings.length) warnings.push('Workspace updated to match the tavern');
        }
        await this.#agree(item, targetId, result.data ?? local.data, result.hash);
        await this.ws.saveState();
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
            return { path: item.path, target: targetId, result: 'up-to-date', hash: remote.hash };
        }
        const base = await this.ws.loadBase(item.path, targetId);
        const baseUsable = local && base !== undefined && (await hashData(base)) === state.base;
        const { data, conflicts } = baseUsable ? merge3(item.kind, base, local.data, remote.data) : { data: local?.data, conflicts: ['*'] };
        if (baseUsable && (await hashData(data)) !== local.hash) await this.writeItem(item, data);
        if (conflicts.length) {
            await this.#recordConflict(item, targetId, remote, conflicts);
            const labels = conflicts.map(slot => (slot === '*' ? '整项' : slotLabel(slot, slotsOf(item.kind, local?.data ?? {}).get(slot)))).join('、');
            throw new ProtocolError(ERR.CONFLICT, `${item.path} 与酒馆在这些地方都有修改：${labels}`, { slots: conflicts });
        }
        await this.#agree(item, targetId, remote.data, remote.hash);
        await this.ws.saveState();
        this.log(`merged ${item.path} with ${targetId}`);
        const mergedHash = await hashData(data);
        if (mergedHash === remote.hash || !push) return { path: item.path, target: targetId, result: 'merged', hash: mergedHash, pending: mergedHash !== remote.hash };
        const pushed = await this.#syncLocked(item, targetId, binding, link, false, attempt);
        return { ...pushed, result: 'merged', merged: true };
    }

    /** Records that workspace and tavern agree on `data`: the base hash and the base snapshot used for merging. */
    async #agree(item, targetId, data, hash) {
        this.ws.setSyncState(item.path, targetId, { base: hash, tavern: hash, conflict: undefined });
        await this.ws.saveBase(item.path, targetId, data);
        await this.ws.clearConflict(item.path, targetId);
    }

    async pull(path, { target: targetSpec, force = false } = {}) {
        const item = this.requireItem(path);
        const { targetId, binding, link } = this.resolveBinding(item, targetSpec);
        return this.withLock(path, async () => {
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
            if (local && local.hash === state.base) {
                await this.writeItem(item, remote.data);
                await this.#agree(item, targetId, remote.data, remote.hash);
                await this.ws.saveState();
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
                if (!binding.autoSync || local.hash === state.base || state.conflict) continue;
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
        const l = slotsOf(item.kind, local ?? {}), t = slotsOf(item.kind, saved?.data ?? {}), b = base ? slotsOf(item.kind, base) : new Map();
        const side = (m, slot) => ({ value: m.has(slot) ? m.get(slot) : null, present: m.has(slot) });
        const slots = (conflict.slots ?? ['*']).map(slot => slot === '*'
            ? { slot, label: '整项', workspace: { value: null, present: local != null }, tavern: { value: null, present: Boolean(saved) }, base: { value: null, present: false },
                // No base to merge against: show what differs between the two sides, slot by slot, to choose from.
                differences: [...new Set([...l.keys(), ...t.keys()])].filter(s => !same(l.get(s), t.get(s)) && !s.endsWith('.$'))
                    .map(s => ({ slot: s, label: slotLabel(s, l.get(s) ?? t.get(s)), workspace: side(l, s), tavern: side(t, s), base: { value: null, present: false } })) }
            : { slot, label: slotLabel(slot, l.get(slot) ?? t.get(slot)), workspace: side(l, slot), tavern: side(t, slot), base: base ? side(b, slot) : { value: null, present: false, unknown: true } });
        return { path, kind: item.kind, target: targetId, at: conflict.at, slots };
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

    // ---- status ------------------------------------------------------------

    async status() {
        const items = [];
        for (const item of this.ws.manifest.items) {
            let localHash = null;
            let frameworks;
            let world;
            let error;
            try {
                const local = await this.encodeItem(item);
                localHash = local.hash;
                if (item.kind === 'character') {
                    frameworks = detectFrameworks(local.data);
                    const name = linkedWorldName(local.data);
                    if (name) {
                        const targetId = Object.keys(item.bindings ?? {})[0];
                        world = { name, path: (targetId && this.ws.findBinding(targetId, 'lorebook', name)?.item.path) ?? null };
                    }
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
                const localChanged = !error && localHash !== state.base;
                const tavernChanged = Boolean(tavernHash) && tavernHash !== state.base;
                let status = 'in-sync';
                if (state.conflict) status = 'conflict';
                else if (error) status = 'invalid';
                else if (localChanged && tavernChanged && tavernHash !== localHash) status = 'both-changed';
                else if (localChanged && tavernHash !== localHash) status = 'local-changes';
                else if (tavernChanged && tavernHash !== localHash) status = 'tavern-changes';
                const offlineSync = this.targets.offlineMode(targetId);
                return {
                    target: targetId, id: binding.id, autoSync: binding.autoSync,
                    connected: Boolean(liveConn), offline: !liveConn && Boolean(conn), status,
                    ...(offlineSync ? { offlineSync } : {}),
                    // Local edits held back until the tavern starts (mode 'wait').
                    ...(offlineSync === 'wait' && (status === 'local-changes' || status === 'both-changed') ? { waiting: true } : {}),
                    ...(tavernError ? { tavernError } : {}),
                };
            }));
            items.push({ path: item.path, kind: item.kind, error, bindings, ...(item.layout ? { layout: item.layout } : {}), ...(frameworks ? { frameworks } : {}), ...(world ? { world } : {}) });
        }
        return {
            workspace: this.ws.root,
            targets: this.targets.list(),
            offlineTargets: this.targets.listOffline(),
            items,
        };
    }
}
