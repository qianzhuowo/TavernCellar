import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePreset, encodePreset, ownsPresetFile } from '../src/codec/preset.js';
import { merge3, slotsOf, assemble, slotLabel } from '../src/codec/slots.js';
import { codecFor } from '../src/codec/index.js';
import { parsePresetId } from '../../shared/protocol.js';

const prompt = (identifier, name, content, extra = {}) => ({ name, system_prompt: true, role: 'system', content, identifier, ...extra });
const oai = () => ({
    temperature: 1,
    prompts: [
        prompt('main', 'Main Prompt', 'Write {{char}}\'s next reply.'),
        prompt('chatHistory', 'Chat History', undefined, { marker: true }),
        prompt('a1b2', '文风/规则?', 'line1\r\nline2', { injection_position: 1, injection_depth: 4, forbid_overrides: false }),
    ].map(p => (p.content === undefined ? (({ content, ...r }) => r)(p) : p)),
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }, { identifier: 'a1b2', enabled: false }] }],
    openai_max_tokens: 300,
    extensions: { regex_scripts: [{ id: 'r1', scriptName: '去除思考', findRegex: '/<think>[\\s\\S]*?<\\/think>/g', replaceString: '', placement: [2] }], tavern_helper: { scripts: [] } },
    future_field: { keep: true },
});

test('preset ids: apiId/name, validated', () => {
    assert.deepEqual(parsePresetId('openai/测试预设_v3'), { apiId: 'openai', name: '测试预设_v3' });
    for (const bad of ['openai', 'unknown/x', 'openai/', 'openai/a/b', 'openai/..', 'openai/a:b']) assert.throws(() => parsePresetId(bad), bad);
    assert.equal(codecFor('preset').nameOf('openai/A B'), 'openai-A B');
});

test('chat-completion preset: prompts and preset regex split, lossless incl. key order', () => {
    const data = oai();
    const files = decodePreset(data, { apiId: 'openai' });
    const names = Object.keys(files).sort();
    assert.deepEqual(names, [
        'cellar-item.json', 'preset.json',
        'prompts/1-Main Prompt.json', 'prompts/1-Main Prompt.md', 'prompts/2-Chat History.json',
        'prompts/3-文风_规则_.json', 'prompts/3-文风_规则_.md',
        'regex/1-去除思考.json', 'regex/1-去除思考.replace.txt',
    ].map(n => n.replace(/\/(\d)-/, '/0$1-')).sort());
    assert.equal(files['prompts/03-文风_规则_.md'], 'line1\r\nline2');
    const preset = JSON.parse(files['preset.json']);
    assert.ok(!('prompts' in preset) && !('regex_scripts' in preset.extensions));
    const back = encodePreset(files);
    assert.deepEqual(back, data);
    assert.deepEqual(Object.keys(back), Object.keys(data));
    assert.deepEqual(Object.keys(back.extensions), Object.keys(data.extensions));
    for (const f of names) assert.ok(ownsPresetFile(f), f);
    assert.ok(!ownsPresetFile('notes.md') && !ownsPresetFile('prompts/notes.md'));
});

test('editing a prompt file; reordering by number; non-openai presets stay whole', () => {
    const files = decodePreset(oai(), { apiId: 'openai' });
    files['prompts/01-Main Prompt.md'] = 'Edited\r\n'; // editor added CRLF: normalized (original had none)
    assert.equal(encodePreset(files).prompts[0].content, 'Edited\n');
    const flat = { name: 'Alpaca', input_sequence: '### Instruction:\n', wrap: true };
    const ff = decodePreset(flat, { apiId: 'instruct' });
    assert.deepEqual(Object.keys(ff).sort(), ['cellar-item.json', 'preset.json']);
    assert.deepEqual(encodePreset(ff), flat);
    // openai preset with prompts that are not objects: kept whole
    const odd = { prompts: 'x', extensions: { regex_scripts: 3 } };
    assert.deepEqual(encodePreset(decodePreset(odd, { apiId: 'openai' })), odd);
});

test('preset slots: prompts by identifier, regex by id, order per character', () => {
    const base = oai();
    assert.deepEqual(assemble('preset', slotsOf('preset', base)), base);
    const local = structuredClone(base); local.prompts[0].content = 'local';
    const remote = structuredClone(base); remote.extensions.regex_scripts[0].disabled = true; remote.temperature = 0.7;
    const merged = merge3('preset', base, local, remote);
    assert.deepEqual(merged.conflicts, []);
    assert.equal(merged.data.prompts[0].content, 'local');
    assert.equal(merged.data.extensions.regex_scripts[0].disabled, true);
    assert.equal(merged.data.temperature, 0.7);
    const remote2 = structuredClone(base); remote2.prompts[0].content = 'remote';
    assert.deepEqual(merge3('preset', base, local, remote2).conflicts, ['prompt.#main']);
    assert.equal(slotLabel('prompt.#main', base.prompts[0]), '提示词「Main Prompt」');
    assert.equal(slotLabel('porder.#100001'), '提示词顺序（全局）');
});

test('split text fields return to their original key position (tavern file key order is kept)', () => {
    // tt writes keys sorted (content first); ST puts content mid-object.
    const data = {
        prompts: [
            { content: 'A', identifier: 'x', name: 'X', role: 'system' },
            { name: 'Y', content: 'B', identifier: 'y' },
            { identifier: 'z', name: 'Z', content: 'C' },
        ],
        extensions: { regex_scripts: [{ findRegex: '/a/g', id: 'r1', replaceString: 'b', scriptName: 'R' }] },
    };
    const files = decodePreset(data, { apiId: 'openai' });
    const back = encodePreset(files);
    assert.equal(JSON.stringify(back), JSON.stringify(data));
    // Editing the text keeps the position; the last-position entry records nothing.
    const meta = JSON.parse(files['cellar-item.json']);
    assert.deepEqual(meta.textPos, { 'prompts.0': 0, 'prompts.1': 1, 'extensions.regex_scripts.0': 2 });
    const edited = encodePreset({ ...files, 'prompts/01-X.md': 'A2' });
    assert.deepEqual(Object.keys(edited.prompts[0]), ['content', 'identifier', 'name', 'role']);
    assert.equal(edited.prompts[0].content, 'A2');
});
