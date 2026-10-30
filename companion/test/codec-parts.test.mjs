import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeCharacter, encodeCharacter, ownsCharacterFile } from '../src/codec/character.js';
import { Workspace } from '../src/workspace/workspace.js';
import { SyncEngine } from '../src/sync.js';
import { TargetRegistry } from '../src/targets.js';
import { CODECS } from '../src/codec/index.js';

const baseCard = extensions => ({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'A', description: 'd', extensions } });
const regex = (name, replace) => ({ id: name, scriptName: name, findRegex: '/x/g', replaceString: replace, placement: [2], disabled: false });
const script = (name, content) => ({ type: 'script', enabled: true, name, id: name, content, info: '', button: { enabled: true, buttons: [] }, data: {} });
const roundTrip = card => encodeCharacter(decodeCharacter(card));

test('regex scripts split into numbered json + replace.txt and round-trip (CRLF kept verbatim)', () => {
    const card = baseCard({ regex_scripts: [regex('美化 界面', '<div>\r\n$1</div>'), regex('b/c?', 'plain')] });
    const files = decodeCharacter(card);
    assert.equal(files['regex/01-美化 界面.replace.txt'], '<div>\r\n$1</div>');
    assert.equal(files['regex/02-b_c_.replace.txt'], 'plain');
    assert.equal(JSON.parse(files['regex/01-美化 界面.json']).replaceString, undefined);
    assert.equal(JSON.parse(files['card.json']).data.extensions.regex_scripts, undefined);
    assert.deepEqual(roundTrip(card), card);
});

test('empty regex list round-trips', () => {
    const card = baseCard({ regex_scripts: [] });
    assert.deepEqual(roundTrip(card), card);
});

test('Tavern Helper object form: scripts + variables split, other keys stay in card.json', () => {
    const card = baseCard({ tavern_helper: { scripts: [script('MVU', "import 'x';"), script('状态栏', 'a\nb')], variables: { hp: 10, nested: { a: [1] } }, extra: 1 } });
    const files = decodeCharacter(card);
    assert.equal(files['scripts/01-MVU.js'], "import 'x';");
    assert.equal(files['scripts/02-状态栏.js'], 'a\nb');
    assert.deepEqual(JSON.parse(files['variables.json']), { hp: 10, nested: { a: [1] } });
    assert.deepEqual(JSON.parse(files['card.json']).data.extensions.tavern_helper, { extra: 1 });
    assert.deepEqual(roundTrip(card), card);
});

test('Tavern Helper pairs form keeps its shape and key order', () => {
    const card = baseCard({ tavern_helper: [['variables', { a: 1 }], ['scripts', [script('s', 'code')]], ['other', true]] });
    const back = roundTrip(card);
    assert.deepEqual(back, card);
    assert.deepEqual(back.data.extensions.tavern_helper.map(p => p[0]), ['variables', 'scripts', 'other']);
});

test('legacy TavernHelper_scripts round-trips', () => {
    const card = baseCard({ TavernHelper_scripts: [{ id: '1', name: 'RPG', content: 'x', info: '', buttons: [], enabled: true }] });
    const files = decodeCharacter(card);
    assert.equal(files['scripts/01-RPG.js'], 'x');
    assert.deepEqual(roundTrip(card), card);
});

test('unrecognized shapes stay verbatim in card.json', () => {
    const card = baseCard({ regex_scripts: [regex('a', 'x'), 'not an object'], tavern_helper: { scripts: [{ name: 'f', content: 42 }], variables: 'str' } });
    const files = decodeCharacter(card);
    assert.equal(Object.keys(files).some(f => f.startsWith('regex/') || f.startsWith('scripts/') || f === 'variables.json'), false);
    assert.deepEqual(roundTrip(card), card);
});

test('file names decide order; deleting a file removes the item; edits are normalized', () => {
    const card = baseCard({ regex_scripts: [regex('a', 'A'), regex('b', 'B'), regex('c', 'C')] });
    const files = decodeCharacter(card);
    files['regex/00-c.json'] = files['regex/03-c.json'];
    files['regex/00-c.replace.txt'] = 'C edited\r\n';
    delete files['regex/03-c.json']; delete files['regex/03-c.replace.txt'];
    delete files['regex/02-b.json']; delete files['regex/02-b.replace.txt'];
    const out = encodeCharacter(files).data.extensions.regex_scripts;
    assert.deepEqual(out.map(r => r.scriptName), ['c', 'a']);
    assert.equal(out[0].replaceString, 'C edited\n');
});

test('ownership: part files are owned, notes inside regex/ and scripts/ are not', () => {
    for (const rel of ['regex/01-a.json', 'regex/01-a.replace.txt', 'scripts/12-x.js', 'scripts/12-x.json', 'variables.json']) assert.ok(ownsCharacterFile(rel), rel);
    for (const rel of ['regex/readme.md', 'scripts/notes.js', 'scripts/sub/01-a.js', 'regex/a.json']) assert.equal(ownsCharacterFile(rel), false, rel);
});

test('startup upgrades a codec-1 layout in place without changing the content hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cellar-up-'));
    try {
        const ws = await Workspace.init(join(root, 'ws'));
        const card = baseCard({ regex_scripts: [regex('a', 'A')], tavern_helper: { scripts: [script('s', 'code')], variables: {} } });
        // Codec-1 layout: regex and Tavern Helper data still inside card.json.
        const files = decodeCharacter(baseCard({}));
        const old = JSON.parse(files['card.json']);
        old.data.extensions = card.data.extensions;
        files['card.json'] = JSON.stringify(old, null, 2) + '\n';
        files['cellar-item.json'] = JSON.stringify({ ...JSON.parse(files['cellar-item.json']), codec: 1 }, null, 2) + '\n';
        const item = { path: 'characters/A', kind: 'character', bindings: {} };
        ws.manifest.items.push(item);
        await ws.writeItemFiles(item.path, files, CODECS.character.owns);
        await writeFile(join(ws.root, 'characters', 'A', 'notes.md'), 'mine');

        const engine = new SyncEngine({ workspace: ws, targets: new TargetRegistry() });
        const before = await engine.encodeItem(item);
        await engine.upgradeLayouts();
        const after = await engine.encodeItem(item);

        assert.equal(after.hash, before.hash);
        const now = await ws.readItemFiles(item.path);
        assert.equal(now['regex/01-a.replace.txt'], 'A');
        assert.equal(now['scripts/01-s.js'], 'code');
        assert.equal(JSON.parse(now['cellar-item.json']).codec, CODECS.character.version);
        assert.equal(await readFile(join(ws.root, 'characters', 'A', 'notes.md'), 'utf8'), 'mine');
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
