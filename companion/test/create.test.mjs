import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { OfflineLink } from '../src/taverns/offline.js';
import { readCardText } from '../src/taverns/png.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'create-test-token-0123456789';

async function setup(capabilities) {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-create-'));
    const server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
    const tavern = new FakeTavern(server.port, { capabilities });
    const api = async (path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body),
    })).json();
    await tavern.ready;
    return { dir, server, tavern, api, close: async () => { tavern.close(); await server.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('create unbound items, publish them to a tavern, read tavern items without checkout', async () => {
    const t = await setup({ create: 1 });
    try {
        const book = await t.api('/api/create', { kind: 'lorebook', name: 'New Book' });
        assert.equal(book.ok, true, JSON.stringify(book));
        assert.equal(book.result.path, 'lorebooks/New Book');
        const status = await t.api('/api/item', { path: 'lorebooks/New Book' });
        assert.deepEqual(status.result.data, { entries: {} });

        const preset = await t.api('/api/create', { kind: 'preset', name: 'Mine' });
        assert.equal(preset.result.path, 'presets/openai-Mine');
        // chat completion presets are split into prompt files even before they are bound
        assert.ok((await readdir(join(t.dir, 'presets', 'openai-Mine'))).includes('prompts'));

        const card = await t.api('/api/create', { kind: 'character', name: 'Hero' });
        assert.equal(card.ok, true, JSON.stringify(card));
        assert.equal((await t.api('/api/create', { kind: 'character', name: 'a/b' })).error.code, 'bad_request');

        const regex = await t.api('/api/create', { kind: 'regex' });
        assert.equal(regex.ok, true, JSON.stringify(regex));
        assert.equal((await t.api('/api/create', { kind: 'regex' })).error.code, 'bad_request');

        const pub = await t.api('/api/publish', { path: 'presets/openai-Mine', name: 'Mine' });
        assert.equal(pub.ok, true, JSON.stringify(pub));
        assert.equal(pub.result.id, 'openai/Mine');
        assert.ok(t.tavern.store.preset.get('openai/Mine').prompts.length > 5);

        const pubCard = await t.api('/api/publish', { path: 'characters/Hero', name: 'Hero Two' });
        assert.equal(pubCard.ok, true, JSON.stringify(pubCard));
        assert.equal(pubCard.result.id, 'Hero Two.png');
        assert.equal(t.tavern.store.character.get('Hero Two.png').data.name, 'Hero Two');

        const items = (await (await fetch(`http://127.0.0.1:${t.server.port}/api/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).result.items;
        const mine = items.find(i => i.path === 'presets/openai-Mine');
        assert.equal(mine.bindings[0].status, 'in-sync', JSON.stringify(mine));

        assert.equal((await t.api('/api/publish', { path: 'presets/openai-Mine', name: 'Mine' })).error.code, 'bad_request');
        await t.api('/api/create', { kind: 'lorebook', name: 'Dup' });
        t.tavern.store.lorebook.set('Dup', { entries: {} });
        assert.equal((await t.api('/api/publish', { path: 'lorebooks/Dup', name: 'Dup' })).error.code, 'conflict');

        const read = await t.api('/api/tavern/item', { kind: 'preset', id: 'openai/P1' });
        assert.equal(read.ok, true, JSON.stringify(read));
        assert.equal(read.result.checkedOut, null);
        assert.equal(read.result.data.prompts[0].identifier, 'main');
        assert.equal((await t.api('/api/tavern/item', { kind: 'preset', id: 'openai/Mine' })).result.checkedOut, 'presets/openai-Mine');
    } finally {
        await t.close();
    }
});

test('publishing needs a Cellar Link that can create items', async () => {
    const t = await setup({});
    try {
        await t.api('/api/create', { kind: 'lorebook', name: 'B' });
        const res = await t.api('/api/publish', { path: 'lorebooks/B', name: 'B' });
        assert.equal(res.error.code, 'bad_request');
        assert.match(res.error.message, /太旧/);
    } finally {
        await t.close();
    }
});

test('offline item.create writes new files and never replaces one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-offline-create-'));
    try {
        const userDir = join(root, 'default-user');
        await mkdir(join(userDir, 'characters'), { recursive: true });
        const link = new OfflineLink({ userDir, targetId: 'off-1', host: 'st', label: 'ST', key: 'st' }, { backupDir: () => join(root, 'bk'), isRunning: async () => false });
        const card = await link.request('item.create', { kind: 'character', name: 'Neo', data: { name: 'Neo', data: { name: 'Neo' } } });
        assert.equal(card.id, 'Neo.png');
        assert.equal(JSON.parse(readCardText(await readFile(join(userDir, 'characters', 'Neo.png')))).name, 'Neo');
        await assert.rejects(link.request('item.create', { kind: 'character', name: 'Neo', data: {} }), { code: 'conflict' });
        const preset = await link.request('item.create', { kind: 'preset', name: 'P', id: 'openai/P', data: { prompts: [] } });
        assert.deepEqual(preset.data, { prompts: [] });
        assert.deepEqual(JSON.parse(await readFile(join(userDir, 'OpenAI Settings', 'P.json'), 'utf8')), { prompts: [] });
        const book = await link.request('item.create', { kind: 'lorebook', name: 'W', data: { entries: {} } });
        assert.equal(book.id, 'W');
        const running = new OfflineLink({ userDir, targetId: 'off-1', host: 'st', label: 'ST', key: 'st' }, { backupDir: () => null, isRunning: async () => true });
        await assert.rejects(running.request('item.create', { kind: 'lorebook', name: 'X', data: {} }), { code: 'tavern_running' });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
