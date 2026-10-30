import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLorebook, encodeLorebook, parseEntry } from '../src/codec/lorebook.js';

const template = { key: [], keysecondary: [], comment: '', content: '', constant: false, order: 100, position: 0, disable: false, probability: 100, useProbability: true, depth: 4, group: '' };
const entry = (uid, extra = {}) => ({ uid, key: ['k'], keysecondary: [], comment: `e${uid}`, content: `body ${uid}`, constant: false, order: 100, position: 0, disable: false, probability: 100, useProbability: true, depth: 4, group: '', ...extra });
const book = entries => ({ name: 'B', entries: Object.fromEntries(entries.map(e => [String(e.uid), e])) });
const header = (files, name) => parseEntry(files[name], name).frontMatter;

test('front matter omits fields equal to the template snapshot; round-trip is lossless', () => {
    const b = book([entry(0), entry(1, { order: 250, depth: 2, extensions: { x: 1 } })]);
    const files = decodeLorebook(b, { template });
    assert.deepEqual(header(files, 'entries/0000-e0.md'), { uid: 0, key: ['k'], comment: 'e0' });
    assert.deepEqual(header(files, 'entries/0001-e1.md'), { uid: 1, key: ['k'], comment: 'e1', order: 250, depth: 2, extensions: { x: 1 } });
    assert.deepEqual(JSON.parse(files['cellar-item.json']).template, template);
    assert.deepEqual(encodeLorebook(files), b);
});

test('template fields an entry did not have are not added back', () => {
    const old = entry(0);
    delete old.group; delete old.useProbability;
    const b = book([old]);
    const files = decodeLorebook(b, { template });
    assert.deepEqual(JSON.parse(files['cellar-item.json']).absent, { 0: ['useProbability', 'group'] });
    assert.deepEqual(encodeLorebook(files), b);
});

test('deleting a field line means "use the template value"; the snapshot, not the current tavern template, decides', () => {
    const files = decodeLorebook(book([entry(0, { depth: 9 })]), { template });
    files['entries/0000-e0.md'] = files['entries/0000-e0.md'].replace('depth: 9\n', '');
    const out = encodeLorebook(files, { entryTemplate: { ...template, depth: 77 } });
    assert.equal(out.entries[0].depth, 4);
});

test('new entries take defaults from the snapshot', () => {
    const files = decodeLorebook(book([entry(0)]), { template });
    files['entries/new.md'] = '---\ncomment: fresh\nkey: [a]\n---\nhello';
    const out = encodeLorebook(files, { entryTemplate: { ...template, order: 999 } });
    const fresh = Object.values(out.entries).find(e => e.comment === 'fresh');
    assert.equal(fresh.order, 100);
    assert.equal(fresh.content, 'hello');
    assert.equal(fresh.uid, 1);
});

test('without a template snapshot the full front matter is written (codec-1 behaviour)', () => {
    const b = book([entry(0)]);
    const files = decodeLorebook(b);
    assert.equal(header(files, 'entries/0000-e0.md').depth, 4);
    assert.deepEqual(encodeLorebook(files), b);
});
