/** Registry of connected taverns (targets), keyed by targetId. */
import { ERR, ProtocolError } from '../../shared/protocol.js';

export class TargetRegistry {
    constructor() {
        /** @type {Map<string, {target: object, link: {request: Function, close: Function}}>} */
        this.byId = new Map();
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

    list() {
        return [...this.byId.values()].map(({ target }) => target);
    }

    /**
     * Resolves a target spec (full id, unique id prefix, or empty when exactly one target is connected).
     * @returns {{target: object, link: object}}
     */
    resolve(spec) {
        const entries = [...this.byId.values()];
        if (!spec) {
            if (entries.length === 1) return entries[0];
            throw new ProtocolError(entries.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED,
                entries.length ? 'Several taverns are connected; specify a target' : 'No tavern is connected');
        }
        const exact = this.byId.get(spec);
        if (exact) return exact;
        const matches = entries.filter(({ target }) => target.id.startsWith(spec));
        if (matches.length === 1) return matches[0];
        throw new ProtocolError(matches.length ? ERR.BAD_REQUEST : ERR.NOT_CONNECTED,
            matches.length ? `Target prefix "${spec}" is ambiguous` : `Target "${spec}" is not connected`);
    }

    tryGet(targetId) {
        return this.byId.get(targetId) ?? null;
    }
}
