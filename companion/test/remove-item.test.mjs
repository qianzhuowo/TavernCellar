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
