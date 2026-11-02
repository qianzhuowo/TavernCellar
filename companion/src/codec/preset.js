/**
 * Tavern presets <-> workspace files. See docs/workspace-format.md §6.
 *
 * Item data: the preset file content exactly as stored (`<data>/<preset folder>/<name>.json`).
 * Chat-completion presets (apiId "openai") are split further:
 *   preset.json                       everything not listed below
 *   prompts/NNN-<name>.json           one prompt of `prompts`, without `content`
 *   prompts/NNN-<name>.md             its content (marker prompts have none)
 *   regex/NN-<scriptName>.json        preset regex (extensions.regex_scripts), as for character cards
 *   regex/NN-<scriptName>.replace.txt
 * Other preset types are flat parameter files and stay whole in preset.json.
 *   cellar-item.json                  meta: apiId, raw text markers, which lists were split
 */
import { deepClone, isPlainObject } from './object-path.js';
import { joinList, splitList, REGEX_SPEC } from './character-parts.js';
import { META_FILE, parseJsonFile } from './character.js';

export const PRESET_CODEC_VERSION = 1;
export const PRESET_FILE = 'preset.json';

const PROMPT_SPEC = { dir: 'prompts', nameKey: 'name', textKey: 'content', textExt: '.md', rawPrefix: 'prompts', re: /^prompts\/(\d+)-([^/]*)\.json$/ };
const PRESET_REGEX_SPEC = { ...REGEX_SPEC, rawPrefix: 'extensions.regex_scripts' };
const OWNED_RE = [/^prompts\/\d+-[^/]*\.(json|md)$/, /^regex\/\d+-[^/]*\.(json|replace\.txt)$/];

export function ownsPresetFile(rel) {
    return rel === META_FILE || rel === PRESET_FILE || OWNED_RE.some(re => re.test(rel));
}

const json = value => JSON.stringify(value, null, 2) + '\n';
const objectList = v => Array.isArray(v) && v.every(isPlainObject);

/** @param {object} data preset @param {{apiId?: string}} [options] */
export function decodePreset(data, { apiId } = {}) {
    if (!isPlainObject(data)) throw new Error('Preset data must be an object');
    const rest = deepClone(data);
    const meta = { kind: 'preset', codec: PRESET_CODEC_VERSION, apiId: apiId ?? null, raw: [], split: [] };
    const files = {};
    if (apiId === 'openai') {
        if (objectList(rest.prompts) && splitList(rest.prompts, PROMPT_SPEC, files, meta)) {
            meta.split.push('prompts');
            delete rest.prompts;
        }
        const ext = rest.extensions;
        if (isPlainObject(ext) && objectList(ext.regex_scripts) && splitList(ext.regex_scripts, PRESET_REGEX_SPEC, files, meta)) {
            meta.split.push('regex');
            delete ext.regex_scripts;
        }
    }
    files[PRESET_FILE] = json(rest);
    // Lists moved out are put back at their original place, so the tavern file keeps its key order.
    if (meta.split.length) {
        meta.order = Object.keys(data);
        if (isPlainObject(data.extensions)) meta.extOrder = Object.keys(data.extensions);
    }
    files[META_FILE] = json(meta);
    return files;
}

/** `obj` with its keys in `order` first (when present), then any others. */
function ordered(obj, order) {
    if (!Array.isArray(order)) return obj;
    const out = {};
    for (const k of order) if (Object.hasOwn(obj, k)) out[k] = obj[k];
    for (const k of Object.keys(obj)) if (!Object.hasOwn(out, k)) out[k] = obj[k];
    return out;
}

export function encodePreset(files) {
    const meta = parseJsonFile(files, META_FILE);
    if (meta.kind !== 'preset') throw new Error(`${META_FILE}: expected kind "preset", got "${meta.kind}"`);
    const data = parseJsonFile(files, PRESET_FILE);
    if (!isPlainObject(data)) throw new Error(`${PRESET_FILE}: expected a JSON object`);
    const split = new Set(meta.split ?? []);
    if (split.has('prompts')) data.prompts = joinList(files, PROMPT_SPEC, meta);
    if (split.has('regex')) {
        if (!isPlainObject(data.extensions)) data.extensions = {};
        data.extensions.regex_scripts = joinList(files, PRESET_REGEX_SPEC, meta);
        data.extensions = ordered(data.extensions, meta.extOrder);
    }
    return ordered(data, meta.order);
}
