import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { hashData } from '../../shared/hash.js';
import { MSG, PROTOCOL_VERSION, event, okResponse, errorResponse, ProtocolError, ERR, request } from '../../shared/protocol.js';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';

const TOKEN = 'test-token-0123456789abcdef';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Minimal stand-in for Cellar Link backed by an in-memory store. */
class FakeTavern {
    constructor(port, { token = TOKEN, targetId = 'fake-target-1' } = {}) {
        this.store = {
            character: new Map([['Alice.png', { name: 'Alice', data: { name: 'Alice', description: 'orig', alternate_greetings: [], extensions: {} } }]]),
            lorebook: new Map([['Book', { entries: { 0: { uid: 0, key: ['k'], comment: 'c', content: 'body' } } }]]),
        };
        this.watch = [];
        this.puts = 0;
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/link`, { origin: 'http://127.0.0.1:8000' });
        this.ready = new Promise((resolve, reject) => {
            this.ws.on('open', () => this.ws.send(JSON.stringify(request('h1', MSG.HELLO, {
                protocol: PROTOCOL_VERSION, token,
                target: { id: targetId, host: 'st', label: 'Fake ST', hostVersion: 'test' },
                capabilities: { worldInfoEntryTemplate: { key: [], content: '', comment: '', disable: false } },
            }))));
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
        const items = this.store[payload.kind];
        if (type === MSG.CATALOG_LIST) {
            const all = [...items.keys()].map(id => ({ id, name: id }));
            return { total: all.length, items: all };
        }
        const current = items.get(payload.id);
        if (!current) throw new ProtocolError(ERR.NOT_FOUND, payload.id);
        if (type === MSG.ITEM_GET) return { data: current, hash: await hashData(current) };
        if (type === MSG.ITEM_PUT) {
            const currentHash = await hashData(current);
            if (payload.baseHash !== currentHash) throw new ProtocolError(ERR.CONFLICT, 'changed', { currentHash });
            this.puts++;
            items.set(payload.id, payload.data);
            return { data: payload.data, hash: await hashData(payload.data) };
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

let dir, server, ws, tavern;
const api = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method, headers: { Authorization: `Bearer ${TOKEN}` }, body: body && JSON.stringify(body),
    });
    return res.json();
};
const until = async (fn, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await sleep(50); }
    throw new Error('condition not reached');
};

before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cellar-test-'));
    ws = await Workspace.init(dir);
    server = await startServer({ config: { port: 0, token: TOKEN, allowOrigins: [] }, workspace: ws, log: () => {} });
    tavern = new FakeTavern(server.port);
    await tavern.ready;
});

after(async () => {
    tavern?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
});

test('wrong token and foreign origin are rejected', async () => {
    const bad = new FakeTavern(server.port, { token: 'nope-nope-nope-nope', targetId: 'other-target' });
    await assert.rejects(bad.ready, err => err.message === 'unauthorized' || err.code === 4401);
    const foreign = new WebSocket(`ws://127.0.0.1:${server.port}/link`, { origin: 'https://evil.example' });
    await assert.rejects(new Promise((res, rej) => { foreign.on('open', res); foreign.on('error', rej); }));
    const noAuth = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    assert.equal(noAuth.status, 401);
    const browser = await fetch(`http://127.0.0.1:${server.port}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://127.0.0.1:8000' } });
    assert.equal(browser.status, 401);
});

test('catalog and checkout write workspace files and watch list', async () => {
    const cat = await api('POST', '/api/catalog', { kind: 'character' });
    assert.equal(cat.result.items[0].id, 'Alice.png');
    const co = await api('POST', '/api/checkout', { kind: 'character', id: 'Alice.png' });
    assert.equal(co.ok, true, JSON.stringify(co));
    assert.equal(co.result.path, 'characters/Alice');
    assert.deepEqual(co.result.warnings, []);
    assert.equal(await readFile(join(dir, 'characters/Alice/description.md'), 'utf8'), 'orig');
    await until(() => tavern.watch.length === 1);
    const again = await api('POST', '/api/checkout', { kind: 'character', id: 'Alice.png' });
    assert.equal(again.error.code, 'bad_request');
    const cat2 = await api('POST', '/api/catalog', { kind: 'character' });
    assert.equal(cat2.result.items[0].checkedOut, 'characters/Alice');
});

test('manual sync pushes local edits', async () => {
    await writeFile(join(dir, 'characters/Alice/description.md'), 'edited in VS Code\r\n');
    const status = await api('GET', '/api/status');
    assert.equal(status.result.items[0].bindings[0].status, 'local-changes');
    const r = await api('POST', '/api/sync', { path: 'characters/Alice' });
    assert.equal(r.result.result, 'synced', JSON.stringify(r));
    assert.equal(tavern.store.character.get('Alice.png').data.description, 'edited in VS Code\n');
    const r2 = await api('POST', '/api/sync', { path: 'characters/Alice' });
    assert.equal(r2.result.result, 'up-to-date');
});

test('tavern edit is pulled automatically when workspace is clean', async () => {
    await tavern.edit('character', 'Alice.png', d => { d.data.description = 'from tavern'; });
    await until(async () => (await readFile(join(dir, 'characters/Alice/description.md'), 'utf8')) === 'from tavern');
    const status = await api('GET', '/api/status');
    assert.equal(status.result.items[0].bindings[0].status, 'in-sync');
});

test('concurrent edits produce a conflict, never a silent overwrite', async () => {
    await writeFile(join(dir, 'characters/Alice/description.md'), 'local version');
    await tavern.edit('character', 'Alice.png', d => { d.data.description = 'tavern version'; });
    await until(async () => (await api('GET', '/api/status')).result.items[0].bindings[0].status === 'conflict');
    assert.equal(await readFile(join(dir, 'characters/Alice/description.md'), 'utf8'), 'local version');
    const blocked = await api('POST', '/api/sync', { path: 'characters/Alice' });
    assert.equal(blocked.error.code, 'conflict');
    assert.equal(tavern.store.character.get('Alice.png').data.description, 'tavern version');
    const forced = await api('POST', '/api/sync', { path: 'characters/Alice', force: true });
    assert.equal(forced.result.result, 'synced');
    assert.equal(tavern.store.character.get('Alice.png').data.description, 'local version');
});

test('auto sync pushes on file save', async () => {
    const co = await api('POST', '/api/checkout', { kind: 'lorebook', id: 'Book' });
    assert.equal(co.result.path, 'lorebooks/Book');
    await api('POST', '/api/auto-sync', { path: 'lorebooks/Book', enabled: true });
    const file = join(dir, 'lorebooks/Book/entries/0000-c.md');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('body', 'auto synced body'));
    await until(() => tavern.store.lorebook.get('Book').entries[0].content === 'auto synced body');
    await writeFile(join(dir, 'lorebooks/Book/entries/new.md'), '---\ncomment: added\n---\nnew entry');
    await until(() => tavern.store.lorebook.get('Book').entries[1]?.content === 'new entry');
    assert.equal(tavern.store.lorebook.get('Book').entries[1].disable, false, 'entry template from capabilities applied');
});

test('invalid workspace files are not synced', async () => {
    const puts = tavern.puts;
    await writeFile(join(dir, 'lorebooks/Book/book.json'), '{ nope');
    await sleep(900);
    assert.equal(tavern.puts, puts);
    const status = await api('GET', '/api/status');
    const book = status.result.items.find(i => i.path === 'lorebooks/Book');
    assert.equal(book.bindings[0].status, 'invalid');
    const pulled = await api('POST', '/api/pull', { path: 'lorebooks/Book', force: true });
    assert.equal(pulled.result.result, 'pulled');
});
