import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Workspace } from '../src/workspace/workspace.js';
import { CODECS } from '../src/codec/index.js';
import { diffPaths } from '../src/codec/object-path.js';

test('diffPaths lists differing fields, capped', () => {
    const a = { data: { description: 'x', alternate_greetings: ['a', 'b'], extensions: { k: 1 } }, spec: 'v3' };
    const b = { data: { description: 'y', alternate_greetings: ['a'], extensions: { k: 1, extra: true } }, spec: 'v3' };
    assert.deepEqual(diffPaths(a, b), ['data.description', 'data.alternate_greetings.1', 'data.extensions.extra']);
    assert.deepEqual(diffPaths(a, structuredClone(a)), []);
    assert.equal(diffPaths({ a: 1, b: 2, c: 3 }, {}, 2).length, 2);
});

const exists = p => stat(p).then(() => true, () => false);

test('writing the tavern version back keeps user files in the item folder, deletes only codec files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-ws-'));
    try {
        const ws = await Workspace.init(join(root, 'ws'));
        const codec = CODECS.character;
        const card = {
            spec: 'chara_card_v3', spec_version: '3.0',
            data: { name: 'A', description: 'desc', first_mes: 'hi', alternate_greetings: ['g1', 'g2'], extensions: {} },
        };
        const path = 'characters/A';
        const dir = join(ws.root, 'characters', 'A');
        await ws.writeItemFiles(path, codec.decode(card), codec.owns);
        assert.ok(await exists(join(dir, 'alternate_greetings', '02.md')));

        // The user keeps notes and drafts next to the card.
        await writeFile(join(dir, '调研.md'), 'my research');
        await mkdir(join(dir, 'notes'), { recursive: true });
        await writeFile(join(dir, 'notes', 'todo.md'), 'todo');
        await writeFile(join(dir, 'alternate_greetings', 'draft.md'), 'not a greeting file name');

        // The tavern drops the second greeting; the pull rewrites the folder.
        const next = structuredClone(card);
        next.data.alternate_greetings = ['g1'];
        await ws.writeItemFiles(path, codec.decode(next), codec.owns);

        assert.equal(await exists(join(dir, 'alternate_greetings', '02.md')), false, 'codec file no longer produced is deleted');
        assert.equal(await readFile(join(dir, '调研.md'), 'utf8'), 'my research');
        assert.equal(await readFile(join(dir, 'notes', 'todo.md'), 'utf8'), 'todo');
        assert.equal(await readFile(join(dir, 'alternate_greetings', 'draft.md'), 'utf8'), 'not a greeting file name');

        // User files are not part of the card.
        assert.deepEqual(codec.encode(await ws.readItemFiles(path)), next);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('codec ownership: lorebook owns book.json, meta and entries/*.md only', () => {
    const owns = CODECS.lorebook.owns;
    for (const rel of ['book.json', 'cellar-item.json', 'entries/0001-冰花.md']) assert.ok(owns(rel), rel);
    for (const rel of ['notes.md', 'entries/readme.txt', 'entries/sub/readme.txt', 'research/a.md']) assert.equal(owns(rel), false, rel);
    assert.equal(owns('entries/sub/x.md'), true, 'group folders under entries/ hold entries');
});

test('writeItemFiles refuses to run without an ownership test', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-ws-'));
    try {
        const ws = await Workspace.init(join(root, 'ws'));
        await assert.rejects(ws.writeItemFiles('characters/A', {}), /ownership/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
