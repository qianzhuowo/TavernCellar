import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';

/** Raw request so encoded paths reach the server unchanged. */
function get(port, path, method = 'GET', headers = {}, body) {
    return new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => { text += c; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
        });
        req.on('error', reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
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

test('studio session: page sets an HttpOnly cookie; API and events accept it only from the same origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-studio-'));
    const studioDir = join(root, 'studio');
    await mkdir(studioDir, { recursive: true });
    await writeFile(join(studioDir, 'index.html'), '<!doctype html><title>s</title>');
    const config = { port: 0, token: 'studio-test-token-0123456789', allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [], locations: { st: [], tt: [] } };
    const server = await startServer({ config, workspace: await Workspace.init(join(root, 'ws')), log: () => {}, watch: false, persistConfig: async () => {}, studioDir });
    try {
        const p = server.port;
        const setCookie = (await get(p, '/studio/')).headers['set-cookie'][0];
        assert.match(setCookie, /HttpOnly/);
        assert.match(setCookie, /SameSite=Strict/);
        const cookie = setCookie.split(';')[0];
        const same = `http://127.0.0.1:${p}`;

        assert.equal((await get(p, '/api/status', 'GET', { Cookie: cookie })).status, 200, 'same-origin GET (no Origin header)');
        assert.equal((await get(p, '/api/status', 'GET', { Cookie: cookie, Origin: same, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
        assert.equal((await get(p, '/api/status', 'GET', { Cookie: cookie, Origin: 'http://evil.example' })).status, 401, 'foreign origin');
        assert.equal((await get(p, '/api/status', 'GET', { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' })).status, 401, 'cross-site fetch');
        assert.equal((await get(p, '/api/status', 'GET', { Cookie: 'cellar_session=wrong' })).status, 401, 'wrong cookie');
        assert.equal((await get(p, '/api/status', 'GET', { Origin: same })).status, 401, 'same origin without cookie');
        assert.equal((await get(p, '/api/status', 'GET', { Cookie: cookie, Host: `evil.example:${p}` })).status, 401, 'DNS rebinding Host');
        assert.equal((await get(p, '/api/status', 'GET', { Authorization: `Bearer ${config.token}`, Origin: same })).status, 401, 'token is for non-browser clients only');
        assert.equal((await get(p, '/api/status', 'GET', { Authorization: `Bearer ${config.token}` })).status, 200, 'CLI token');

        // settings: defaults, validation, partial update
        const s = JSON.parse((await get(p, '/api/settings', 'GET', { Cookie: cookie })).body).result;
        assert.deepEqual(s.ui, { theme: 'dark', density: 'comfortable', wizardDone: false, messageLang: 'zh', font: 'sans', fontSize: 15, wordCount: true, externalEditor: 'system' });
        const put = await get(p, '/api/settings', 'PUT', { Cookie: cookie, Origin: same }, { ui: { theme: 'light', wizardDone: true, font: 'serif', fontSize: 17 } });
        assert.deepEqual(JSON.parse(put.body).result.ui, { theme: 'light', density: 'comfortable', wizardDone: true, messageLang: 'zh', font: 'serif', fontSize: 17, wordCount: true, externalEditor: 'system' });
        assert.equal((await get(p, '/api/settings', 'PUT', { Cookie: cookie }, { ui: { theme: 'pink' } })).status, 400);
        assert.equal((await get(p, '/api/settings', 'PUT', { Cookie: cookie }, { ui: { fontSize: 99 } })).status, 400);
        assert.equal((await get(p, '/api/settings', 'PUT', { Cookie: cookie }, { ui: { externalEditor: 'calc.exe' } })).status, 400, 'no arbitrary commands');

        // workspace switch
        const next = join(root, 'ws2');
        const sw = await get(p, '/api/workspace', 'POST', { Cookie: cookie, Origin: same }, { dir: next });
        const real = await realpath(next); // the workspace stores the long form of 8.3 temp paths
        assert.equal(JSON.parse(sw.body).result.workspace, real);
        assert.equal(config.workspace, real);
        assert.equal(JSON.parse((await get(p, '/api/status', 'GET', { Cookie: cookie })).body).result.workspace, real);

        // event stream: refused without the cookie, hello + status events with it
        assert.equal((await get(p, '/studio/events')).status, 401);
        const events = await new Promise((resolve, reject) => {
            httpRequest({ host: '127.0.0.1', port: p, path: '/studio/events', headers: { Cookie: cookie } }, res => {
                let text = '';
                res.setEncoding('utf8');
                res.on('data', c => {
                    text += c;
                    if (text.includes('event: hello') && !text.includes('event: status')) get(p, '/api/settings', 'PUT', { Cookie: cookie }, { ui: {} });
                    if (text.includes('event: status')) { res.destroy(); resolve({ status: res.statusCode, type: res.headers['content-type'], text }); }
                });
            }).on('error', reject).end();
        });
        assert.equal(events.status, 200);
        assert.match(events.type, /text\/event-stream/);
        assert.match(events.text, /event: status\ndata: \{"reason":"\/api\/settings"\}/);
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
});

test('workspace move: copies everything (history included) to an empty folder, switches, optionally removes the old one', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'cellar-move-')));
    const config = { port: 0, token: 'studio-test-token-0123456789', allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [], locations: { st: [], tt: [] } };
    const oldDir = join(root, 'old');
    const ws = await Workspace.init(oldDir);
    await mkdir(join(oldDir, 'characters', 'A'), { recursive: true });
    await writeFile(join(oldDir, 'characters', 'A', 'description.md'), 'hello');
    const server = await startServer({ config, workspace: ws, log: () => {}, watch: false, persistConfig: async () => {} });
    const auth = { Authorization: `Bearer ${config.token}` };
    const move = body => get(server.port, '/api/workspace/move', 'POST', auth, body).then(r => ({ status: r.status, body: JSON.parse(r.body) }));
    try {
        assert.equal((await move({ dir: join(oldDir, 'inner') })).status, 400, 'inside the current workspace');
        assert.equal((await move({ dir: root })).status, 400, 'parent of the current workspace');
        const busy = join(root, 'busy');
        await mkdir(busy);
        await writeFile(join(busy, 'x.txt'), 'x');
        assert.equal((await move({ dir: busy })).status, 400, 'non-empty target');

        const keep = await move({ dir: join(root, 'new') });
        assert.equal(keep.status, 200);
        assert.equal(keep.body.result.workspace, join(root, 'new'));
        assert.equal(keep.body.result.removed, false);
        assert.equal(config.workspace, join(root, 'new'));
        assert.equal(await readFile(join(root, 'new', 'characters', 'A', 'description.md'), 'utf8'), 'hello');
        assert.ok(existsSync(join(root, 'new', '.git')), 'version history moves along');
        assert.ok(existsSync(join(oldDir, 'cellar.json')), 'old folder kept unless asked');

        const moved = await move({ dir: join(root, 'third'), removeOld: true });
        assert.equal(moved.body.result.removed, true);
        assert.ok(!existsSync(join(root, 'new')), 'old folder removed on request');
        assert.equal(await readFile(join(root, 'third', 'characters', 'A', 'description.md'), 'utf8'), 'hello');
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
});
