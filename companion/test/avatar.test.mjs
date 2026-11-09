import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { placeholderPng } from '../src/taverns/png.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'avatar-test-token-0123456789';
const IMAGE = placeholderPng().toString('base64');

async function setup(capabilities) {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-avatar-'));
    const server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
    const tavern = new FakeTavern(server.port, { capabilities });
    const api = async (path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: body && JSON.stringify(body),
    })).json();
    await tavern.ready;
    return { tavern, api, close: async () => { tavern.close(); await server.close(); await rm(dir, { recursive: true, force: true }); } };
}

test('changing the avatar replaces the image in the tavern and leaves the card and its sync state alone', async () => {
    const t = await setup({ avatar: 1 });
    try {
        await t.api('/api/checkout', { kind: 'character', id: 'Alice.png' });
        const card = structuredClone(t.tavern.store.character.get('Alice.png'));
        const r = await t.api('/api/avatar', { path: 'characters/Alice', image: IMAGE });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.result.ids, { 'fake-target-1': 'Alice.png' });
        assert.equal(t.tavern.avatars['Alice.png'], IMAGE);
        assert.deepEqual(t.tavern.store.character.get('Alice.png'), card);
        const item = (await t.api('/api/status')).result.items.find(i => i.path === 'characters/Alice');
        assert.deepEqual(item.bindings.map(b => b.status), ['in-sync']);
        assert.equal(t.tavern.puts, 0);
        assert.equal((await t.api('/api/avatar', { path: 'characters/Alice', image: 'bm90IGEgcG5n' })).error?.code, 'bad_request');
    } finally {
        await t.close();
    }
});

test('the avatar is not changed anywhere unless every binding can take it', async () => {
    const t = await setup({});
    try {
        await t.api('/api/checkout', { kind: 'character', id: 'Alice.png' });
        const old = await t.api('/api/avatar', { path: 'characters/Alice', image: IMAGE });
        assert.equal(old.error?.code, 'bad_request', JSON.stringify(old));
        assert.match(old.error.message, /太旧/);
        t.tavern.close();
        await new Promise(resolve => setTimeout(resolve, 100));
        const gone = await t.api('/api/avatar', { path: 'characters/Alice', image: IMAGE });
        assert.equal(gone.error?.code, 'bad_request', JSON.stringify(gone));
        assert.equal(t.tavern.avatars, undefined);
    } finally {
        await t.close();
    }
});
