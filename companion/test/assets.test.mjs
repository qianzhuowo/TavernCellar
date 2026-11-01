import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { ERR, MSG } from '../../shared/protocol.js';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { OfflineLink } from '../src/taverns/offline.js';
import { FakeTavern } from './fake-tavern.mjs';

function get(port, path, headers = {}) {
    return new Promise((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port, path, headers }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        }).on('error', reject).end();
    });
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);

test('avatar route: image bytes through asset.get, cached, ETag, invalidated by a tavern edit, guarded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-assets-'));
    const studioDir = join(root, 'studio');
    await mkdir(studioDir, { recursive: true });
    await writeFile(join(studioDir, 'index.html'), '<!doctype html>');
    const config = { port: 0, token: 'asset-test-token-0123456789', allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [], locations: { st: [], tt: [] } };
    const server = await startServer({ config, workspace: await Workspace.init(join(root, 'ws')), log: () => {}, watch: false, persistConfig: async () => {}, studioDir });
    const tavern = new FakeTavern(server.port);
    try {
        await tavern.ready;
        tavern.assets = { 'Alice.png': JPEG };
        const p = server.port;
        const cookie = (await get(p, '/studio/')).headers['set-cookie'][0].split(';')[0];
        const url = '/api/assets/avatar?target=fake-target-1&id=Alice.png';

        assert.equal((await get(p, url)).status, 401, 'needs the Studio session');
        const first = await get(p, url, { Cookie: cookie });
        assert.equal(first.status, 200);
        assert.equal(first.headers['content-type'], 'image/jpeg');
        assert.deepEqual(first.body, JPEG);
        assert.ok(first.headers.etag);
        assert.equal((await get(p, url, { Cookie: cookie, 'If-None-Match': first.headers.etag })).status, 304);
        assert.equal(tavern.assetGets, 1, 'second request served from the cache');

        // a tavern-side edit of the character drops its cached avatar
        await tavern.edit('character', 'Alice.png', d => { d.data.description = 'new'; });
        await new Promise(r => setTimeout(r, 50));
        tavern.assets['Alice.png'] = PNG;
        const after = await get(p, url, { Cookie: cookie });
        assert.deepEqual(after.body, PNG);
        assert.equal(tavern.assetGets, 2);

        assert.equal((await get(p, '/api/assets/avatar?target=fake-target-1&id=Nobody.png', { Cookie: cookie })).status, 404);
        assert.equal((await get(p, '/api/assets/avatar?target=fake-target-1&id=..%2Fsecret.png', { Cookie: cookie })).status, 400);
        assert.equal((await get(p, '/api/assets/avatar?target=nope&id=Alice.png', { Cookie: cookie })).status, 503);
    } finally {
        tavern.close();
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('offline asset.get: fresh tavern thumbnail, else the card itself; never path parts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-assets-off-'));
    const userDir = join(root, 'default-user');
    await mkdir(join(userDir, 'characters'), { recursive: true });
    await mkdir(join(userDir, 'thumbnails', 'avatar'), { recursive: true });
    const card = join(userDir, 'characters', 'Alice.png');
    const thumb = join(userDir, 'thumbnails', 'avatar', 'Alice.png');
    await writeFile(card, PNG);
    await writeFile(thumb, JPEG);
    const old = new Date(Date.now() - 60000);
    await utimes(card, old, old);
    const link = new OfflineLink({ key: 'st:0', host: 'st', label: 'ST', userDir, targetId: 'st-off' }, { backupDir: () => null, isRunning: async () => false });
    try {
        const fresh = await link.request(MSG.ASSET_GET, { type: 'avatar', id: 'Alice.png' });
        assert.equal(fresh.mime, 'image/jpeg');
        assert.deepEqual(Buffer.from(fresh.data, 'base64'), JPEG);

        // card edited after the thumbnail was made: the thumbnail is stale, use the card
        await utimes(thumb, old, new Date(Date.now() - 120000));
        await utimes(card, new Date(), new Date());
        const stale = await link.request(MSG.ASSET_GET, { type: 'avatar', id: 'Alice.png' });
        assert.equal(stale.mime, 'image/png');

        await assert.rejects(link.request(MSG.ASSET_GET, { type: 'avatar', id: 'Bob.png' }), e => e.code === ERR.NOT_FOUND);
        await assert.rejects(link.request(MSG.ASSET_GET, { type: 'avatar', id: '../Alice.png' }), e => e.code === ERR.BAD_REQUEST);
        await assert.rejects(link.request(MSG.ASSET_GET, { type: 'bg', id: 'Alice.png' }), e => e.code === ERR.BAD_REQUEST);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
