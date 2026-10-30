import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, merge3, slotLabel, slotsOf } from '../src/codec/slots.js';

const card = () => ({
    spec: 'chara_card_v3',
    data: {
        name: 'A', description: 'd0', personality: 'p0', alternate_greetings: ['g1', 'g2'],
        extensions: {
            world: 'W',
            regex_scripts: [{ id: 'r1', scriptName: 'one', findRegex: 'a' }, { id: 'r2', scriptName: 'two', findRegex: 'b' }],
            tavern_helper: { scripts: [{ id: 's1', name: 'S', content: 'x' }], variables: { hp: 1 }, enabled: true },
        },
        character_book: { name: 'B', entries: [{ id: 1, comment: 'e1', content: 'c1' }, { id: 2, comment: 'e2', content: 'c2' }] },
    },
});
const book = () => ({ name: 'L', entries: { 0: { uid: 0, comment: 'a', content: 'x' }, 1: { uid: 1, comment: 'b', content: 'y' } } });
const edit = (data, fn) => { const copy = structuredClone(data); fn(copy); return copy; };

test('slots: assemble(slotsOf(x)) deep-equals x', () => {
    for (const [kind, data] of [['character', card()], ['lorebook', book()], ['character', { name: 'v1 only' }], ['character', { data: { extensions: { tavern_helper: [['scripts', []]] } } }]]) {
        assert.deepEqual(assemble(kind, slotsOf(kind, data)), data);
    }
});

test('merge: changes to different slots merge automatically', () => {
    const base = card();
    const local = edit(base, d => { d.data.description = 'L'; d.data.extensions.regex_scripts[0].findRegex = 'L'; });
    const remote = edit(base, d => { d.data.personality = 'R'; d.data.character_book.entries[1].content = 'R'; d.data.extensions.tavern_helper.variables.hp = 9; });
    const { data, conflicts } = merge3('character', base, local, remote);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(data, edit(base, d => {
        d.data.description = 'L'; d.data.extensions.regex_scripts[0].findRegex = 'L';
        d.data.personality = 'R'; d.data.character_book.entries[1].content = 'R'; d.data.extensions.tavern_helper.variables.hp = 9;
    }));
});

test('merge: the same slot changed differently is reported alone and keeps the workspace value', () => {
    const base = card();
    const local = edit(base, d => { d.data.description = 'L'; d.data.alternate_greetings[1] = 'gL'; });
    const remote = edit(base, d => { d.data.description = 'R'; d.data.personality = 'R'; });
    const { data, conflicts } = merge3('character', base, local, remote);
    assert.deepEqual(conflicts, ['data.description']);
    assert.equal(data.data.description, 'L');
    assert.equal(data.data.personality, 'R', 'other slots still merge');
    assert.equal(data.data.alternate_greetings[1], 'gL');
    assert.equal(slotLabel('data.description'), '角色描述');
});

test('merge: the same change on both sides is no conflict', () => {
    const base = book();
    const both = edit(base, d => { d.entries[0].content = 'same'; });
    assert.deepEqual(merge3('lorebook', base, both, structuredClone(both)), { data: both, conflicts: [] });
});

test('merge: delete vs edit conflicts; delete vs untouched deletes', () => {
    const base = book();
    const local = edit(base, d => { delete d.entries[1]; delete d.entries[0]; });
    const remote = edit(base, d => { d.entries[1].content = 'edited'; });
    const { data, conflicts } = merge3('lorebook', base, local, remote);
    assert.deepEqual(conflicts, ['entry.1']);
    assert.equal(data.entries[0], undefined, 'entry 0 deleted (other side did not touch it)');
    assert.equal(data.entries[1], undefined, 'conflicting slot keeps the workspace side (deleted)');
    assert.match(slotLabel('entry.1', remote.entries[1]), /条目「b」/);
});

test('merge: entries and regex scripts added on both sides are all kept', () => {
    const base = book();
    const { data, conflicts } = merge3('lorebook', base,
        edit(base, d => { d.entries[2] = { uid: 2, content: 'L' }; }),
        edit(base, d => { d.entries[3] = { uid: 3, content: 'R' }; }));
    assert.deepEqual(conflicts, []);
    assert.deepEqual(Object.keys(data.entries), ['0', '1', '2', '3']);

    const c = card();
    const merged = merge3('character', c,
        edit(c, d => { d.data.extensions.regex_scripts.push({ id: 'rL' }); }),
        edit(c, d => { d.data.extensions.regex_scripts.splice(0, 1); d.data.extensions.regex_scripts.push({ id: 'rR' }); }));
    assert.deepEqual(merged.conflicts, []);
    assert.deepEqual(merged.data.data.extensions.regex_scripts.map(r => r.id), ['r2', 'rL', 'rR']);
});

test('merge: order and content change together; reorders on both sides conflict', () => {
    const base = card();
    const local = edit(base, d => { d.data.extensions.regex_scripts.reverse(); });
    const remote = edit(base, d => { d.data.extensions.regex_scripts[0].findRegex = 'R'; });
    const { data, conflicts } = merge3('character', base, local, remote);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(data.data.extensions.regex_scripts, [{ id: 'r2', scriptName: 'two', findRegex: 'b' }, { id: 'r1', scriptName: 'one', findRegex: 'R' }]);

    const both = merge3('character', base, local, edit(base, d => { d.data.extensions.regex_scripts.push(d.data.extensions.regex_scripts.shift()); d.data.extensions.regex_scripts.unshift({ id: 'r0' }); }));
    assert.deepEqual(both.conflicts, []);
    const real = merge3('character', edit(base, d => { d.data.extensions.regex_scripts.push({ id: 'r3' }); }),
        edit(base, d => { d.data.extensions.regex_scripts = [{ id: 'r3' }, ...d.data.extensions.regex_scripts]; }),
        edit(base, d => { d.data.extensions.regex_scripts = [d.data.extensions.regex_scripts[1], { id: 'r3' }, d.data.extensions.regex_scripts[0]]; }));
    assert.deepEqual(real.conflicts, ['regex.$order']);
});
