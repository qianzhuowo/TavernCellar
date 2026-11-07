import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { startServer } from '../src/server.js';
import { ERR, PREVIEW_INPUT_MAX, ProtocolError, assertPreviewRequest } from '../../shared/protocol.js';
import { FakeTavern } from './fake-tavern.mjs';

const TOKEN = 'preview-test-token-0123456789';

async function setup(t) {
    const dir = await mkdtemp(join(tmpdir(), 'cellar-preview-'));
    const server = await startServer({
        config: { port: 0, token: TOKEN, allowOrigins: [], taverns: { st: true, tt: true }, stPorts: [] },
        workspace: await Workspace.init(dir), log: () => {}, watch: false, persistConfig: async () => {},
    });
    const api = async (path, body) => (await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body),
    })).json();
    // the fake tavern's handshake (template write) can still be finishing on Windows when the test ends: retry the cleanup
    t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
    return { server, api };
}

const RESULT = {
    api: 'openai',
    chat: { character: { name: 'Alice', avatar: 'Alice.png' }, chatId: 'Alice - 1', messages: 3 },
    prompt: { messages: [{ role: 'system', content: 'hello', tokens: 5 }], sections: [{ identifier: 'main', name: 'Main', start: 0, count: 1, tokens: 5 }] },
    tokens: { total: 5, context: 8000 },
    worldInfo: {
        entries: [
            { world: 'Book', uid: 0, comment: 'c', keys: ['k'], constant: false, position: 0, depth: 4, order: 100, role: 0, content: 'body', tokens: 1 },
            { world: 'Other', uid: 3, comment: '', keys: [], constant: true, position: 4, depth: 2, order: 10, role: 0, content: 'x', tokens: 1 },
        ],
        overflowed: false,
    },
    at: '2026-11-03T00:00:00.000Z',
};

test('preview: forwards to the live link, passes the test input, marks workspace items, passes errors', async t => {
    const { server, api } = await setup(t);
    const tavern = new FakeTavern(server.port, { capabilities: { preview: 1 } });
    t.after(() => tavern.close());
    await tavern.ready;
    tavern.previewResult = RESULT;

    const status = await api('/api/status');
    assert.equal(status.result.targets[0].preview, 1);

    const book = await api('/api/checkout', { kind: 'lorebook', id: 'Book' });
    assert.equal(book.ok, true, JSON.stringify(book));
    const card = await api('/api/checkout', { kind: 'character', id: 'Alice.png' });
    assert.equal(card.ok, true, JSON.stringify(card));

    const r = await api('/api/preview', { input: 'look at the k' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(tavern.previews.at(-1), { input: 'look at the k' });
    assert.equal(r.result.target, 'fake-target-1');
    assert.equal(r.result.chat.character.path, card.result.path);
    assert.equal(r.result.worldInfo.entries[0].path, book.result.path);
    assert.equal(r.result.worldInfo.entries[1].path, null, 'a book not in the workspace has no path');
    assert.equal(r.result.tokens.total, 5);

    // no input: an empty payload reaches the link
    await api('/api/preview', { input: '' });
    assert.deepEqual(tavern.previews.at(-1), {});

    // input too long: refused before reaching the tavern
    const count = tavern.previews.length;
    const long = await api('/api/preview', { input: 'x'.repeat(PREVIEW_INPUT_MAX + 1) });
    assert.equal(long.error.code, ERR.BAD_REQUEST);
    assert.equal(tavern.previews.length, count);

    // tavern errors pass through with their code
    tavern.previewError = new ProtocolError(ERR.NO_CHAT, '酒馆里没有打开角色');
    const noChat = await fetch(`http://127.0.0.1:${server.port}/api/preview`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }, body: '{}' });
    assert.equal(noChat.status, 412);
    assert.equal((await noChat.json()).error.code, ERR.NO_CHAT);
    tavern.previewError = new ProtocolError(ERR.BUSY, 'busy');
    assert.equal((await api('/api/preview', {})).error.code, ERR.BUSY);
});

test('preview: an old Cellar Link without the capability is told to update; no tavern means not_connected', async t => {
    const { server, api } = await setup(t);
    assert.equal((await api('/api/preview', {})).error.code, ERR.NOT_CONNECTED);
    const tavern = new FakeTavern(server.port);
    t.after(() => tavern.close());
    await tavern.ready;
    const r = await api('/api/preview', {});
    assert.equal(r.error.code, ERR.BAD_REQUEST);
    assert.match(r.error.message, /不支持提示词预览/);
    assert.equal(tavern.previews, undefined);
    assert.equal((await api('/api/preview', { target: 'nope' })).error.code, ERR.NOT_CONNECTED);
});

test('assertPreviewRequest: only an optional string input', () => {
    assertPreviewRequest({});
    assertPreviewRequest({ input: 'hi' });
    for (const bad of [null, [], { input: 3 }, { input: 'x', chat: 1 }, { input: 'x'.repeat(PREVIEW_INPUT_MAX + 1) }]) {
        assert.throws(() => assertPreviewRequest(bad), e => e.code === ERR.BAD_REQUEST);
    }
});
