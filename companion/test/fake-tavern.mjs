import WebSocket from 'ws';
import { hashData } from '../../shared/hash.js';
import { MSG, PROTOCOL_VERSION, event, okResponse, errorResponse, ProtocolError, ERR, request } from '../../shared/protocol.js';

/** Minimal stand-in for Cellar Link backed by an in-memory store. */
export class FakeTavern {
    constructor(port, { targetId = 'fake-target-1', host = 'st', origin = 'http://127.0.0.1:8000', headers } = {}) {
        this.store = {
            character: new Map([['Alice.png', { name: 'Alice', data: { name: 'Alice', description: 'orig', alternate_greetings: [], extensions: {} } }]]),
            lorebook: new Map([['Book', { entries: { 0: { uid: 0, key: ['k'], comment: 'c', content: 'body' } } }]]),
        };
        this.watch = [];
        this.puts = 0;
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/link`, { origin, headers });
        this.ready = new Promise((resolve, reject) => {
            this.ws.on('open', () => this.ws.send(JSON.stringify(request('h1', MSG.HELLO, {
                protocol: PROTOCOL_VERSION,
                target: { id: targetId, host, label: `Fake ${host}`, hostVersion: 'test' },
                capabilities: { worldInfoEntryTemplate: { key: [], content: '', comment: '', disable: false } },
            }))));
            this.ws.on('error', reject);
            this.ws.on('close', code => reject(Object.assign(new Error('closed'), { code })));
            this.ws.on('message', async raw => {
                const msg = JSON.parse(String(raw));
                if (msg.type === MSG.RESPONSE && msg.id === 'h1') return msg.ok ? resolve() : reject(new Error(msg.error.code));
                try {
                    this.ws.send(JSON.stringify(okResponse(msg.id, await this.handle(msg))));
                } catch (error) {
                    this.ws.send(JSON.stringify(errorResponse(msg.id, error)));
                }
            });
        });
    }

    async handle({ type, payload }) {
        if (type === MSG.WATCH_SET) { this.watch = payload.items; return {}; }
        if (type === MSG.ASSET_GET) {
            this.assetGets = (this.assetGets ?? 0) + 1;
            const bytes = this.assets?.[payload.id];
            if (!bytes) throw new ProtocolError(ERR.NOT_FOUND, payload.id);
            return { type: payload.type, id: payload.id, mime: 'image/jpeg', data: Buffer.from(bytes).toString('base64') };
        }
        const items = this.store[payload.kind];
        if (type === MSG.CATALOG_LIST) {
            const all = [...items.keys()].map(id => ({ id, name: id }));
            return { total: all.length, items: all };
        }
        const current = items.get(payload.id);
        if (!current) throw new ProtocolError(ERR.NOT_FOUND, payload.id);
        if (type === MSG.ITEM_GET) return { data: current, hash: await hashData(current) };
        if (type === MSG.ITEM_PUT) {
            const sneak = this.beforePut?.shift();
            if (sneak) { sneak(current); return this.handle({ type, payload }); }
            const currentHash = await hashData(current);
            if (payload.baseHash !== currentHash) throw new ProtocolError(ERR.CONFLICT, 'changed', { currentHash });
            this.puts++;
            items.set(payload.id, payload.data);
            return { data: payload.data, hash: await hashData(payload.data), ...(this.putWarnings ? { warnings: this.putWarnings.splice(0) } : {}) };
        }
        throw new ProtocolError(ERR.BAD_REQUEST, type);
    }

    /** Simulates an edit inside the tavern UI. */
    async edit(kind, id, mutate) {
        const data = structuredClone(this.store[kind].get(id));
        mutate(data);
        this.store[kind].set(id, data);
        this.ws.send(JSON.stringify(event(MSG.ITEM_CHANGED, { kind, id, hash: await hashData(data) })));
    }

    close() { this.ws.close(); }
}
