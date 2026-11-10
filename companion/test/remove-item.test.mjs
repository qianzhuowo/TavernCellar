import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'remove-test-token-0123456789';
const exists = p => stat(p).then(() => true, () => false);

test('remove: item leaves the workspace, codec files go, own notes stay, tavern untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-remove-'));
    const server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
    const tavern = new FakeTavern(server.port);
    const api = async (path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body),
    })).json();
    const paths = async () => (await api('/api/status')).result.items.map(i => i.path);
    try {
        await tavern.ready;
        const before = JSON.stringify(tavern.store.preset.get('openai/P1'));
        const co = await api('/api/checkout', { kind: 'preset', id: 'openai/P1' });
        assert.equal(co.ok, true, JSON.stringify(co));
        const path = co.result.path;
        const folder = join(dir, ...path.split('/'));
        const target = Object.keys(JSON.parse(await readFile(join(dir, '.cellar', 'state.json'), 'utf8')).items[path])[0];
        assert.ok(await exists(join(dir, '.cellar', 'base', ...path.split('/'), `${target}.json`)));
        assert.deepEqual(tavern.watch, [{ kind: 'preset', id: 'openai/P1' }]);
        await writeFile(join(folder, '调研.md'), 'my notes');
        await writeFile(join(folder, '.private'), 'hidden');

        const r = await api('/api/remove', { path });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.result.kept, ['调研.md']);
        assert.ok(!(await paths()).includes(path));
        assert.deepEqual((await readdir(folder)).sort(), ['.private', '调研.md']);
        assert.equal(JSON.parse(await readFile(join(dir, '.cellar', 'state.json'), 'utf8')).items[path], undefined);
        assert.equal(await exists(join(dir, '.cellar', 'base', ...path.split('/'))), false);
        assert.deepEqual(tavern.watch, []);
        assert.equal(JSON.stringify(tavern.store.preset.get('openai/P1')), before);

        // Checking out again reuses the folder; the notes are still there.
        const again = await api('/api/checkout', { kind: 'preset', id: 'openai/P1' });
        assert.equal(again.result.path, path);
        assert.ok((await readdir(folder)).includes('preset.json'));
        assert.ok((await readdir(folder)).includes('调研.md'));

        // keepFiles: only the bookkeeping goes.
        const kept = await api('/api/remove', { path, keepFiles: true });
        assert.equal(kept.ok, true, JSON.stringify(kept));
        assert.equal(kept.result.kept, null);
        assert.ok((await readdir(folder)).includes('preset.json'));
        assert.ok(!(await paths()).includes(path));

        assert.equal((await api('/api/remove', { path })).error.code, 'not_found');
    } finally {
        tavern.close();
        await server.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('remove: a folder with only codec files is deleted entirely', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-remove2-'));
    const server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
    const tavern = new FakeTavern(server.port);
    const api = async (path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
    })).json();
    try {
        await tavern.ready;
        const co = await api('/api/checkout', { kind: 'preset', id: 'openai/P1' });
        const r = await api('/api/remove', { path: co.result.path });
        assert.deepEqual(r.result.kept, []);
        assert.equal(await exists(join(dir, 'presets', 'openai-P1')), false);
        assert.equal(await exists(join(dir, 'presets')), true, 'the kind folder itself stays');
    } finally {
        tavern.close();
        await server.close();
        await rm(dir, { recursive: true, force: true });
    }
});

test('remove: the removal is recorded as its own version, other draft edits stay in the draft', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-remove3-'));
    const start = async () => startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
    await Workspace.init(dir);
    let server = await start();
    let tavern = new FakeTavern(server.port);
    const api = async (path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body ?? {}),
    })).json();
    const draftItems = async () => (await api('/api/history', {})).result.draft.items.filter(p => p.includes('/'));
    try {
        await tavern.ready;
        const preset = (await api('/api/checkout', { kind: 'preset', id: 'openai/P1' })).result.path;
        const book = (await api('/api/checkout', { kind: 'lorebook', id: 'Book' })).result.path;
        assert.equal((await api('/api/history/commit', { message: 'v1' })).ok, true);
        // Unsaved edits in both, then the preset goes.
        await writeFile(join(dir, ...preset.split('/'), 'notes.md'), 'draft note');
        const bookFile = (await readdir(join(dir, ...book.split('/')), { recursive: true })).find(f => f.endsWith('.md'));
        await writeFile(join(dir, ...book.split('/'), bookFile), 'edited entry\n');
        assert.deepEqual((await draftItems()).sort(), [book, preset].sort());

        assert.equal((await api('/api/remove', { path: preset })).ok, true);
        assert.deepEqual(await draftItems(), [book], 'only the book is left in the draft');
        const versions = (await api('/api/history', {})).result.versions;
        const removal = versions.find(v => v.message === '从工作区移除「openai-P1」');
        assert.ok(removal, JSON.stringify(versions.map(v => v.message)));
        assert.deepEqual(removal.items.filter(p => p.includes('/')), [preset]);
        assert.equal(versions[0].draft, true, 'the book edit is a draft on top of the removal');

        // A removal left in the draft by an older version (files and manifest entry gone without recording) is
        // recorded when the companion opens the workspace.
        tavern.close();
        await server.close();
        const ws = await Workspace.init(dir);
        await rm(join(dir, ...book.split('/')), { recursive: true, force: true });
        ws.manifest.items = ws.manifest.items.filter(i => i.path !== book);
        await ws.saveManifest();
        server = await start();
        tavern = new FakeTavern(server.port);
        assert.deepEqual(await draftItems(), []);
        assert.ok((await api('/api/history', {})).result.versions.some(v => v.message === '从工作区移除「Book」'));
    } finally {
        tavern.close();
        await server.close();
        await rm(dir, { recursive: true, force: true });
    }
});
