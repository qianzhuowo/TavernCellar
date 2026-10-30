/**
 * Registry of taverns (targets), keyed by targetId.
 * Live Cellar Link connections always win; offline links (direct access to a tavern's data folder, see taverns/offline.js)
 * stand in for a target that is not connected. Both expose `request(type, payload)`.
 */
import { ERR, ProtocolError } from '../../shared/protocol.js';

/** Offline links carry their resolved location; anything without an explicit 'write' waits. */
const offlineModeOf = link => (link?.location?.offlineSync === 'write' ? 'write' : 'wait');

export class TargetRegistry {
    constructor() {
        /** @type {Map<string, {target: object, link: {request: Function, close: Function}}>} */
        this.byId = new Map();
        /** @type {Map<string, {target: object, link: {request: Function, close: Function}}>} */
        this.offlineById = new Map();
    }

    add(target, link) {
        const previous = this.byId.get(target.id);
        this.byId.set(target.id, { target, link });
        return previous ?? null;
    }

    remove(targetId, link) {
        const current = this.byId.get(targetId);
        if (current && current.link === link) this.byId.delete(targetId);
    }

    /** Replaces all offline links. @param {Array<{target: object, request: Function, close: Function}>} links */
    setOffline(links) {
        this.offlineById = new Map(links.map(link => [link.target.id, { target: link.target, link }]));
    }

    /** Connected (live) targets. */
    list() {
        return [...this.byId.values()].map(({ target }) => target);
    }

    /** Targets reachable only through their data folder right now, with their offline mode. */
    listOffline() {
        return [...this.offlineById.values()].filter(({ target }) => !this.byId.has(target.id))
            .map(({ target, link }) => ({ ...target, offlineSync: offlineModeOf(link) }));
    }

    /** 'wait' | 'write' for a target that is offline right now; null when it is live or unknown. */
    offlineMode(targetId) {
        if (this.byId.has(targetId)) return null;
        const entry = this.offlineById.get(targetId);
        return entry ? offlineModeOf(entry.link) : null;
    }

    #available() {
        return [...this.byId.values(), ...[...this.offlineById.values()].filter(({ target }) => !this.byId.has(target.id))];
    }

    /**
     * Resolves a target spec (full id, unique id prefix, or empty when exactly one target is available).
     * With no spec, a single live target is preferred over offline ones.
     * @returns {{target: object, link: object}}
     */
    resolve(spec) {
        if (!spec) {
            const live = [...this.byId.values()];
            if (live.length === 1) return live[0];
            const all = this.#available();
            if (!live.length && all.length === 1) return all[0];
            throw new ProtocolError(all.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED,
                all.length ? 'Several taverns are available; specify a target' : 'No tavern is connected and no tavern folder is configured');
        }
        const exact = this.tryGet(spec);
        if (exact) return exact;
        const matches = this.#available().filter(({ target }) => target.id.startsWith(spec));
        if (matches.length === 1) return matches[0];
        throw new ProtocolError(matches.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED,
            matches.length ? `Target prefix "${spec}" is ambiguous` : `Target "${spec}" is not connected`);
    }

    /** Live connection, else offline link. */
    tryGet(targetId) {
        return this.byId.get(targetId) ?? this.offlineById.get(targetId) ?? null;
    }

    /** Live connection only (auto-sync and tavern events never go offline). */
    tryGetLive(targetId) {
        return this.byId.get(targetId) ?? null;
    }
}
