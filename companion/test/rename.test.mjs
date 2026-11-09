import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'rename-test-token-0123456789';

async function setup(capabilities = { create: 1, rename: 1 }) {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-rename-'));
    const server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
    const tavern = new FakeTavern(server.port, { capabilities });
    const api = async (path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: body && JSON.stringify(body),
    })).json();
    const item = async path => (await api('/api/status')).result.items.find(i => i.path === path);
    await tavern.ready;
    return { dir, tavern, api, item, close: async () => { tavern.close(); await server.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('renaming a card with its lorebook renames both in the tavern, relinks the card and moves the folders', async () => {
    const t = await setup();
    try {
        t.tavern.store.character.set('诡异复苏.png', { name: '诡异复苏', data: { name: '诡异复苏', description: 'd', alternate_greetings: [], extensions: { world: '诡异复苏' } } });
        t.tavern.store.lorebook.set('诡异复苏', { entries: { 0: { uid: 0, key: ['k'], comment: 'c', content: 'body' } } });
        await t.api('/api/checkout', { kind: 'character', id: '诡异复苏.png', withWorld: true, folder: '诡异复苏' });
        await writeFile(join(t.dir, '诡异复苏', '诡异复苏', '笔记.md'), 'mine', 'utf8');
        const v1 = (await t.api('/api/history/commit', { message: 'v1' })).result.id;

        const r = await t.api('/api/rename', { path: '诡异复苏/诡异复苏', name: '神秘复苏', withWorld: true });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.result.path, '诡异复苏/神秘复苏');
        assert.deepEqual(r.result.world, { name: '神秘复苏', path: '诡异复苏/神秘复苏（世界书）', from: '诡异复苏/诡异复苏（世界书）', renamed: true });
        assert.deepEqual(r.result.warnings, []);

        const card = t.tavern.store.character.get('神秘复苏.png');
        assert.equal(t.tavern.store.character.has('诡异复苏.png'), false);
        assert.equal(card.data.name, '神秘复苏');
        assert.equal(card.data.extensions.world, '神秘复苏', 'the tavern card links to the renamed book');
        assert.equal(t.tavern.store.lorebook.has('诡异复苏'), false);
        assert.ok(t.tavern.store.lorebook.has('神秘复苏'));

        const status = await t.item('诡异复苏/神秘复苏');
        assert.deepEqual(status.bindings.map(b => [b.id, b.status]), [['神秘复苏.png', 'in-sync']]);
        assert.deepEqual(status.world, { name: '神秘复苏', path: '诡异复苏/神秘复苏（世界书）' });
        assert.deepEqual((await t.item('诡异复苏/神秘复苏（世界书）')).bindings.map(b => [b.id, b.status]), [['神秘复苏', 'in-sync']]);
        const data = (await t.api('/api/item', { path: '诡异复苏/神秘复苏' })).result.data;
        assert.equal(data.data.name, '神秘复苏');
        assert.equal(data.data.extensions.world, '神秘复苏');
        assert.equal(existsSync(join(t.dir, '诡异复苏', '神秘复苏', '笔记.md')), true, "the user's own files go along");

        const h = (await t.api('/api/history', { path: '诡异复苏/神秘复苏' })).result;
        assert.ok(h.versions.find(v => v.id === v1)?.items.includes('诡异复苏/神秘复苏'), 'versions from before the rename are in the item history');
    } finally {
        await t.close();
    }
});

test('a rename is refused before anything changes unless every binding is live, in sync and supports it', async () => {
    const t = await setup();
    try {
        await t.api('/api/checkout', { kind: 'character', id: 'Alice.png' });
        await writeFile(join(t.dir, 'characters', 'Alice', 'description.md'), 'edited', 'utf8');
        const unsynced = await t.api('/api/rename', { path: 'characters/Alice', name: 'Bob' });
        assert.equal(unsynced.error?.code, 'bad_request', JSON.stringify(unsynced));
        assert.equal((await t.api('/api/sync', { path: 'characters/Alice' })).ok, true);

        t.tavern.close();
        await new Promise(resolve => setTimeout(resolve, 100));
        const offline = await t.api('/api/rename', { path: 'characters/Alice', name: 'Bob' });
        assert.equal(offline.error?.code, 'bad_request', JSON.stringify(offline));
        assert.ok(t.tavern.store.character.has('Alice.png'));
        assert.equal(t.tavern.renames, undefined);
        assert.deepEqual((await t.item('characters/Alice')).bindings.map(b => b.id), ['Alice.png']);
    } finally {
        await t.close();
    }
});

test('an older Cellar Link without item.rename is asked to update', async () => {
    const t = await setup({ create: 1 });
    try {
        await t.api('/api/checkout', { kind: 'lorebook', id: 'Book' });
        const r = await t.api('/api/rename', { path: 'lorebooks/Book', name: 'Atlas' });
        assert.equal(r.error?.code, 'bad_request');
        assert.match(r.error.message, /太旧/);
        assert.equal(t.tavern.renames, undefined);
        assert.ok(existsSync(join(t.dir, 'lorebooks', 'Book')));
    } finally {
        await t.close();
    }
});

test('a rename that timed out but happened in the tavern still moves the binding to the new name', async () => {
    const t = await setup();
    try {
        await t.api('/api/checkout', { kind: 'character', id: 'Alice.png' });
        t.tavern.renameTimesOut = true;
        const r = await t.api('/api/rename', { path: 'characters/Alice', name: 'Bob' });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual((await t.item(r.result.path)).bindings.map(b => [b.id, b.status]), [['Bob.png', 'in-sync']]);
    } finally {
        await t.close();
    }
});
