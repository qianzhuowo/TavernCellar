import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'regex-test-token-0123456789';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('global regex item: checkout, edit the files, sync; tavern edit of another script merges', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-regex-'));
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
        tavern.store.regex.get('global').scripts.push({ id: 'r2', scriptName: 'R2', findRegex: '/x/', replaceString: 'y', placement: [1], disabled: false });

        const co = await api('/api/checkout', { kind: 'regex', id: 'global' });
        assert.equal(co.ok, true, JSON.stringify(co));
        assert.equal(co.result.path, 'regex/global');
        const folder = join(dir, 'regex', 'global');
        assert.deepEqual((await readdir(folder)).sort(), ['01-R1.json', '01-R1.replace.txt', '02-R2.json', '02-R2.replace.txt', 'cellar-item.json']);

        // edit R1's replacement in the workspace; meanwhile the tavern disables R2
        await writeFile(join(folder, '01-R1.replace.txt'), 'B!');
        await tavern.edit('regex', 'global', d => { d.scripts[1].disabled = true; });
        await sleep(150);
        const pulled = await api('/api/pull', { path: 'regex/global' });
        assert.equal(pulled.ok, true, JSON.stringify(pulled));
        const synced = await api('/api/sync', { path: 'regex/global' });
        assert.equal(synced.ok, true, JSON.stringify(synced));
        const stored = tavern.store.regex.get('global').scripts;
        assert.equal(stored[0].replaceString, 'B!');
        assert.equal(stored[1].disabled, true);
        assert.equal(JSON.parse(await readFile(join(folder, '02-R2.json'), 'utf8')).disabled, true);

        // catalog of kind regex lists the single global item, marked as checked out
        const cat = await api('/api/catalog', { kind: 'regex' });
        assert.deepEqual(cat.result.items.map(i => [i.id, i.checkedOut]), [['global', 'regex/global']]);
    } finally {
        tavern.close();
        await server.close();
        await rm(dir, { recursive: true, force: true });
    }
});
