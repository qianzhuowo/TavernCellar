import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeCharacter, encodeCharacter } from '../src/codec/character.js';
import { parseEntry } from '../src/codec/front-matter.js';

const entry = (id, comment, content, extra = {}) => ({ id, keys: [comment], secondary_keys: [], comment, content, constant: false, selective: true, insertion_order: 100, enabled: true, position: 'after_char', extensions: { depth: 4 }, ...extra });
const card = entries => ({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'A', extensions: {}, character_book: { name: 'A book', scan_depth: 2, entries } } });

test('embedded book entries become character_book/NNNN-name.md and round-trip (CRLF kept)', () => {
    const c = card([entry(0, '王都', 'line1\r\nline2'), entry(1, 'b', 'x', { use_regex: true })]);
    const files = decodeCharacter(c);
    assert.deepEqual(Object.keys(files).filter(f => f.startsWith('character_book/')), ['character_book/0001-王都.md', 'character_book/0002-b.md']);
    const { frontMatter, body } = parseEntry(files['character_book/0001-王都.md']);
    assert.equal(body, 'line1\r\nline2');
    assert.equal(frontMatter.content, undefined);
    assert.deepEqual(JSON.parse(files['card.json']).data.character_book, { name: 'A book', scan_depth: 2 });
    assert.deepEqual(encodeCharacter(files), c);
});

test('number decides order; deleting a file removes the entry; deleting all leaves an empty list', () => {
    const files = decodeCharacter(card([entry(0, 'a', 'A'), entry(1, 'b', 'B')]));
    files['character_book/0000-b.md'] = files['character_book/0002-b.md'];
    delete files['character_book/0002-b.md'];
    assert.deepEqual(encodeCharacter(files).data.character_book.entries.map(e => e.comment), ['b', 'a']);
    delete files['character_book/0000-b.md'];
    delete files['character_book/0001-a.md'];
    assert.deepEqual(encodeCharacter(files).data.character_book.entries, []);
});

test('a book with an unrecognized entry stays verbatim in card.json; exclude keeps it there too', () => {
    const odd = card([entry(0, 'a', 'A'), { id: 1, content: 42 }]);
    const files = decodeCharacter(odd);
    assert.equal(Object.keys(files).some(f => f.startsWith('character_book/')), false);
    assert.deepEqual(encodeCharacter(files), odd);
    const normal = card([entry(0, 'a', 'A')]);
    const kept = decodeCharacter(normal, { exclude: ['character_book'] });
    assert.equal(Object.keys(kept).some(f => f.startsWith('character_book/')), false);
    assert.deepEqual(encodeCharacter(kept), normal);
});
