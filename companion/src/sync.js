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
        await this.ws.writeItemFiles(item.path, codecFor(item.kind).decode(data));
        const { hash } = await this.encodeItem(item);
        return hash;
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
            if (connected.length !== 1) {
                throw new ProtocolError(connected.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED,
                    connected.length ? `Item ${item.path} is bound to several connected taverns; specify a target` : `No bound tavern of ${item.path} is connected`);
            }
            targetId = connected[0];
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
    }

    async pushWatchList(targetId) {
        const conn = this.targets.tryGet(targetId);
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

    async checkout(targetSpec, { kind, id }) {
        const { target, link } = this.targets.resolve(targetSpec);
        const existing = this.ws.findBinding(target.id, kind, id);
        if (existing) throw new ProtocolError(ERR.BAD_REQUEST, `${kind} "${id}" is already checked out at ${existing.item.path}`);
        const remote = await link.request(MSG.ITEM_GET, { kind, id });
        const path = this.ws.allocateItemPath(kind, id);
        const item = { path, kind, bindings: { [target.id]: { id, autoSync: false } } };
        return this.withLock(path, async () => {
            this.ws.manifest.items.push(item);
            const written = await this.writeItem(item, remote.data);
            this.ws.setSyncState(path, target.id, { base: remote.hash, tavern: remote.hash });
            await this.ws.saveManifest();
            await this.ws.saveState();
            await this.pushWatchList(target.id);
            const warnings = written === remote.hash ? [] : ['Workspace files do not round-trip to the tavern data exactly'];
            this.log(`checked out ${kind} "${id}" -> ${path}`);
            return { path, target: target.id, hash: remote.hash, warnings };
        });
    }

    async sync(path, { target: targetSpec, force = false } = {}) {
        const item = this.requireItem(path);
        const { targetId, binding, link } = this.resolveBinding(item, targetSpec);
        return this.withLock(path, () => this.#syncLocked(item, targetId, binding, link, force));
    }

    async #syncLocked(item, targetId, binding, link, force) {
        const state = this.ws.getSyncState(item.path, targetId) ?? {};
        const local = await this.encodeItem(item);
        if (local.hash === state.base && !force) return { path: item.path, target: targetId, result: 'up-to-date', hash: local.hash };
        if (state.conflict && !force) {
            throw new ProtocolError(ERR.CONFLICT, `${item.path} has an unresolved conflict with ${targetId}; pull --force or sync --force`);
        }
        let baseHash = state.base;
        if (force) baseHash = (await link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id })).hash;
        let result;
        try {
            result = await link.request(MSG.ITEM_PUT, { kind: item.kind, id: binding.id, data: local.data, baseHash });
        } catch (error) {
            if (error.code === ERR.CONFLICT) await this.#markConflict(item, targetId, binding, link, error.details?.currentHash);
            throw error;
        }
        const warnings = [...(result.warnings ?? [])];
        if (result.hash !== local.hash) {
            // The stored data differs from what we sent (identity fields such as a character's avatar,
            // or host normalization the plugin reported above): adopt what the tavern actually stored.
            await this.writeItem(item, result.data);
            if (warnings.length) warnings.push('Workspace updated to match the tavern');
        }
        this.ws.setSyncState(item.path, targetId, { base: result.hash, tavern: result.hash, conflict: undefined });
        await this.ws.clearConflict(item.path, targetId);
        await this.ws.saveState();
        this.log(`synced ${item.path} -> ${targetId}${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
        return { path: item.path, target: targetId, result: 'synced', hash: result.hash, warnings };
    }

    async pull(path, { target: targetSpec, force = false } = {}) {
        const item = this.requireItem(path);
        const { targetId, binding, link } = this.resolveBinding(item, targetSpec);
        return this.withLock(path, async () => {
            const state = this.ws.getSyncState(item.path, targetId) ?? {};
            const local = await this.encodeItem(item).catch(() => null); // unreadable files count as local changes
            const remote = await link.request(MSG.ITEM_GET, { kind: item.kind, id: binding.id });
            if (local?.hash !== state.base && local?.hash !== remote.hash && !force) {
                await this.#recordConflict(item, targetId, remote);
                throw new ProtocolError(ERR.CONFLICT, `${item.path} has local changes; use pull --force to discard them`);
            }
            await this.writeItem(item, remote.data);
            this.ws.setSyncState(item.path, targetId, { base: remote.hash, tavern: remote.hash, conflict: undefined });
            await this.ws.clearConflict(item.path, targetId);
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
            const conn = this.targets.tryGet(targetId);
            if (!conn) return;
            const local = await this.encodeItem(item).catch(() => null);
            const remote = await conn.link.request(MSG.ITEM_GET, { kind, id: binding.id });
            if (remote.hash === state.base) return;
            if (local && local.hash === state.base) {
                await this.writeItem(item, remote.data);
                this.ws.setSyncState(item.path, targetId, { base: remote.hash, tavern: remote.hash, conflict: undefined });
                await this.ws.saveState();
                this.log(`tavern change pulled: ${item.path} <- ${targetId}`);
            } else if (local && local.hash === remote.hash) {
                this.ws.setSyncState(item.path, targetId, { base: remote.hash, tavern: remote.hash, conflict: undefined });
                await this.ws.saveState();
            } else {
                await this.#recordConflict(item, targetId, remote);
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
                const conn = this.targets.tryGet(targetId);
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

    async #recordConflict(item, targetId, remote) {
        const file = await this.ws.saveConflict(item.path, targetId, { kind: item.kind, hash: remote.hash, data: remote.data });
        this.ws.setSyncState(item.path, targetId, { tavern: remote.hash, conflict: { at: new Date().toISOString(), file } });
        await this.ws.saveState();
        this.log(`CONFLICT ${item.path} <-> ${targetId}; tavern version saved to ${file}`);
    }

    // ---- status ------------------------------------------------------------

    async status() {
        const items = [];
        for (const item of this.ws.manifest.items) {
            let localHash = null;
            let error;
            try {
                localHash = (await this.encodeItem(item)).hash;
            } catch (e) {
                error = e.message;
            }
            const bindings = Object.entries(item.bindings ?? {}).map(([targetId, binding]) => {
                const state = this.ws.getSyncState(item.path, targetId) ?? {};
                let status = 'in-sync';
                if (state.conflict) status = 'conflict';
                else if (error) status = 'invalid';
                else if (localHash !== state.base) status = 'local-changes';
                else if (state.tavern && state.tavern !== state.base) status = 'tavern-changes';
                return { target: targetId, id: binding.id, autoSync: binding.autoSync, connected: Boolean(this.targets.tryGet(targetId)), status };
            });
            items.push({ path: item.path, kind: item.kind, error, bindings });
        }
        return {
            workspace: this.ws.root,
            targets: this.targets.list(),
            items,
        };
    }
}
