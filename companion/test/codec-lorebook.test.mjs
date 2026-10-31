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

// ---- entry groups: entries/<group>/ folders <-> extensions.cellar.group ----

const grouped = () => ({
    entries: {
        0: entry(0, { extensions: { cellar: { group: '世界背景' } } }),
        1: entry(1, { extensions: { cellar: { group: '世界背景/地理' }, other: { x: 1 } } }),
        2: entry(2),
        3: entry(3, { extensions: { cellar: { group: 'bad:name' } } }),
        4: entry(4, { extensions: { cellar: { group: '角色', note: 'keep' } } }),
    },
});

test('groups: folders round-trip losslessly and front matter does not repeat the group', () => {
    const book = grouped();
    const files = decodeLorebook(book);
    const names = Object.keys(files).filter(n => n.startsWith('entries/')).sort();
    assert.deepEqual(names, [
        'entries/0002-Entry 2.md',
        'entries/0003-Entry 3.md',
        'entries/世界背景/0000-Entry 0.md',
        'entries/世界背景/地理/0001-Entry 1.md',
        'entries/角色/0004-Entry 4.md',
    ]);
    assert.equal(parseEntry(files['entries/世界背景/0000-Entry 0.md']).frontMatter.extensions, undefined);
    assert.deepEqual(parseEntry(files['entries/世界背景/地理/0001-Entry 1.md']).frontMatter.extensions, { other: { x: 1 } });
    assert.deepEqual(parseEntry(files['entries/角色/0004-Entry 4.md']).frontMatter.extensions, { cellar: { note: 'keep' } });
    assert.deepEqual(parseEntry(files['entries/0003-Entry 3.md']).frontMatter.extensions, { cellar: { group: 'bad:name' } }, 'not a valid folder: stays in front matter');
    assert.deepEqual(encodeLorebook(files), book);
});

test('groups: moving a file between folders changes its group; to the top level removes it', () => {
    const files = decodeLorebook(grouped());
    files['entries/角色/0002-Entry 2.md'] = files['entries/0002-Entry 2.md'];
    delete files['entries/0002-Entry 2.md'];
    files['entries/0000-Entry 0.md'] = files['entries/世界背景/0000-Entry 0.md'];
    delete files['entries/世界背景/0000-Entry 0.md'];
    const book = encodeLorebook(files);
    assert.deepEqual(book.entries[2].extensions, { cellar: { group: '角色' } });
    assert.equal(book.entries[0].extensions, undefined);
    assert.deepEqual(Object.keys(book.entries), ['0', '1', '2', '3', '4'], 'entry order is kept');
});

test('groups: a group written both as folder and in front matter is an error', () => {
    const files = decodeLorebook(grouped());
    files['entries/角色/0003-Entry 3.md'] = files['entries/0003-Entry 3.md'];
    delete files['entries/0003-Entry 3.md'];
    assert.throws(() => encodeLorebook(files), /分组同时写在文件夹和文件头里/);
});
