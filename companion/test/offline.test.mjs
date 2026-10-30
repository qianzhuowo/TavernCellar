import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ERR } from '../../shared/protocol.js';
import { Workspace } from '../src/workspace/workspace.js';
import { SyncEngine } from '../src/sync.js';
import { TargetRegistry } from '../src/targets.js';
import { OfflineLink } from '../src/taverns/offline.js';
import { resolveLocations } from '../src/taverns/locations.js';
import { startServer } from '../src/server.js';

const TARGET = 'offline-target-1';
let root, dataRoot, worldFile, ws, engine, targets, running = false;

const book = content => ({ entries: { 0: { uid: 0, key: ['k'], comment: 'c', content } } });
const writeWorld = data => writeFile(worldFile, JSON.stringify(data, null, 4));
const statusOf = async () => (await engine.status()).items.find(i => i.path === 'lorebooks/Book').bindings[0];

before(async () => {
    root = await mkdtemp(join(tmpdir(), 'cellar-offline-'));
    dataRoot = join(root, 'tt-data');
    const user = join(dataRoot, 'default-user');
    await mkdir(join(user, 'characters'), { recursive: true });
    await mkdir(join(user, 'worlds'), { recursive: true });
    await writeFile(join(user, 'settings.json'), JSON.stringify({ extension_settings: { tavernCellar: { targetId: TARGET, label: 'Test tt' } } }));
    worldFile = join(user, 'worlds', 'Book.json');
    await writeWorld(book('one'));

    const [loc] = await resolveLocations({ st: [], tt: [{ install: '', data: dataRoot }] });
    assert.equal(loc.error, null);
    assert.equal(loc.targetId, TARGET);
    ws = await Workspace.init(join(root, 'ws'));
    targets = new TargetRegistry();
    targets.setOffline([new OfflineLink(loc, { backupDir: () => join(ws.root, '.cellar', 'backups'), isRunning: async () => running })]);
    engine = new SyncEngine({ workspace: ws, targets });
});

after(async () => { await rm(root, { recursive: true, force: true }); });

test('offline: checkout without a live link; status is real and marked offline', async () => {
    const co = await engine.checkout(undefined, { kind: 'lorebook', id: 'Book' });
    assert.equal(co.path, 'lorebooks/Book');
    const b = await statusOf();
    assert.deepEqual([b.connected, b.offline, b.status], [false, true, 'in-sync']);
});

test('offline: a tavern edit shows as tavern-changes and pull takes it', async () => {
    await writeWorld(book('edited in tavern'));
    assert.equal((await statusOf()).status, 'tavern-changes');
    assert.equal((await engine.pull('lorebooks/Book')).result, 'pulled');
    assert.equal((await statusOf()).status, 'in-sync');
});

test('offline: local edit shows as local-changes; sync writes the folder with a backup', async () => {
    const entryDir = join(ws.root, 'lorebooks', 'Book', 'entries');
    const [entry] = (await readdir(entryDir)).filter(n => n.endsWith('.md'));
    const file = join(entryDir, entry);
    await writeFile(file, (await readFile(file, 'utf8')).replace('edited in tavern', 'edited locally'));
    assert.equal((await statusOf()).status, 'local-changes');

    running = true;
    await assert.rejects(engine.sync('lorebooks/Book'), e => e.code === ERR.TAVERN_RUNNING);
    running = false;

    const res = await engine.sync('lorebooks/Book');
    assert.equal(res.result, 'synced');
    assert.equal(JSON.parse(await readFile(worldFile, 'utf8')).entries[0].content.trim(), 'edited locally');
    assert.equal((await readdir(join(ws.root, '.cellar', 'backups', TARGET, 'lorebook'))).length, 1);
    assert.equal((await statusOf()).status, 'in-sync');
});

test('offline: both sides changed shows both-changed and sync refuses', async () => {
    const entryDir = join(ws.root, 'lorebooks', 'Book', 'entries');
    const [entry] = (await readdir(entryDir)).filter(n => n.endsWith('.md'));
    const file = join(entryDir, entry);
    await writeFile(file, (await readFile(file, 'utf8')).replace('edited locally', 'local again'));
    await writeWorld(book('tavern again'));
    assert.equal((await statusOf()).status, 'both-changed');
    await assert.rejects(engine.sync('lorebooks/Book'), e => e.code === ERR.CONFLICT);
    assert.equal((await statusOf()).status, 'conflict');
});

test('server: turning a tavern off also turns its offline access off', async () => {
    const config = {
        port: 0, token: 'offline-test-token-0123456789', allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [],
        locations: { st: [], tt: [{ install: '', data: dataRoot }] },
    };
    const server = await startServer({ config, workspace: await Workspace.init(join(root, 'ws2')), log: () => {}, watch: false, persistConfig: async () => {} });
    const api = async (method, path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method, headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
    })).json();
    try {
        assert.deepEqual((await api('GET', '/api/status')).result.offlineTargets.map(t => t.id), [TARGET]);
        await api('POST', '/api/taverns', { tt: false });
        assert.deepEqual((await api('GET', '/api/status')).result.offlineTargets, []);
        assert.equal((await api('POST', '/api/catalog', { target: TARGET, kind: 'lorebook' })).error.code, ERR.NOT_CONNECTED);
        await api('POST', '/api/taverns', { tt: true });
        assert.equal((await api('POST', '/api/catalog', { target: TARGET, kind: 'lorebook' })).result.total, 1);
    } finally {
        await server.close();
    }
});
