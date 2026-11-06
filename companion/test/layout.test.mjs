import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHARACTER_PARTS, decodeCharacter, encodeCharacter, omitParts, restoreParts } from '../src/codec/character.js';
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

test('each part can be left in card.json (not extracted); the round-trip stays lossless', () => {
    assert.deepEqual([...CHARACTER_PARTS], ['greetings', 'regex', 'scripts', 'variables', 'character_book']);
    for (const part of CHARACTER_PARTS) {
        const files = decodeCharacter(card, { exclude: [part] });
        const prefix = { greetings: 'alternate_greetings/', regex: 'regex/', scripts: 'scripts/', variables: 'variables.json', character_book: 'character_book/' }[part];
        assert.equal(Object.keys(files).some(f => f.startsWith(prefix)), false, `${part} should not be split`);
        assert.equal('first_mes.md' in files, part !== 'greetings', 'first_mes follows the greetings part');
        assert.ok(files['description.md'], 'base text fields always have their own files');
        assert.deepEqual(encodeCharacter(files), card, part);
    }
    const all = decodeCharacter(card, { exclude: CHARACTER_PARTS });
    assert.deepEqual(Object.keys(all).sort(), ['card.json', 'cellar-item.json', 'description.md']);
    assert.deepEqual(encodeCharacter(all), card);
    // a retired part id from an older workspace changes nothing
    assert.deepEqual(decodeCharacter(card, { exclude: ['fields'] }), decodeCharacter(card));
});

test('omitParts leaves out the parts that are not extracted; restoreParts puts them back in place', () => {
    const v2 = { ...structuredClone(card), first_mes: card.data.first_mes };
    v2.data.character_book = { entries: [{ keys: ['k'], content: 'c' }] };
    v2.data.extensions.depth_prompt = { prompt: 'p', depth: 4 };
    const { data, omitted } = omitParts(v2, ['greetings', 'regex', 'scripts', 'variables', 'character_book']);
    assert.deepEqual(omitted, ['greetings', 'regex', 'scripts', 'character_book']);
    for (const key of ['first_mes', 'alternate_greetings', 'character_book']) assert.equal(key in data.data, false, key);
    assert.equal('first_mes' in data, false);
    assert.deepEqual(Object.keys(data.data.extensions), ['xiaobaix-template', 'depth_prompt']);
    assert.equal(data.data.description, 'desc');

    data.data.description = 'edited';
    data.data.extensions.regex_scripts = [{ scriptName: 'not loaded, must not win' }];
    restoreParts(data, v2, omitted);
    const expected = structuredClone(v2);
    expected.data.description = 'edited';
    assert.deepEqual(data, expected);
    assert.equal(JSON.stringify(data), JSON.stringify(expected), 'key order is the stored one');
    // a part the stored card does not have is removed again
    const none = structuredClone(v2);
    delete none.data.character_book;
    const back = restoreParts(structuredClone(v2), none, ['character_book']);
    assert.equal('character_book' in back.data, false);
    assert.deepEqual(omitParts(card, []).omitted, []);
});

test('editor data: a character loads without the parts that are not extracted and keeps them on save', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-extract-'));
    try {
        const ws = await Workspace.init(join(root, 'ws'));
        const item = { path: 'characters/A', kind: 'character', bindings: {}, layout: { exclude: ['regex', 'scripts'] } };
        ws.manifest.items.push(item);
        await ws.writeItemFiles(item.path, decodeCharacter(card, { exclude: item.layout.exclude }), CODECS.character.owns);
        const engine = new SyncEngine({ workspace: ws, targets: new TargetRegistry() });

        const r = await engine.readItemData(item.path);
        assert.deepEqual(r.omitted, ['regex', 'scripts']);
        assert.equal(r.data.data.extensions.regex_scripts, undefined);
        assert.equal(r.data.data.extensions.tavern_helper, undefined);
        r.data.data.first_mes = 'new opening';
        const w = await engine.writeItemData(item.path, { data: r.data, hash: r.hash, omitted: r.omitted });
        const after = await engine.encodeItem(item);
        assert.equal(after.hash, w.hash);
        assert.deepEqual(after.data, { ...card, data: { ...card.data, first_mes: 'new opening' } });
        await assert.rejects(engine.writeItemData(item.path, { data: r.data, hash: w.hash, omitted: ['fields'] }), e => e.code === 'bad_request');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('startup drops the retired "fields" part and re-lays out older items without changing the hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-retired-'));
    try {
        const ws = await Workspace.init(join(root, 'ws'));
        const item = { path: 'characters/A', kind: 'character', bindings: {}, layout: { exclude: ['fields', 'regex'] } };
        ws.manifest.items.push(item);
        // codec 3 layout: every text field in card.json
        const old = decodeCharacter(card, { exclude: ['regex'] });
        const meta = JSON.parse(old['cellar-item.json']);
        const cardJson = JSON.parse(old['card.json']);
        cardJson.data.description = card.data.description;
        cardJson.data.first_mes = card.data.first_mes;
        delete old['description.md'];
        delete old['first_mes.md'];
        old['card.json'] = JSON.stringify(cardJson, null, 2) + '\n';
        old['cellar-item.json'] = JSON.stringify({ ...meta, codec: 3 }, null, 2) + '\n';
        await ws.writeItemFiles(item.path, old, CODECS.character.owns);
        const engine = new SyncEngine({ workspace: ws, targets: new TargetRegistry() });
        const before = await engine.encodeItem(item);

        await engine.upgradeLayouts();
        assert.deepEqual(item.layout, { exclude: ['regex'] });
        const files = await ws.readItemFiles(item.path);
        assert.ok(files['description.md'] && files['first_mes.md']);
        assert.equal(JSON.parse(files['cellar-item.json']).codec, 4);
        assert.equal((await engine.encodeItem(item)).hash, before.hash);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
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
        await assert.rejects(engine.setLayout(item.path, { exclude: ['fields'] }), /Unknown parts/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('item files: list, read and write split files with a hash guard; the item is re-read like after a VS Code edit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-files-'));
    try {
        const ws = await Workspace.init(join(root, 'ws'));
        const item = { path: 'characters/A', kind: 'character', bindings: {} };
        ws.manifest.items.push(item);
        await ws.writeItemFiles(item.path, decodeCharacter(card), CODECS.character.owns);
        const engine = new SyncEngine({ workspace: ws, targets: new TargetRegistry() });

        const { files } = await engine.itemFiles(item.path);
        const rels = files.map(f => f.rel);
        assert.ok(rels.includes('regex/01-r.replace.txt') && rels.includes('scripts/01-MVU.js') && rels.includes('variables.json'), rels.join());
        assert.equal(files.find(f => f.rel === 'cellar-item.json').readOnly, true);

        const r = await engine.readItemFile(item.path, { file: 'regex/01-r.replace.txt' });
        assert.equal(r.text, 'y');
        const w = await engine.writeItemFile(item.path, { file: 'regex/01-r.replace.txt', text: 'z', hash: r.hash });
        assert.equal(w.error, null);
        assert.equal((await engine.readItemData(item.path)).data.data.extensions.regex_scripts[0].replaceString, 'z');

        await assert.rejects(engine.writeItemFile(item.path, { file: 'regex/01-r.replace.txt', text: 'q', hash: r.hash }), e => e.code === 'conflict');
        await assert.rejects(engine.writeItemFile(item.path, { file: 'cellar-item.json', text: '{}', hash: 'x' }), /由 TavernCellar 维护/);
        for (const badPath of ['../../cellar.json', 'regex/../../B/card.json', '.git/config']) {
            await assert.rejects(engine.readItemFile(item.path, { file: badPath }), e => e.code === 'bad_request', badPath);
        }
        await assert.rejects(engine.readItemFile(item.path, { file: 'nope.md' }), e => e.code === 'not_found');

        const bad = await engine.readItemFile(item.path, { file: 'variables.json' });
        assert.match((await engine.writeItemFile(item.path, { file: 'variables.json', text: '{ broken', hash: bad.hash })).error, /variables\.json/);
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
