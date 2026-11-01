import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRegex, encodeRegex, ownsRegexFile } from '../src/codec/regex.js';
import { merge3, slotsOf, assemble, slotLabel } from '../src/codec/slots.js';

const script = (id, name, extra = {}) => ({
    id, scriptName: name, findRegex: '/a/g', replaceString: 'b', trimStrings: [], placement: [1, 2], disabled: false,
    markdownOnly: false, promptOnly: false, runOnEdit: true, substituteRegex: 0, minDepth: null, maxDepth: null, ...extra,
});

test('global regex: lossless round trip, file layout, ownership', () => {
    const data = {
        scripts: [
            script('a1', '去除 <think>', { replaceString: '' }),
            script('b2', 'CRLF 文本', { replaceString: 'line1\r\nline2' }),
            script('c3', 'x/y:z?', { futureField: { keep: true } }),
        ],
    };
    const files = decodeRegex(data);
    assert.deepEqual(Object.keys(files).sort(), [
        '01-去除 _think_.json', '01-去除 _think_.replace.txt', '02-CRLF 文本.json', '02-CRLF 文本.replace.txt',
        '03-x_y_z_.json', '03-x_y_z_.replace.txt', 'cellar-item.json',
    ].sort());
    assert.equal(files['01-去除 _think_.replace.txt'], '');
    assert.ok(!('replaceString' in JSON.parse(files['02-CRLF 文本.json'])));
    assert.deepEqual(encodeRegex(files), data);
    for (const f of Object.keys(files)) assert.ok(ownsRegexFile(f), f);
    assert.ok(!ownsRegexFile('notes.md'));
    assert.ok(!ownsRegexFile('regex/01-a.json'));
});

test('global regex: empty list, missing list and non-list stay as they were', () => {
    for (const data of [{ scripts: [] }, {}, { scripts: 'weird' }, { scripts: [1, 2] }, { scripts: [], other: 1 }]) {
        assert.deepEqual(encodeRegex(decodeRegex(data)), data, JSON.stringify(data));
    }
});

test('global regex: file order decides script order; renaming a file keeps it', () => {
    const files = decodeRegex({ scripts: [script('a', 'A'), script('b', 'B')] });
    const moved = { ...files };
    moved['00-B.json'] = moved['02-B.json']; moved['00-B.replace.txt'] = moved['02-B.replace.txt'];
    delete moved['02-B.json']; delete moved['02-B.replace.txt'];
    assert.deepEqual(encodeRegex(moved).scripts.map(s => s.id), ['b', 'a']);
});

test('global regex: slots per script id, merge of different scripts, conflict on the same one', () => {
    const base = { scripts: [script('a', 'A'), script('b', 'B')] };
    assert.deepEqual(assemble('regex', slotsOf('regex', base)), base);
    const local = structuredClone(base); local.scripts[0].findRegex = '/local/';
    const remote = structuredClone(base); remote.scripts[1].disabled = true; remote.scripts.push(script('c', 'C'));
    const merged = merge3('regex', base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.equal(merged.data.scripts[0].findRegex, '/local/');
    assert.equal(merged.data.scripts[1].disabled, true);
    assert.deepEqual(merged.data.scripts.map(s => s.id), ['a', 'b', 'c']);

    const remote2 = structuredClone(base); remote2.scripts[0].findRegex = '/remote/';
    const clash = merge3('regex', base, local, remote2);
    assert.deepEqual(clash.conflicts, ['regex.#a']);
    assert.equal(slotLabel('regex.#a', base.scripts[0]), '正则「A」');
});
