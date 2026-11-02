/**
 * Global regex scripts <-> workspace files. See docs/workspace-format.md §5.
 *
 * Item data (what Cellar Link reports for kind "regex", id "global"): { scripts: extension_settings.regex }.
 * Files use the same layout as a card's regex scripts (character-parts.js), one pair per script:
 *   NN-<scriptName>.json          the script without replaceString
 *   NN-<scriptName>.replace.txt   its replaceString
 *   cellar-item.json              meta (raw text markers, other keys of the data object)
 */
import { deepClone, isPlainObject } from './object-path.js';
import { joinList, splitList, REGEX_SPEC } from './character-parts.js';
import { META_FILE, parseJsonFile } from './character.js';
import { GLOBAL_REGEX_ID } from '../../../shared/protocol.js';

export { GLOBAL_REGEX_ID };
export const REGEX_CODEC_VERSION = 1;

const SPEC = { ...REGEX_SPEC, dir: '', re: /^(\d+)-([^/]*)\.json$/, rawPrefix: 'scripts' };
const OWNED_RE = /^\d+-[^/]*\.(json|replace\.txt)$/;

export function ownsRegexFile(rel) {
    return rel === META_FILE || OWNED_RE.test(rel);
}

export function decodeRegex(data) {
    if (!isPlainObject(data)) throw new Error('Regex data must be an object');
    const { scripts, ...rest } = deepClone(data);
    const meta = { kind: 'regex', codec: REGEX_CODEC_VERSION, raw: [], rest };
    const files = {};
    if (scripts === undefined) meta.absent = true;
    else if (!Array.isArray(scripts) || !splitList(scripts, SPEC, files, meta)) meta.opaque = scripts; // not a script list: verbatim
    files[META_FILE] = JSON.stringify(meta, null, 2) + '\n';
    return files;
}

export function encodeRegex(files) {
    const meta = parseJsonFile(files, META_FILE);
    if (meta.kind !== 'regex') throw new Error(`${META_FILE}: expected kind "regex", got "${meta.kind}"`);
    const data = isPlainObject(meta.rest) ? deepClone(meta.rest) : {};
    if (meta.absent) return data;
    if (meta.opaque !== undefined) return { ...data, scripts: deepClone(meta.opaque) };
    return { ...data, scripts: joinList(files, SPEC, meta) };
}
