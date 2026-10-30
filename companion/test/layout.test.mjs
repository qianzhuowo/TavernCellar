import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHARACTER_PARTS, decodeCharacter, encodeCharacter } from '../src/codec/character.js';
import { detectFrameworks } from '../src/codec/frameworks.js';
import { CODECS } from '../src/codec/index.js';
import { Workspace } from '../src/workspace/workspace.js';
import { SyncEngine } from '../src/sync.js';
import { TargetRegistry } from '../src/targets.js';

const card = {
    spec: 'chara_card_v3', spec_version: '3.0',
    data: {
        name: 'A', description: 'desc', first_mes: 'hi <UpdateVariable>', alternate_greetings: ['g1'],
        extensions: {
            regex_scripts: [{ scriptName: 'r', findRegex: 'x', replaceString: 'y' }],
            tavern_helper: { scripts: [{ name: 'MVU', content: "import 'https://cdn/MagVarUpdate/x.js'" }], variables: { a: 1 } },
            'xiaobaix-template': { enabled: true },
        },
    },
};

test('each part can be kept in card.json; the round-trip stays lossless', () => {
    for (const part of CHARACTER_PARTS) {
        const files = decodeCharacter(card, { exclude: [part] });
        const prefix = { fields: 'description.md', greetings: 'alternate_greetings/', regex: 'regex/', scripts: 'scripts/', variables: 'variables.json' }[part];
        assert.equal(Object.keys(files).some(f => f.startsWith(prefix)), false, `${part} should not be split`);
        assert.deepEqual(encodeCharacter(files), card, part);
    }
    const all = decodeCharacter(card, { exclude: CHARACTER_PARTS });
    assert.deepEqual(Object.keys(all).sort(), ['card.json', 'cellar-item.json']);
    assert.deepEqual(encodeCharacter(all), card);
});

test('setLayout re-lays out files without changing the content hash, and rejects unknown parts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-layout-'));
    try {
        const ws = await Workspace.init(join(root, 'ws'));
        const item = { path: 'characters/A', kind: 'character', bindings: {} };
        ws.manifest.items.push(item);
        await ws.writeItemFiles(item.path, decodeCharacter(card), CODECS.character.owns);
        const engine = new SyncEngine({ workspace: ws, targets: new TargetRegistry() });
        const before = await engine.encodeItem(item);

        await engine.setLayout(item.path, { exclude: ['regex', 'scripts'] });
        let files = await ws.readItemFiles(item.path);
        assert.equal(Object.keys(files).some(f => f.startsWith('regex/') || f.startsWith('scripts/')), false);
        assert.ok(files['variables.json']);
        assert.equal((await engine.encodeItem(item)).hash, before.hash);
        assert.deepEqual(item.layout, { exclude: ['regex', 'scripts'] });

        await engine.setLayout(item.path, { exclude: [] });
        files = await ws.readItemFiles(item.path);
        assert.ok(files['regex/01-r.replace.txt']);
        assert.equal(item.layout, undefined);
        assert.equal((await engine.encodeItem(item)).hash, before.hash);

        await assert.rejects(engine.setLayout(item.path, { exclude: ['bogus'] }), /Unknown parts/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('framework detection: Tavern Helper, MVU, Xiaobai X', () => {
    assert.deepEqual(detectFrameworks(card).map(f => f.id), ['tavern_helper', 'mvu', 'xiaobaix']);
    const pairs = { data: { extensions: { tavern_helper: [['scripts', [{ name: 's', content: 'x' }]]] } } };
    assert.deepEqual(detectFrameworks(pairs).map(f => f.id), ['tavern_helper']);
    assert.deepEqual(detectFrameworks({ data: { first_mes: '<UpdateVariable>', extensions: {} } }).map(f => f.id), ['mvu']);
    assert.deepEqual(detectFrameworks({ data: { extensions: {} } }), []);
});
