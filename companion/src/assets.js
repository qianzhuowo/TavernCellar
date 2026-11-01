/**
 * Avatar thumbnails for Studio, fetched from a tavern with `asset.get` (live Cellar Link or offline folder).
 * Kept in memory per tavern + file name; a tavern-side edit of that character drops its entry, and entries expire
 * so an avatar changed in the tavern shows up within a few minutes even when nobody watches the card.
 */
import { createHash } from 'node:crypto';
import { MSG, ProtocolError, ERR, assertAssetRef } from '../../shared/protocol.js';

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 600;

export class AssetCache {
    /** @param {import('./targets.js').TargetRegistry} targets */
    constructor(targets) {
        this.targets = targets;
        /** @type {Map<string, {at: number, mime: string, body: Buffer, etag: string}>} */
        this.entries = new Map();
        /** @type {Map<string, Promise<any>>} */
        this.inflight = new Map();
    }

    /** @returns {Promise<{mime: string, body: Buffer, etag: string}>} */
    async get(targetId, type, id) {
        assertAssetRef({ type, id });
        if (typeof targetId !== 'string' || !targetId) throw new ProtocolError(ERR.BAD_REQUEST, 'target is required');
        const key = `${targetId}\u0000${type}\u0000${id}`;
        const hit = this.entries.get(key);
        if (hit && Date.now() - hit.at < TTL_MS) return hit;
        if (this.inflight.has(key)) return this.inflight.get(key);
        const job = (async () => {
            const conn = this.targets.tryGet(targetId);
            if (!conn) throw new ProtocolError(ERR.NOT_CONNECTED, `Target ${targetId} is not connected`);
            const result = await conn.link.request(MSG.ASSET_GET, { type, id });
            const body = Buffer.from(String(result?.data ?? ''), 'base64');
            if (!body.length) throw new ProtocolError(ERR.NOT_FOUND, `${type} ${id} is empty`);
            const mime = /^image\/[a-z0-9.+-]+$/i.test(result?.mime ?? '') ? result.mime : 'application/octet-stream';
            const entry = { at: Date.now(), mime, body, etag: `"${createHash('sha1').update(body).digest('hex')}"` };
            this.entries.delete(key);
            this.entries.set(key, entry);
            while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value);
            return entry;
        })();
        this.inflight.set(key, job);
        try {
            return await job;
        } finally {
            this.inflight.delete(key);
        }
    }

    /** Drops one character's avatar (the tavern reported an edit) or every avatar of a tavern. */
    invalidate(targetId, id) {
        for (const key of this.entries.keys()) {
            const [t, , i] = key.split('\u0000');
            if (t === targetId && (id === undefined || i === id)) this.entries.delete(key);
        }
    }
}
