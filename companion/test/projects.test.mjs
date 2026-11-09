import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'projects-test-token-0123456789';

async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-projects-'));
    const server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
    const tavern = new FakeTavern(server.port, { capabilities: { create: 1 } });
    const api = async (path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: body && JSON.stringify(body),
    })).json();
    const item = async path => (await api('/api/status')).result.items.find(i => i.path === path);
    await tavern.ready;
    return { dir, tavern, api, item, close: async () => { tavern.close(); await server.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('a card and its lorebook go into one project folder, named apart by kind', async () => {
    const t = await setup();
    try {
        t.tavern.store.character.set('诡异复苏.png', { name: '诡异复苏', data: { name: '诡异复苏', description: 'd', alternate_greetings: [], extensions: { world: '诡异复苏' } } });
        t.tavern.store.lorebook.set('诡异复苏', { entries: {} });
        const co = await t.api('/api/checkout', { kind: 'character', id: '诡异复苏.png', withWorld: true, folder: '诡异复苏' });
        assert.equal(co.ok, true, JSON.stringify(co));
        assert.equal(co.result.path, '诡异复苏/诡异复苏');
        assert.deepEqual(co.result.world, { name: '诡异复苏', path: '诡异复苏/诡异复苏（世界书）', checkedOut: true });

        const made = await t.api('/api/create', { kind: 'character', name: 'Hero', world: 'Hero', folder: '英雄' });
        assert.equal(made.ok, true, JSON.stringify(made));
        assert.equal(made.result.path, '英雄/Hero');
        assert.deepEqual(made.result.world, { name: 'Hero', path: '英雄/Hero（世界书）', created: true });
        // The kind label is not part of the lorebook's name: the card finds it, publishing proposes "Hero".
        assert.equal((await t.item('英雄/Hero（世界书）')).name, 'Hero');
        assert.deepEqual((await t.item('英雄/Hero')).world, { name: 'Hero', path: '英雄/Hero（世界书）' });

        assert.equal((await t.api('/api/create', { kind: 'lorebook', name: 'X', folder: 'workshop' })).error.code, 'bad_request');
        assert.equal((await t.api('/api/create', { kind: 'character', name: 'X', folder: 'lorebooks' })).error.code, 'bad_request');
        assert.equal((await t.api('/api/create', { kind: 'character', name: 'X', folder: '.hidden' })).error.code, 'bad_request');
    } finally {
        await t.close();
    }
});

test('moving an item keeps its sync state, tags and history', async () => {
    const t = await setup();
    try {
        await t.api('/api/checkout', { kind: 'character', id: 'Alice.png' });
        await writeFile(join(t.dir, 'characters', 'Alice', 'description.md'), 'v1 text', 'utf8');
        await writeFile(join(t.dir, 'characters', 'Alice', '笔记.md'), 'mine', 'utf8');
        const v1 = (await t.api('/api/history/commit', { message: 'v1' })).result.id;
        assert.equal((await t.api('/api/history/tag', { name: 'keep', path: 'characters/Alice', rev: v1 })).ok, true);

        await mkdir(join(t.dir, 'Proj', 'Alice'), { recursive: true });
        const blocked = await t.api('/api/move', { path: 'characters/Alice', folder: 'Proj' });
        assert.equal(blocked.error?.code, 'conflict', 'a folder already there blocks the move');
        const before = (await t.api('/api/history', { path: 'characters/Alice' })).result.versions.find(v => v.id === v1);
        assert.deepEqual(before.tags, [{ path: 'characters/Alice', name: 'keep' }], 'a refused move leaves the version refs where they were');
        await rm(join(t.dir, 'Proj'), { recursive: true, force: true });

        const moved = await t.api('/api/move', { path: 'characters/Alice', folder: 'Proj' });
        assert.equal(moved.ok, true, JSON.stringify(moved));
        assert.deepEqual(moved.result, { path: 'Proj/Alice', from: 'characters/Alice', result: 'moved' });
        assert.equal(existsSync(join(t.dir, 'characters', 'Alice')), false);
        assert.equal(await readFile(join(t.dir, 'Proj', 'Alice', '笔记.md'), 'utf8'), 'mine', "the user's own files go along");
        assert.equal((await t.item('Proj/Alice')).bindings[0].status, 'local-changes', 'sync state follows the item');

        const h = (await t.api('/api/history', { path: 'Proj/Alice' })).result;
        const recorded = h.versions.find(v => v.id === v1);
        assert.ok(recorded, 'versions from before the move are in the item history');
        assert.ok(recorded.items.includes('Proj/Alice'));
        assert.deepEqual(recorded.tags, [{ path: 'Proj/Alice', name: 'keep' }]);

        await writeFile(join(t.dir, 'Proj', 'Alice', 'description.md'), 'v2 text', 'utf8');
        const restored = await t.api('/api/history/restore', { rev: 'Proj/Alice:keep', path: 'Proj/Alice' });
        assert.equal(restored.ok, true, JSON.stringify(restored));
        assert.equal(await readFile(join(t.dir, 'Proj', 'Alice', 'description.md'), 'utf8'), 'v1 text');
        assert.equal((await t.api('/api/sync', { path: 'Proj/Alice' })).ok, true);
        assert.equal(t.tavern.store.character.get('Alice.png').data.description, 'v1 text');

        const back = await t.api('/api/move', { path: 'Proj/Alice', folder: '' });
        assert.equal(back.result.path, 'characters/Alice', 'its own former path is free for it');
        assert.equal((await t.item('characters/Alice')).bindings[0].status, 'in-sync');
    } finally {
        await t.close();
    }
});

test('import copies Cellar item folders from outside the workspace as unbound items', async () => {
    const t = await setup();
    const ext = await mkdtemp(join(tmpdir(), 'cellar-import-'));
    try {
        await t.api('/api/create', { kind: 'lorebook', name: 'Book' });
        await cp(join(t.dir, 'lorebooks', 'Book'), join(ext, 'Pack', 'Book'), { recursive: true });
        await writeFile(join(ext, 'Pack', 'Book', 'notes.md'), 'n', 'utf8');
        await mkdir(join(ext, 'Pack', 'Book', '.git'));
        await mkdir(join(ext, 'Pack', 'Broken'));
        await writeFile(join(ext, 'Pack', 'Broken', 'cellar-item.json'), '{"kind":"character","codec":5}', 'utf8');
        await writeFile(join(ext, 'Pack', 'Broken', 'card.json'), '{ half written', 'utf8');
        await mkdir(join(ext, 'Pack', 'not-an-item'));

        const r = await t.api('/api/import', { source: join(ext, 'Pack') });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.equal(r.result.folder, 'Pack');
        const byName = Object.fromEntries(r.result.items.map(x => [x.source.split(/[\\/]/).pop(), x]));
        assert.deepEqual(Object.keys(byName).sort(), ['Book', 'Broken']);
        assert.equal(byName.Book.path, 'Pack/Book');
        assert.ok(byName.Broken.error, 'a folder that does not read is reported, not taken in');
        assert.equal(await readFile(join(t.dir, 'Pack', 'Book', 'notes.md'), 'utf8'), 'n');
        assert.equal(existsSync(join(t.dir, 'Pack', 'Book', '.git')), false);
        assert.equal(existsSync(join(t.dir, 'Pack', 'Broken')), false);
        const book = await t.item('Pack/Book');
        assert.deepEqual([book.kind, book.name, book.bindings], ['lorebook', 'Book', []]);

        const again = await t.api('/api/import', { source: join(ext, 'Pack', 'Book'), folder: 'Pack' });
        assert.equal(again.result.items[0].path, 'Pack/Book（世界书）');
    } finally {
        await t.close();
        await rm(ext, { recursive: true, force: true });
    }
});
