import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';

/** Raw request so encoded paths reach the server unchanged. */
function get(port, path, method = 'GET') {
    return new Promise((resolve, reject) => {
        httpRequest({ host: '127.0.0.1', port, path, method }, res => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', c => { body += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject).end();
    });
}

test('studio page: static files only, no traversal, API stays protected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-studio-'));
    const studioDir = join(root, 'studio');
    await mkdir(join(studioDir, 'js'), { recursive: true });
    await writeFile(join(studioDir, 'index.html'), '<!doctype html><title>s</title>');
    await writeFile(join(studioDir, 'js', 'a.js'), 'x=1');
    await writeFile(join(root, 'secret.txt'), 'secret');
    const config = { port: 0, token: 'studio-test-token-0123456789', allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [], locations: { st: [], tt: [] } };
    const server = await startServer({ config, workspace: await Workspace.init(join(root, 'ws')), log: () => {}, watch: false, persistConfig: async () => {}, studioDir });
    try {
        const p = server.port;
        const index = await get(p, '/studio/');
        assert.equal(index.status, 200);
        assert.match(index.headers['content-type'], /text\/html/);
        assert.match(index.headers['content-security-policy'], /default-src 'self'/);
        assert.equal((await get(p, '/studio/js/a.js')).headers['content-type'], 'text/javascript; charset=utf-8');
        assert.equal((await get(p, '/')).status, 302);
        assert.equal((await get(p, '/studio/nope.js')).status, 404);
        assert.equal((await get(p, '/studio/', 'POST')).status, 405);
        for (const bad of ['/studio/..%2fsecret.txt', '/studio/..%5csecret.txt', '/studio/%2e%2e/secret.txt', '/studio/%00', '/studio/%E0%A4%A']) {
            const res = await get(p, bad);
            assert.notEqual(res.status, 200, bad);
            assert.ok(!res.body.includes('secret'), bad);
        }
        assert.equal((await get(p, '/api/status')).status, 401);
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
});
