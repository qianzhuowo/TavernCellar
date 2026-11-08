import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'test-token-history-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let dir, server, tavern;

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
const history = async (body = {}) => (await api('/api/history', body)).result;
const deployedRev = async () => (await api('/api/status')).result.items[0].bindings[0].deployed;

before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cellar-history-'));
    // An existing workspace from phase 1: a file was there before versioning started.
    const ws = await Workspace.init(dir);
    server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: ws, log: () => {}, watch: false, persistConfig: async () => {},
    });
    tavern = new FakeTavern(server.port);
    await tavern.ready;
});

after(async () => {
    tavern?.close();
    await server?.close();
    await rm(dir, { recursive: true, force: true });
});

test('the workspace starts its history; a checkout goes into the draft, deployed there, until the user records it', async () => {
    let h = await history();
    // Connecting the tavern recorded it in cellar.json: that is a draft change, but not an item change.
    assert.equal(h.versions.at(-1).message, '开始版本记录');
    assert.deepEqual(h.draft.items.filter(p => p.includes('/')), []);
    const co = await api('/api/checkout', { kind: 'character', id: 'Alice.png' });
    assert.equal(co.ok, true, JSON.stringify(co));
    h = await history();
    assert.equal(h.versions[0].draft, true, 'no version of its own');
    assert.equal(h.versions[1].message, '开始版本记录');
    assert.ok(h.draft.items.includes('characters/Alice'));
    assert.deepEqual(h.deployed.map(d => [d.path, d.rev]), [['characters/Alice', h.versions[0].id]]);
    assert.equal(await deployedRev(), h.versions[0].id);
    const rec = await api('/api/history/commit', { message: '取出 Alice' });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    h = await history();
    assert.equal(h.draft.id, null);
    assert.equal(h.deployed[0].shownAt, rec.result.id, 'the deployed draft is shown on the version it became');
    assert.equal(h.deployed[0].earlier, undefined);
});

test('edit -> record version -> sync: the deployed pointer follows; syncing an unrecorded draft deploys the draft', async () => {
    await writeFile(desc(), 'v2');
    let h = await history();
    assert.deepEqual(h.draft.items, ['characters/Alice']);
    const rec = await api('/api/history/commit', { message: '加了背景' });
    assert.equal(rec.ok, true, JSON.stringify(rec));
    assert.equal((await api('/api/history/commit', { message: 'again' })).error.code, 'bad_request', 'nothing new to record');
    await api('/api/sync', { path: 'characters/Alice' });
    assert.equal(tavern.store.character.get('Alice.png').data.description, 'v2');
    assert.equal(await deployedRev(), rec.result.id);

    await writeFile(desc(), 'v3 draft');
    await api('/api/sync', { path: 'characters/Alice' });
    h = await history();
    assert.equal(h.versions[0].draft, true);
    assert.equal(await deployedRev(), h.versions[0].id, 'deployed at the draft as synced');
    const before = h.versions.length;
    await api('/api/history/describe', { message: '草稿说明' });
    h = await history();
    assert.equal(h.versions[0].message, '草稿说明');
    assert.equal(h.versions.length, before, 'describe amends, no new version');
    // The deployed draft was replaced by the amend: it is shown on the version it became. Only the description
    // changed, so the tavern has exactly that version; a later content change makes it an earlier state.
    assert.equal(h.deployed[0].shownAt, h.versions[0].id);
    assert.equal(h.deployed[0].earlier, undefined);
    await writeFile(desc(), 'v3 draft, edited after the sync');
    h = await history();
    assert.equal(h.deployed[0].shownAt, h.versions[0].id);
    assert.equal(h.deployed[0].earlier, true);
});

test('a tavern edit joins the user\'s draft instead of ending it', async () => {
    await writeFile(desc(), 'v3 draft');
    const count = (await history()).versions.length;
    await tavern.edit('character', 'Alice.png', d => { d.data.personality = 'from tavern'; });
    const personality = async h => (await api('/api/history/diff', { from: h.versions[1].id, to: h.versions[0].id })).result.items[0]?.slots.find(s => s.slot === 'data.personality')?.to.value;
    await until(async () => (await personality(await history())) === 'from tavern');
    const h = await history();
    assert.equal(h.versions.length, count, 'no new version');
    assert.equal(h.versions[0].draft, true);
    assert.equal(h.versions[0].message, '草稿说明', 'the draft keeps its description');
    assert.equal(await deployedRev(), h.versions[0].id);
    assert.equal((await api('/api/history/commit', { message: '酒馆改了性格' })).ok, true);
});

test('field-level diff between versions and restoring an old version, then syncing it', async () => {
    const h = await history({ path: 'characters/Alice' });
    const checkout = h.versions.find(v => v.message === '取出 Alice');
    const diff = (await api('/api/history/diff', { from: checkout.id, to: h.versions[0].id })).result;
    const alice = diff.items.find(i => i.path === 'characters/Alice');
    const bySlot = Object.fromEntries(alice.slots.map(s => [s.slot, s]));
    assert.equal(bySlot['data.description'].from.value, 'orig');
    assert.equal(bySlot['data.description'].to.value, 'v3 draft');
    assert.equal(bySlot['data.personality'].to.value, 'from tavern');
    assert.ok(bySlot['data.description'].label);

    const restored = await api('/api/history/restore', { rev: checkout.id.slice(0, 8), path: 'characters/Alice' });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.equal(await readFile(desc(), 'utf8'), 'orig');
    const status = (await api('/api/status')).result;
    assert.equal(status.items[0].bindings[0].status, 'local-changes', 'restoring only changes the workspace');
    assert.deepEqual(status.draft.items, ['characters/Alice']);
    await api('/api/sync', { path: 'characters/Alice' });
    assert.equal(tavern.store.character.get('Alice.png').data.description, 'orig');
    assert.equal(tavern.store.character.get('Alice.png').data.personality, undefined);
    assert.equal(await deployedRev(), (await history()).versions[0].id);
});

test('a sync that merges tavern edits puts them into the draft with the user\'s edit', async () => {
    await writeFile(desc(), 'local edit before merge');
    // The tavern changed another field without telling us (e.g. edited while the companion was not running).
    const current = structuredClone(tavern.store.character.get('Alice.png'));
    current.data.scenario = 'tavern scenario';
    tavern.store.character.set('Alice.png', current);
    const r = await api('/api/sync', { path: 'characters/Alice' });
    assert.equal(r.result.result, 'merged', JSON.stringify(r));
    const h = await history();
    assert.equal(h.versions[0].draft, true);
    const slots = (await api('/api/history/diff', { from: h.versions[1].id, to: h.versions[0].id })).result.items[0].slots.map(s => s.slot);
    assert.ok(slots.includes('data.scenario') && slots.includes('data.description'), 'one draft holds both sides');
    assert.equal(await deployedRev(), h.versions[0].id);
    assert.equal(tavern.store.character.get('Alice.png').data.description, 'local edit before merge');
});

test('tags belong to items; unknown versions and items are reported', async () => {
    const before = await history();
    assert.ok(before.draft.id, 'the merge left a draft');
    const tag = await api('/api/history/tag', { name: 'v1.0', path: 'characters/Alice', rev: before.draft.id, message: '贴标签的存档' });
    assert.equal(tag.ok, true, JSON.stringify(tag));
    const h = await history();
    assert.deepEqual(h.versions[0].tags, [{ path: 'characters/Alice', name: 'v1.0' }]);
    assert.equal(h.versions[0].draft, false, 'tagging the draft records it');
    assert.equal(h.versions[0].message, '贴标签的存档', 'with the description typed');
    assert.equal(h.draft.id, null);
    assert.equal((await api('/api/history/tag', { name: 'v1.0', path: 'characters/Alice' })).error.code, 'bad_request');
    assert.equal((await api('/api/history/tag', { name: 'v2' })).error.code, 'bad_request', 'a tag needs an item');
    assert.equal((await api('/api/history/tag', { name: 'has space', path: 'characters/Alice' })).error.code, 'bad_request');
    const described = await api('/api/history/describe', { rev: h.versions[0].id, message: '后来改的说明' });
    assert.equal(described.result.id, h.versions[0].id, 'the version keeps its id');
    assert.equal((await history()).versions[0].message, '后来改的说明');
    assert.equal((await api('/api/history/diff', { from: 'nope' })).error.code, 'not_found');
    assert.equal((await api('/api/history/restore', { rev: 'v1.0', path: 'characters/Nobody' })).ok, false);
});

test('unbinding drops the deployed pointer', async () => {
    await api('/api/unbind', { path: 'characters/Alice' });
    assert.deepEqual((await history()).deployed, []);
});

test('预设工坊: an item as of a version, and the prompt collection guarded by its hash', async () => {
    const h = await history();
    const first = h.versions.at(-1).id; // 开始版本记录: no items yet
    const now = await api('/api/history/item', { rev: 'HEAD', path: 'characters/Alice' });
    assert.equal(now.ok, true, JSON.stringify(now));
    assert.equal(now.result.kind, 'character');
    assert.equal(typeof now.result.data.data.name, 'string');
    assert.equal((await api('/api/history/item', { rev: first, path: 'characters/Alice' })).error.code, 'not_found');
    assert.equal((await api('/api/history/item', { rev: 'HEAD', path: 'nowhere/x' })).error.code, 'bad_request');

    const put = async body => (await fetch(`http://127.0.0.1:${server.port}/api/workshop/collection`, {
        method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
    })).json();
    const empty = (await api('/api/workshop/collection', {})).result;
    assert.deepEqual(empty.collection, { version: 1, prompts: [] });
    const collection = { version: 1, prompts: [{ id: 'a', title: '文风', prompt: { identifier: 'x', name: '文风', content: '短句' } }] };
    const w = await put({ collection, hash: empty.hash });
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal((await put({ collection, hash: empty.hash })).error.code, 'conflict', 'stale hash');
    assert.equal((await put({ collection: { prompts: [1] }, hash: w.result.hash })).error.code, 'bad_request');
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'workshop', 'prompts.json'), 'utf8')), collection);
    const back = (await api('/api/workshop/collection', {})).result;
    assert.equal(back.hash, w.result.hash);
});
