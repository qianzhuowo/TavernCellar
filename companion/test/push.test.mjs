// Deploying versions (docs/versioning.md §3): each binding follows the workspace or is pinned at a version.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'test-token-push-0123456789ab';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let dir, server, st, tt;

const api = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: body && JSON.stringify(body),
    });
    return res.json();
};
const until = async (fn, ms = 4000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await sleep(50); }
    throw new Error('condition not reached');
};
const desc = () => join(dir, 'characters', 'Alice', 'description.md');
const binding = async target => (await api('/api/status')).result.items.find(i => i.path === 'characters/Alice').bindings.find(b => b.target === target);
const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.result; };

before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cellar-push-'));
    const ws = await Workspace.init(dir);
    server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: ws, log: () => {}, watch: false, persistConfig: async () => {},
    });
    st = new FakeTavern(server.port, { targetId: 'st-target', host: 'st' });
    tt = new FakeTavern(server.port, { targetId: 'tt-target', host: 'tt', origin: 'http://tauri.localhost' });
    await Promise.all([st.ready, tt.ready]);
    // The same character in both taverns: checkout from st, bind tt (identical data -> in sync).
    ok(await api('/api/checkout', { target: 'st-target', kind: 'character', id: 'Alice.png' }));
    assert.equal(ok(await api('/api/bind', { path: 'characters/Alice', target: 'tt-target', id: 'Alice.png' })).result, 'in-sync');
});

after(async () => {
    st?.close();
    tt?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
});

test('push a tagged version to one tavern: written there, the workspace stays, the binding is pinned', async () => {
    await writeFile(desc(), 'v1 release');
    ok(await api('/api/history/commit', { message: 'release' }));
    ok(await api('/api/history/tag', { name: 'v1.0', path: 'characters/Alice' }));
    await writeFile(desc(), 'v2 work in progress');
    ok(await api('/api/history/commit', { message: 'wip' }));

    const r = ok(await api('/api/push', { rev: 'v1.0', target: 'tt-target' }));
    assert.equal(r.name, 'v1.0');
    assert.deepEqual(r.results.map(x => [x.path, x.result]), [['characters/Alice', 'pushed']]);
    assert.equal(tt.store.character.get('Alice.png').data.description, 'v1 release');
    assert.equal(await readFile(desc(), 'utf8'), 'v2 work in progress', 'the workspace is not touched');

    const b = await binding('tt-target');
    assert.equal(b.status, 'in-sync', 'a pinned binding is in sync with its version, not "unsynced"');
    assert.deepEqual(b.pinned, { rev: r.rev, name: 'v1.0', ahead: true });
    assert.equal(b.deployed, r.rev);
    const h = ok(await api('/api/history', {}));
    assert.ok(h.deployed.some(d => d.target === 'tt-target' && d.rev === r.rev && d.pinned));
    // st still follows the workspace
    const s = await binding('st-target');
    assert.equal(s.pinned, undefined);
    assert.equal(s.status, 'local-changes');
});

test('a pinned binding is skipped by sync and auto-sync; the other tavern follows', async () => {
    const sync = await api('/api/sync', { path: 'characters/Alice', target: 'tt-target' });
    assert.equal(sync.error.code, 'bad_request');
    assert.match(sync.error.message, /跟随最新/);
    ok(await api('/api/auto-sync', { path: 'characters/Alice', target: 'tt-target', enabled: true }));
    ok(await api('/api/auto-sync', { path: 'characters/Alice', target: 'st-target', enabled: true }));
    const puts = tt.puts;
    await writeFile(desc(), 'v3 auto');
    await server.engine.onFilesChanged('characters/Alice');
    assert.equal(st.store.character.get('Alice.png').data.description, 'v3 auto', 'the following tavern got it');
    assert.equal(tt.puts, puts, 'the pinned tavern did not');
    assert.equal(tt.store.character.get('Alice.png').data.description, 'v1 release');
});

test('an edit in the pinned tavern is noted, not pulled; pushing again over it needs force', async () => {
    const before = await readFile(desc(), 'utf8');
    await tt.edit('character', 'Alice.png', d => { d.data.scenario = 'played in tt'; });
    await until(async () => (await binding('tt-target')).status === 'tavern-changes');
    assert.equal(await readFile(desc(), 'utf8'), before, 'the workspace is not touched');
    const r = ok(await api('/api/push', { rev: 'v1.0', target: 'tt-target' }));
    assert.equal(r.results[0].result, 'tavern-changed');
    assert.equal(tt.store.character.get('Alice.png').data.scenario, 'played in tt', 'not overwritten');
    const forced = ok(await api('/api/push', { rev: 'v1.0', target: 'tt-target', paths: ['characters/Alice'], force: true }));
    assert.equal(forced.results[0].result, 'pushed');
    assert.equal(tt.store.character.get('Alice.png').data.scenario, undefined);
    assert.equal((await binding('tt-target')).status, 'in-sync');
});

test('pulling from a pinned tavern merges its edits since the version into the workspace and follows again', async () => {
    await tt.edit('character', 'Alice.png', d => { d.data.scenario = 'played in tt again'; });
    await until(async () => (await binding('tt-target')).status === 'tavern-changes');
    const r = ok(await api('/api/pull', { path: 'characters/Alice', target: 'tt-target' }));
    assert.equal(r.result, 'merged', JSON.stringify(r));
    const card = JSON.parse(await readFile(join(dir, 'characters', 'Alice', 'card.json'), 'utf8'));
    const scenario = card.data?.scenario ?? await readFile(join(dir, 'characters', 'Alice', 'scenario.md'), 'utf8').catch(() => undefined);
    assert.equal(scenario, 'played in tt again', 'the tavern edit came in');
    assert.equal(await readFile(desc(), 'utf8'), 'v3 auto', 'the workspace kept its own later edits');
    const b = await binding('tt-target');
    assert.equal(b.pinned, undefined, 'follows the workspace again');
    const h = ok(await api('/api/history', {}));
    assert.equal(h.versions[0].draft, true, 'the pulled edit joins the draft');
});

test('follow ends a pin; an auto-sync binding syncs right away', async () => {
    ok(await api('/api/push', { rev: 'v1.0', target: 'tt-target', force: true }));
    assert.ok((await binding('tt-target')).pinned);
    const r = ok(await api('/api/follow', { path: 'characters/Alice', target: 'tt-target' }));
    assert.equal(r.result, 'following');
    assert.equal(r.sync, 'synced');
    assert.equal(tt.store.character.get('Alice.png').data.description, 'v3 auto');
    const b = await binding('tt-target');
    assert.equal(b.pinned, undefined);
    assert.equal(b.status, 'in-sync');
});

test('push reports what cannot be pushed', async () => {
    assert.equal((await api('/api/push', { rev: 'nope', target: 'tt-target' })).error.code, 'not_found');
    assert.equal((await api('/api/push', { rev: 'v1.0', target: 'tt-target', paths: ['characters/Nobody'] })).error.code, 'not_found');
    const first = ok(await api('/api/history', { limit: 500 })).versions.at(-1);
    assert.equal(first.message, '开始版本记录');
    // The first version predates the checkout: no item bound to tt exists there.
    assert.equal((await api('/api/push', { rev: first.id, target: 'tt-target' })).error.code, 'bad_request');
});

test('unbinding a pinned binding forgets the pin', async () => {
    ok(await api('/api/unbind', { path: 'characters/Alice', target: 'tt-target' }));
    const manifest = JSON.parse(await readFile(join(dir, 'cellar.json'), 'utf8'));
    assert.equal(manifest.items[0].bindings['tt-target'], undefined);
});
