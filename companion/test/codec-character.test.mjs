import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCharacter, encodeCharacter } from '../src/codec/character.js';

const v2Card = () => ({
    name: 'Alice',
    description: 'She is\nkind.',
    personality: 'calm',
    scenario: '',
    first_mes: 'Hello!',
    mes_example: '<START>\n{{char}}: hi',
    creatorcomment: 'notes',
    avatar: 'none',
    chat: 'Alice - 2024',
    talkativeness: '0.5',
    fav: false,
    tags: ['a', 'b'],
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
        name: 'Alice',
        description: 'She is\nkind.',
        personality: 'calm',
        scenario: '',
        first_mes: 'Hello!',
        mes_example: '<START>\n{{char}}: hi',
        creator_notes: 'notes',
        system_prompt: 'sys',
        post_history_instructions: '',
        tags: ['a', 'b'],
        creator: 'me',
        character_version: '1',
        alternate_greetings: ['Hi 1', 'Hi 2\n\nsecond paragraph'],
        extensions: {
            talkativeness: '0.5',
            fav: false,
            world: 'Alice WI',
            depth_prompt: { prompt: 'depth text', depth: 4, role: 'system' },
            regex_scripts: [{ id: 'x', findRegex: '/a/g', replaceString: 'b' }],
            unknown_ext: { nested: [1, 2, { k: null }] },
        },
        character_book: { name: 'embedded', entries: [{ id: 0, keys: ['k'], content: 'c' }] },
    },
});

test('V2/V3 card round-trips losslessly', () => {
    const card = v2Card();
    const files = decodeCharacter(card);
    assert.equal(files['description.md'], 'She is\nkind.');
    assert.equal(files['alternate_greetings/02.md'], 'Hi 2\n\nsecond paragraph');
    assert.equal(files['depth_prompt.md'], 'depth text');
    const rest = JSON.parse(files['card.json']);
    assert.equal(rest.description, undefined, 'mirrored V1 field removed from card.json');
    assert.equal(rest.data.description, undefined);
    assert.deepEqual(rest.data.extensions.depth_prompt, { depth: 4, role: 'system' });
    assert.deepStrictEqual(encodeCharacter(files), card);
});

test('editing a text file changes both V2 field and V1 mirror', () => {
    const files = decodeCharacter(v2Card());
    files['description.md'] = 'New description';
    const card = encodeCharacter(files);
    assert.equal(card.data.description, 'New description');
    assert.equal(card.description, 'New description');
});

test('CRLF from editors is normalized; original CR content is preserved verbatim', () => {
    const card = v2Card();
    card.data.personality = 'line1\r\nline2';
    card.personality = 'line1\r\nline2';
    const files = decodeCharacter(card);
    assert.deepStrictEqual(encodeCharacter(files), card);
    files['description.md'] = '\uFEFFShe is\r\nkind.';
    const out = encodeCharacter(files);
    assert.equal(out.data.description, 'She is\nkind.');
    assert.equal(out.data.personality, 'line1\r\nline2');
});

test('mismatched V1 field is kept in card.json, not mirrored', () => {
    const card = v2Card();
    card.description = 'stale v1 text';
    const files = decodeCharacter(card);
    assert.equal(JSON.parse(files['card.json']).description, 'stale v1 text');
    assert.deepStrictEqual(encodeCharacter(files), card);
});

test('alternate greetings: empty array, add, remove, many', () => {
    const card = v2Card();
    card.data.alternate_greetings = [];
    let files = decodeCharacter(card);
    assert.deepStrictEqual(encodeCharacter(files), card);

    files['alternate_greetings/01.md'] = 'added';
    assert.deepEqual(encodeCharacter(files).data.alternate_greetings, ['added']);

    card.data.alternate_greetings = Array.from({ length: 120 }, (_, i) => `g${i}`);
    files = decodeCharacter(card);
    assert.ok(files['alternate_greetings/001.md'] && files['alternate_greetings/120.md']);
    assert.deepStrictEqual(encodeCharacter(files), card);
});

test('fields missing or non-string stay structural', () => {
    const card = { name: 'Bare', data: { name: 'Bare', description: 42, extensions: {} } };
    const files = decodeCharacter(card);
    assert.equal(files['description.md'], undefined);
    assert.deepStrictEqual(encodeCharacter(files), card);
});

test('V1-only card round-trips', () => {
    const card = { name: 'Old', description: 'v1 desc', first_mes: 'hi', personality: '', scenario: '', mes_example: '' };
    assert.deepStrictEqual(encodeCharacter(decodeCharacter(card)), card);
});

test('invalid card.json reports a readable error', () => {
    const files = decodeCharacter(v2Card());
    files['card.json'] = '{ broken';
    assert.throws(() => encodeCharacter(files), /card\.json: invalid JSON/);
});
