import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'preset-test-token-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('preset item: checkout, edit a prompt file, sync; tavern edit of the preset regex merges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-preset-'));
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
        assert.equal(co.ok, true, JSON.stringify(co));
        assert.equal(co.result.path, 'presets/openai-P1');
        const folder = join(dir, 'presets', 'openai-P1');
        assert.deepEqual((await readdir(folder)).sort(), ['cellar-item.json', 'preset.json', 'prompts', 'regex']);
        assert.deepEqual((await readdir(join(folder, 'prompts'))).sort(), ['01-Main.json', '01-Main.md', '02-Style.json', '02-Style.md']);

        await writeFile(join(folder, 'prompts', '02-Style.md'), 'be very brief');
        await tavern.edit('preset', 'openai/P1', d => { d.extensions.regex_scripts[0].disabled = true; });
        await sleep(150);
        assert.equal((await api('/api/pull', { path: 'presets/openai-P1' })).ok, true);
        const synced = await api('/api/sync', { path: 'presets/openai-P1' });
        assert.equal(synced.ok, true, JSON.stringify(synced));
        const stored = tavern.store.preset.get('openai/P1');
        assert.equal(stored.prompts[1].content, 'be very brief');
        assert.equal(stored.extensions.regex_scripts[0].disabled, true);
        assert.equal(JSON.parse(await readFile(join(folder, 'regex', '01-PR1.json'), 'utf8')).disabled, true);

        assert.equal((await api('/api/checkout', { kind: 'preset', id: 'nope' })).error.code, 'bad_request');
    } finally {
        tavern.close();
        await server.close();
        await rm(dir, { recursive: true, force: true });
    }
});
