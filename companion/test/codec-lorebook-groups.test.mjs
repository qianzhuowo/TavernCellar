import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeLorebook, encodeLorebook, parseEntry, ownsLorebookFile } from '../src/codec/lorebook.js';

const entry = (uid, extra = {}) => ({ uid, key: [`k${uid}`], comment: `Entry ${uid}`, content: `Content ${uid}`, order: 100, ...extra });
const book = (...entries) => ({ entries: Object.fromEntries(entries.map(e => [String(e.uid), e])) });
const grouped = (group, more = {}) => ({ extensions: { ...more, cellar: { group } } });
const entryFiles = files => Object.keys(files).filter(f => f.startsWith('entries/')).sort();

test('groups: an entry group is its folder under entries/ and is not repeated in front matter', () => {
    const b = book(entry(0), entry(1, grouped('世界背景')), entry(2, grouped('世界背景/地理')));
    const files = decodeLorebook(b);
    assert.deepEqual(entryFiles(files), ['entries/0000-Entry 0.md', 'entries/世界背景/0001-Entry 1.md', 'entries/世界背景/地理/0002-Entry 2.md']);
    assert.equal(parseEntry(files['entries/世界背景/0001-Entry 1.md']).frontMatter.extensions, undefined);
    assert.deepEqual(encodeLorebook(files), b);
    assert.ok(ownsLorebookFile('entries/世界背景/地理/0002-Entry 2.md'));
});

test('groups: other extensions data stays in front matter next to the folder', () => {
    const b = book(entry(0, grouped('角色', { other: 1 })), entry(1, { extensions: { cellar: { pinned: true, group: '角色' } } }));
    const files = decodeLorebook(b);
    assert.deepEqual(parseEntry(files['entries/角色/0000-Entry 0.md']).frontMatter.extensions, { other: 1 });
    assert.deepEqual(parseEntry(files['entries/角色/0001-Entry 1.md']).frontMatter.extensions, { cellar: { pinned: true } });
    assert.deepEqual(encodeLorebook(files), b);
});

test('groups: a group that cannot be a folder name stays in front matter (lossless)', () => {
    for (const group of ['a:b', ' 前后空格', 'x//y', '..', '', 5]) {
        const b = book(entry(0, grouped(group)));
        const files = decodeLorebook(b);
        assert.deepEqual(entryFiles(files), ['entries/0000-Entry 0.md'], JSON.stringify(group));
        assert.deepEqual(encodeLorebook(files), b, JSON.stringify(group));
    }
});

test('groups: moving an entry file to another folder changes its group; to the top level removes it', () => {
    const files = decodeLorebook(book(entry(0, grouped('势力')), entry(1)));
    const moved = { ...files };
    moved['entries/地理/0000-Entry 0.md'] = moved['entries/势力/0000-Entry 0.md'];
    delete moved['entries/势力/0000-Entry 0.md'];
    moved['entries/地理/0001-Entry 1.md'] = moved['entries/0001-Entry 1.md'];
    delete moved['entries/0001-Entry 1.md'];
    const out = encodeLorebook(moved);
    assert.deepEqual([out.entries['0'].extensions, out.entries['1'].extensions], [{ cellar: { group: '地理' } }, { cellar: { group: '地理' } }]);
    const back = { ...files, 'entries/0000-Entry 0.md': files['entries/势力/0000-Entry 0.md'] };
    delete back['entries/势力/0000-Entry 0.md'];
    assert.equal(encodeLorebook(back).entries['0'].extensions, undefined);
});

test('groups: a group written both as folder and in front matter is an error, not a silent pick', () => {
    const files = decodeLorebook(book(entry(0, grouped('势力'))));
    const text = files['entries/势力/0000-Entry 0.md'].replace('---\n', '---\nextensions:\n  cellar:\n    group: 地理\n');
    assert.throws(() => encodeLorebook({ ...files, 'entries/势力/0000-Entry 0.md': text }), /文件夹和文件头/);
});
