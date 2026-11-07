import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';

// 撤回 / 取消撤回 / 撤销当前的修改 (docs/versioning.md §6): undo steps live in the companion, per item.
const TOKEN = 'test-token-undo-0123456789abcdef';
let dir, server;

const api = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: body && JSON.stringify(body),
    });
    return res.json();
};
const ok = async (path, body) => {
    const r = await api(path, body);
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.result;
};
const entries = async path => Object.values((await ok('/api/item', { path })).data.entries).map(e => e.comment).sort();
const edits = async path => (await ok('/api/status')).items.find(i => i.path === path).edits;
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cellar-undo-'));
    server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
});

after(async () => {
    await server?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

let book;
const addEntry = async comment => {
    const { hash } = await ok('/api/item', { path: book });
    return ok('/api/item/entries', { path: book, hash, ops: [{ op: 'create', entry: { comment } }] });
};

test('undo takes back a new entry, redo brings it back; a new edit drops the redo steps', async () => {
    book = (await ok('/api/create', { kind: 'lorebook', name: 'Undo_Book' })).path;
    assert.deepEqual(await edits(book), { undo: false, redo: false });
    await addEntry('one');
    await sleep(UNDO_GAP);
    await addEntry('two');
    assert.deepEqual(await entries(book), ['one', 'two']);
    assert.deepEqual(await edits(book), { undo: true, redo: false });

    await ok('/api/item/undo', { path: book });
    assert.deepEqual(await entries(book), ['one']);
    assert.deepEqual(await edits(book), { undo: true, redo: true });
    await ok('/api/item/redo', { path: book });
    assert.deepEqual(await entries(book), ['one', 'two']);

    await ok('/api/item/undo', { path: book });
    await sleep(UNDO_GAP);
    await addEntry('three');
    assert.deepEqual(await edits(book), { undo: true, redo: false }, 'a new edit after undo clears redo');
    const r = await api('/api/item/redo', { path: book });
    assert.equal(r.ok, false);
});

const UNDO_GAP = 1600;

test('auto-saves in quick succession are one undo step', async () => {
    await sleep(UNDO_GAP);
    await addEntry('a');
    await addEntry('b');
    await ok('/api/item/undo', { path: book });
    assert.deepEqual(await entries(book), ['one', 'three']);
});

test('a change made elsewhere is never undone across: the stack is dropped', async () => {
    await sleep(UNDO_GAP);
    await addEntry('c');
    const file = join(dir, ...book.split('/'), 'book.json');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace(/\n$/, '') + ' \n');
    assert.deepEqual(await edits(book), { undo: false, redo: false });
    const r = await api('/api/item/undo', { path: book });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'conflict');
    assert.match(r.error.message, /别处被修改/);
});

test('撤销当前的修改 before any version: back to how the item was when it was created', async () => {
    assert.ok((await entries(book)).length > 0);
    await ok('/api/item/revert', { path: book });
    assert.deepEqual(await entries(book), [], 'a new lorebook has no entries');
    await ok('/api/item/undo', { path: book });
    assert.ok((await entries(book)).length > 0, 'the revert can be undone');
});

test('撤销当前的修改 goes back to the last recorded version and can itself be undone', async () => {
    await ok('/api/history/commit', { message: 'book v1' });
    const recorded = await entries(book);
    await sleep(UNDO_GAP);
    await addEntry('draft-only');
    assert.notDeepEqual(await entries(book), recorded);
    await ok('/api/item/revert', { path: book });
    assert.deepEqual(await entries(book), recorded);
    const h = await ok('/api/history', {});
    assert.ok(!h.draft.items.includes(book), 'the item left the draft');
    await ok('/api/item/undo', { path: book });
    assert.ok((await entries(book)).includes('draft-only'));
});

test('an item taken out again after it was removed goes back to the new copy, not the old recorded one', async () => {
    await ok('/api/remove', { path: book });
    const again = (await ok('/api/create', { kind: 'lorebook', name: 'Undo_Book' })).path;
    assert.equal(again, book, 'same folder as before');
    await sleep(UNDO_GAP);
    await addEntry('new-copy');
    await ok('/api/item/revert', { path: book });
    assert.deepEqual(await entries(book), [], 'the origin of this draft wins over the recorded version of the old item');
});

test('压缩历史 over the API: storage shows what can go, compact removes it and records when', async () => {
    const before = await ok('/api/history/storage');
    assert.equal(before.unusedFiles, 0, 'what was just replaced is not offered yet (younger than ten minutes)');
    const r = await ok('/api/history/compact', {});
    assert.equal(r.removed, before.unusedFiles, 'compact removes exactly what storage offered');
    const after = await ok('/api/history/storage');
    assert.equal(after.packs, 1);
    assert.ok(after.compacted && after.compacted.at && !after.compacted.reason);
    assert.ok((await ok('/api/history', {})).versions.length > 0);
});
