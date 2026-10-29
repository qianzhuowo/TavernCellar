import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLorebook, encodeLorebook, parseEntry, serializeEntry } from '../src/codec/lorebook.js';

const entry = (uid, extra = {}) => ({
    uid,
    key: [`key${uid}`, 'shared'],
    keysecondary: [],
    comment: `Entry ${uid}`,
    content: `Content of ${uid}\nsecond line`,
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100,
    position: 0,
    disable: false,
    excludeRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    automationId: '',
    role: null,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    displayIndex: uid,
    characterFilter: { isExclude: false, names: [], tags: [] },
    ...extra,
});

const book = () => ({
    entries: { 0: entry(0), 1: entry(1, { comment: 'Weird: name/with*chars?' }), 10: entry(10, { comment: '' }) },
    name: 'Test Book',
    extensions: { custom: true },
});

test('lorebook round-trips losslessly', () => {
    const data = book();
    const files = decodeLorebook(data);
    assert.ok(files['entries/0000-Entry 0.md']);
    assert.ok(files['entries/0001-Weird_ name_with_chars_.md']);
    assert.ok(files['entries/0010-key10.md'], 'falls back to first key when comment is empty');
    assert.deepStrictEqual(encodeLorebook(files), data);
});

test('entry file has YAML front matter and content body', () => {
    const files = decodeLorebook(book());
    const { frontMatter, body } = parseEntry(files['entries/0000-Entry 0.md']);
    assert.equal(body, 'Content of 0\nsecond line');
    assert.equal(frontMatter.content, undefined);
    assert.equal(frontMatter.scanDepth, null);
    assert.deepEqual(frontMatter.characterFilter, { isExclude: false, names: [], tags: [] });
});

test('tricky front matter values survive YAML', () => {
    const tricky = entry(3, {
        comment: 'a---b\n---\nmultiline: yes',
        key: ['yes', 'no', 'null', '0123', '1e3', ' padded ', 'colon: x', '#hash', '- dash', 'true'],
        group: '~',
        automationId: '\'"',
        content: '---\nnot front matter\n---\n',
    });
    const data = { entries: { 3: tricky } };
    const files = decodeLorebook(data);
    assert.deepStrictEqual(encodeLorebook(files), data);
});

test('empty content, CR content and non-string content', () => {
    const data = {
        entries: {
            0: entry(0, { content: '' }),
            1: entry(1, { content: 'a\r\nb' }),
            2: entry(2, { content: undefined }),
            3: entry(3, { content: 7 }),
        },
    };
    delete data.entries[2].content;
    const files = decodeLorebook(data);
    assert.deepStrictEqual(encodeLorebook(files), data);
});

test('editing body, adding and deleting entries', () => {
    const files = decodeLorebook(book());
    files['entries/0000-Entry 0.md'] = files['entries/0000-Entry 0.md'].replace('Content of 0', 'Edited');
    delete files['entries/0010-key10.md'];
    files['entries/new-idea.md'] = '---\ncomment: New one\nkey: [fresh]\n---\nBrand new content\r\n';
    const out = encodeLorebook(files, { entryTemplate: { key: [], content: '', order: 100, disable: false, comment: '' } });
    assert.equal(out.entries[0].content, 'Edited\nsecond line');
    assert.equal(out.entries[10], undefined);
    assert.deepEqual(out.entries[2], { key: ['fresh'], content: 'Brand new content\n', order: 100, disable: false, comment: 'New one', uid: 2 });
    assert.deepEqual(Object.keys(out.entries), ['0', '1', '2']);
});

test('plain markdown without front matter becomes a new entry', () => {
    const files = decodeLorebook({ entries: {} });
    files['entries/plain.md'] = 'Just text';
    const out = encodeLorebook(files, { entryTemplate: { content: '', key: [] } });
    assert.deepEqual(out.entries, { 0: { content: 'Just text', key: [], uid: 0 } });
});

test('duplicate uid across files is rejected', () => {
    const files = decodeLorebook(book());
    files['entries/copy.md'] = files['entries/0000-Entry 0.md'];
    assert.throws(() => encodeLorebook(files), /duplicate entry uid 0/);
});

test('entry keys that differ from uid, and odd entries shapes', () => {
    const data = { entries: { 5: entry(7), x: 'opaque', 6: entry(6) } };
    assert.deepStrictEqual(encodeLorebook(decodeLorebook(data)), data);
    const arrayShape = { entries: [1, 2] };
    assert.deepStrictEqual(encodeLorebook(decodeLorebook(arrayShape)), arrayShape);
    const noEntries = { name: 'n' };
    assert.deepStrictEqual(encodeLorebook(decodeLorebook(noEntries)), noEntries);
});

test('serializeEntry/parseEntry tolerate CRLF files and empty front matter', () => {
    const text = serializeEntry({}, 'body').replace(/\n/g, '\r\n');
    assert.deepEqual(parseEntry(text), { frontMatter: {}, body: 'body' });
    assert.deepEqual(parseEntry('---\n---\nx'), { frontMatter: {}, body: 'x' });
    assert.throws(() => parseEntry('---\n: : bad\n  - x\n---\n', 'f.md'), /f\.md: invalid YAML/);
});
