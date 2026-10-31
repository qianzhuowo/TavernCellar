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

const TOKEN = 'test-token-0123456789abcdef'; // internal control-API secret; the Link itself has no token
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Minimal stand-in for Cellar Link backed by an in-memory store. */
class FakeTavern {
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
const api = async (method, path, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method, headers: { Authorization: `Bearer ${TOKEN}`, ...headers }, body: body && JSON.stringify(body),
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
    server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: ws, log: () => {}, watch: true, persistConfig: async () => {},
    });
    tavern = new FakeTavern(server.port);
    await tavern.ready;
});

after(async () => {
    tavern?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
});

/** Opens a raw Link socket and resolves 'open' or rejects with the HTTP status of a refused upgrade. */
const upgrade = (opts, path = '/link') => new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${server.port}${path}`, opts);
    sock.on('open', () => { sock.close(); resolve('open'); });
    sock.on('unexpected-response', (_req, res) => reject(Object.assign(new Error('refused'), { status: res.statusCode })));
    sock.on('error', reject);
});

test('link admission: tavern origins only, no token needed', async () => {
    const refused = err => err.status === 403;
    await assert.rejects(upgrade({}), refused, 'no Origin (non-browser client)');
    await assert.rejects(upgrade({ origin: 'https://evil.example' }), refused, 'foreign website');
    await assert.rejects(upgrade({ origin: 'http://127.0.0.1:8000', headers: { Host: `evil.example:${server.port}` } }), refused, 'DNS rebinding Host');
    await assert.rejects(upgrade({ origin: 'http://127.0.0.1:8000' }, '/other'), refused, 'wrong path');
    assert.equal(await upgrade({ origin: 'http://localhost:8000' }), 'open');
    assert.equal(await upgrade({ origin: 'http://tauri.localhost' }), 'open');

    const tt = new FakeTavern(server.port, { targetId: 'fake-tt-1', host: 'tt', origin: 'http://tauri.localhost' });
    await tt.ready;
    const status = await api('GET', '/api/status');
    assert.deepEqual(status.result.targets.map(t => t.host).sort(), ['st', 'tt']);
    tt.close();
    await until(async () => (await api('GET', '/api/status')).result.targets.length === 1);
});

test('taverns can be turned off and on; disabled hosts are refused and dropped', async () => {
    const tt = new FakeTavern(server.port, { targetId: 'fake-tt-2', host: 'tt', origin: 'http://tauri.localhost' });
    await tt.ready;
    const closed = new Promise(resolve => tt.ws.on('close', resolve));
    const off = await api('POST', '/api/taverns', { tt: false });
    assert.deepEqual(off.result.taverns, { st: true, tt: false });
    assert.equal(await closed, 4403, 'existing tt link is closed with TAVERN_DISABLED');

    const again = new FakeTavern(server.port, { targetId: 'fake-tt-3', host: 'tt', origin: 'http://tauri.localhost' });
    await assert.rejects(again.ready, err => err.message === 'tavern_disabled' || err.code === 4403);
    assert.equal((await api('POST', '/api/taverns', { tt: 'yes' })).error.code, 'bad_request');
    assert.deepEqual((await api('POST', '/api/taverns', { tt: true })).result.taverns, { st: true, tt: true });
    await until(async () => (await api('GET', '/api/status')).result.targets.length === 1);
    assert.deepEqual((await api('GET', '/api/status')).result.taverns, { st: true, tt: true });
});

test('control API: internal token, no browser origins, loopback Host only', async () => {
    const noAuth = await fetch(`http://127.0.0.1:${server.port}/api/status`);
    assert.equal(noAuth.status, 401);
    const browser = await fetch(`http://127.0.0.1:${server.port}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}`, Origin: 'http://127.0.0.1:8000' } });
    assert.equal(browser.status, 401);
    const { request: httpRequest } = await import('node:http');
    const rebound = await new Promise((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port: server.port, path: '/api/status', headers: { Host: 'evil.example', Authorization: `Bearer ${TOKEN}` } }, res => { res.resume(); resolve(res.statusCode); })
            .on('error', reject).end();
    });
    assert.equal(rebound, 401);
    const detect = await api('GET', '/api/detect');
    assert.equal(detect.ok, true);
    assert.deepEqual(detect.result.st.otherConnections.map(t => t.id), ['fake-target-1']);
    assert.equal(detect.result.st.otherConnections[0].origin, 'http://127.0.0.1:8000');
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

const bindingOf = async path => (await api('GET', '/api/status')).result.items.find(i => i.path === path).bindings[0];

test('slot merge: tavern and workspace edit different fields -> merged, then sync writes the merge', async () => {
    await writeFile(join(dir, 'characters/Alice/description.md'), 'merged local');
    await tavern.edit('character', 'Alice.png', d => { d.data.personality = 'tavern personality'; });
    await until(async () => (await readFile(join(dir, 'characters/Alice/personality.md'), 'utf8').catch(() => '')) === 'tavern personality');
    assert.equal((await bindingOf('characters/Alice')).status, 'local-changes');
    assert.equal(await readFile(join(dir, 'characters/Alice/description.md'), 'utf8'), 'merged local');
    const synced = await api('POST', '/api/sync', { path: 'characters/Alice' });
    assert.equal(synced.result.result, 'synced');
    const stored = tavern.store.character.get('Alice.png').data;
    assert.equal(stored.description, 'merged local');
    assert.equal(stored.personality, 'tavern personality');
});

test('slot merge: same field on both sides -> only that slot conflicts; resolving it in the files clears it', async () => {
    await writeFile(join(dir, 'characters/Alice/description.md'), 'L2');
    await tavern.edit('character', 'Alice.png', d => { d.data.description = 'T2'; d.data.scenario = 'tavern scenario'; });
    await until(async () => (await bindingOf('characters/Alice')).status === 'conflict');
    assert.equal(await readFile(join(dir, 'characters/Alice/scenario.md'), 'utf8'), 'tavern scenario', 'other slots still merged');
    const details = (await api('POST', '/api/conflict', { path: 'characters/Alice' })).result;
    assert.deepEqual(details.slots.map(s => [s.slot, s.label, s.workspace.value, s.tavern.value, s.base.value]), [['data.description', '角色描述', 'L2', 'T2', 'merged local']]);
    const blocked = await api('POST', '/api/sync', { path: 'characters/Alice' });
    assert.equal(blocked.error.code, 'conflict');
    assert.match(blocked.error.message, /角色描述/);
    await writeFile(join(dir, 'characters/Alice/description.md'), 'T2');
    await api('POST', '/api/sync', { path: 'characters/Alice' });
    assert.equal((await bindingOf('characters/Alice')).status, 'in-sync');
});

test('slot merge: while a conflict is open, tavern edits of already merged slots still merge (base advanced)', async () => {
    await writeFile(join(dir, 'characters/Alice/description.md'), 'L3');
    await tavern.edit('character', 'Alice.png', d => { d.data.description = 'T3'; d.data.scenario = 'scenario A'; });
    await until(async () => (await bindingOf('characters/Alice')).status === 'conflict');
    await until(async () => (await readFile(join(dir, 'characters/Alice/scenario.md'), 'utf8').catch(() => '')) === 'scenario A');
    // The tavern edits the merged slot again (SillyTavern also rewrites every entry on each save).
    await tavern.edit('character', 'Alice.png', d => { d.data.scenario = 'scenario B'; });
    await until(async () => (await readFile(join(dir, 'characters/Alice/scenario.md'), 'utf8').catch(() => '')) === 'scenario B');
    const details = (await api('POST', '/api/conflict', { path: 'characters/Alice' })).result;
    assert.deepEqual(details.slots.map(s => s.slot), ['data.description']);
    assert.equal(details.slots[0].base.value, 'T2', 'conflicting slot keeps the old base');
    const resolved = await api('POST', '/api/conflict/resolve', { path: 'characters/Alice', choices: { 'data.description': 'workspace' } });
    assert.ok(resolved.ok, JSON.stringify(resolved.error));
    const stored = tavern.store.character.get('Alice.png').data;
    assert.equal(stored.description, 'L3');
    assert.equal(stored.scenario, 'scenario B');
    assert.equal((await bindingOf('characters/Alice')).status, 'in-sync');
});

test('resolve conflict: every slot needs a choice; manual value and tavern edits made meanwhile both survive', async () => {
    await writeFile(join(dir, 'characters/Alice/description.md'), 'L4');
    await tavern.edit('character', 'Alice.png', d => { d.data.description = 'T4'; });
    await until(async () => (await bindingOf('characters/Alice')).status === 'conflict');
    const details = (await api('POST', '/api/conflict', { path: 'characters/Alice' })).result;
    assert.equal(details.kind, 'character');
    assert.deepEqual(details.slots[0].workspace, { value: 'L4', present: true });
    assert.deepEqual(details.slots[0].tavern, { value: 'T4', present: true });
    const missing = await api('POST', '/api/conflict/resolve', { path: 'characters/Alice', choices: {} });
    assert.equal(missing.error.code, 'bad_request');
    // The tavern changes another field after the conflict was found (silently, as merge-attributes would).
    const stored = tavern.store.character.get('Alice.png');
    tavern.store.character.set('Alice.png', { ...stored, data: { ...stored.data, scenario: 'later tavern edit' } });
    const resolved = await api('POST', '/api/conflict/resolve', { path: 'characters/Alice', choices: { 'data.description': { value: 'L4 + T4' } } });
    assert.ok(resolved.result, JSON.stringify(resolved));
    const now = tavern.store.character.get('Alice.png').data;
    assert.deepEqual([now.description, now.scenario], ['L4 + T4', 'later tavern edit']);
    assert.equal(await readFile(join(dir, 'characters/Alice/description.md'), 'utf8'), 'L4 + T4');
    assert.equal((await bindingOf('characters/Alice')).status, 'in-sync');
});

test('resolve conflict: choosing the tavern side writes nothing new to the tavern', async () => {
    await writeFile(join(dir, 'characters/Alice/description.md'), 'L5');
    await tavern.edit('character', 'Alice.png', d => { d.data.description = 'T5'; });
    await until(async () => (await bindingOf('characters/Alice')).status === 'conflict');
    const putsBefore = tavern.puts;
    const resolved = await api('POST', '/api/conflict/resolve', { path: 'characters/Alice', choices: { 'data.description': 'tavern' } });
    assert.equal(resolved.result.result, 'up-to-date');
    assert.equal(tavern.puts, putsBefore);
    assert.equal(await readFile(join(dir, 'characters/Alice/description.md'), 'utf8'), 'T5');
    assert.equal((await bindingOf('characters/Alice')).status, 'in-sync');
});

test('slot merge: the tavern changes again during the merge -> merged again before writing', async () => {
    await writeFile(join(dir, 'characters/Alice/description.md'), 'L3');
    await until(async () => (await bindingOf('characters/Alice')).status === 'local-changes');
    // Silent tavern edits (no item.changed): the first lands before our write, the second before the retried write.
    tavern.beforePut = [d => { d.data.scenario = 'S-first'; }, d => { d.data.mes_example = 'M-second'; }];
    const putsBefore = tavern.puts;
    const result = await api('POST', '/api/sync', { path: 'characters/Alice' });
    assert.equal(result.result?.result, 'merged', JSON.stringify(result));
    assert.equal(tavern.puts, putsBefore + 1);
    const stored = tavern.store.character.get('Alice.png').data;
    assert.deepEqual([stored.description, stored.scenario, stored.mes_example], ['L3', 'S-first', 'M-second']);
    assert.equal((await bindingOf('characters/Alice')).status, 'in-sync');
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

test('reconnect pushes auto-sync edits made while the tavern was away; a changed tavern gets a conflict', async () => {
    let away = new FakeTavern(server.port, { targetId: 'catchup-target' });
    await away.ready;
    const co = await api('POST', '/api/checkout', { target: 'catchup-target', kind: 'lorebook', id: 'Book' });
    const path = co.result.path;
    await api('POST', '/api/auto-sync', { path, target: 'catchup-target', enabled: true });
    away.close();
    await until(async () => !(await api('GET', '/api/status')).result.targets.some(t => t.id === 'catchup-target'));

    const file = join(dir, path, 'entries/0000-c.md');
    await writeFile(file, (await readFile(file, 'utf8')).replace('body', 'edited while away'));
    await sleep(900); // watcher runs; no writable link, so nothing is pushed yet

    const back = new FakeTavern(server.port, { targetId: 'catchup-target' });
    await back.ready;
    await until(() => back.store.lorebook.get('Book').entries[0].content === 'edited while away');
    back.close();
    await until(async () => !(await api('GET', '/api/status')).result.targets.some(t => t.id === 'catchup-target'));

    await writeFile(file, (await readFile(file, 'utf8')).replace('edited while away', 'edited again'));
    await sleep(900);
    away = new FakeTavern(server.port, { targetId: 'catchup-target' }); // fresh store: differs from the last synced version
    away.store.lorebook.get('Book').entries[0].content = 'changed in tavern meanwhile';
    await away.ready;
    await until(async () => {
        const item = (await api('GET', '/api/status')).result.items.find(i => i.path === path);
        return item.bindings[0].status === 'conflict';
    });
    assert.equal(away.store.lorebook.get('Book').entries[0].content, 'changed in tavern meanwhile', 'conflict never overwrites the tavern');
    away.close();
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
