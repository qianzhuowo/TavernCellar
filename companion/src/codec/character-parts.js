/**
 * Character card parts split into their own files: regex scripts, Tavern Helper scripts and variables.
 * See docs/workspace-format.md §3.
 *
 * Layout (NN = 1-based position, zero-padded; the number decides the order, the name is cosmetic):
 *   regex/NN-<scriptName>.json          regex script without replaceString
 *   regex/NN-<scriptName>.replace.txt   its replaceString
 *   scripts/NN-<name>.json              Tavern Helper script without content
 *   scripts/NN-<name>.js                its content
 *   variables.json                      Tavern Helper variables
 *
 * Tavern Helper stores its data in three shapes; the shape is recorded in meta.helper and restored on encode:
 *   object  data.extensions.tavern_helper = { scripts, variables, ... }
 *   pairs   data.extensions.tavern_helper = [["scripts", [...]], ["variables", {...}], ...]
 *   legacy  data.extensions.TavernHelper_scripts = [...]   (scripts only)
 * Anything that does not match these shapes stays verbatim in card.json.
 */
import { deepClone, getPath, hasPath, isPlainObject, setPath, unsetPath } from './object-path.js';
import { needsRaw, normalizeText, safeSegment } from './text.js';

export const REGEX_PATH = 'data.extensions.regex_scripts';
export const HELPER_PATH = 'data.extensions.tavern_helper';
export const LEGACY_SCRIPTS_PATH = 'data.extensions.TavernHelper_scripts';
export const VARIABLES_FILE = 'variables.json';

const REGEX_JSON_RE = /^regex\/(\d+)-([^/]*)\.json$/;
const SCRIPT_JSON_RE = /^scripts\/(\d+)-([^/]*)\.json$/;
const OWNED_RE = [/^regex\/\d+-[^/]*\.(json|replace\.txt)$/, /^scripts\/\d+-[^/]*\.(json|js)$/];

/** True for files written by this module. */
export function ownsPartFile(rel) {
    return rel === VARIABLES_FILE || OWNED_RE.some(re => re.test(rel));
}

const json = value => JSON.stringify(value, null, 2) + '\n';
const stemWidth = n => Math.max(2, String(n).length);

/**
 * Writes `list` as numbered file pairs: `<stem>.json` (the object without `textKey`) and `<stem><textExt>` (its text).
 * Returns false (and writes nothing) when an element is not a plain object or its text is not a string.
 */
function splitList(list, { dir, nameKey, textKey, textExt, rawPrefix }, files, meta) {
    if (!list.every(x => isPlainObject(x) && (x[textKey] === undefined || typeof x[textKey] === 'string'))) return false;
    const width = stemWidth(list.length);
    list.forEach((item, i) => {
        const stem = `${dir}/${String(i + 1).padStart(width, '0')}-${safeSegment(item[nameKey] || dir, 60)}`;
        const { [textKey]: text, ...rest } = item;
        files[`${stem}.json`] = json(rest);
        if (typeof text === 'string') {
            files[`${stem}${textExt}`] = text;
            if (needsRaw(text)) meta.raw.push(`${rawPrefix}.${i}.${textKey}`);
        }
    });
    return true;
}

/** Reads numbered file pairs back into a list, ordered by number (then name). */
function joinList(files, { re, textKey, textExt, rawPrefix }, raw) {
    return Object.keys(files)
        .map(name => ({ name, match: re.exec(name) }))
        .filter(x => x.match)
        .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || a.name.localeCompare(b.name))
        .map(({ name }, i) => {
            let item;
            try {
                item = JSON.parse(files[name].replace(/^\uFEFF/, ''));
            } catch (error) {
                throw new Error(`${name}: invalid JSON (${error.message})`);
            }
            if (!isPlainObject(item)) throw new Error(`${name}: expected a JSON object`);
            const textFile = name.replace(/\.json$/, textExt);
            if (files[textFile] !== undefined) item[textKey] = normalizeText(files[textFile], raw.has(`${rawPrefix}.${i}.${textKey}`));
            return item;
        });
}

const REGEX_SPEC = { dir: 'regex', nameKey: 'scriptName', textKey: 'replaceString', textExt: '.replace.txt', rawPrefix: REGEX_PATH, re: REGEX_JSON_RE };
const SCRIPT_SPEC = { dir: 'scripts', nameKey: 'name', textKey: 'content', textExt: '.js', rawPrefix: 'helper.scripts', re: SCRIPT_JSON_RE };

/** Recognizes the Tavern Helper shape; returns { form, helper (object view), keys? } or null. */
function readHelper(card) {
    const value = getPath(card, HELPER_PATH);
    if (isPlainObject(value)) return { form: 'object', helper: value };
    if (Array.isArray(value) && value.every(p => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string')) {
        const keys = value.map(p => p[0]);
        if (new Set(keys).size === keys.length) return { form: 'pairs', helper: Object.fromEntries(value), keys };
    }
    const legacy = getPath(card, LEGACY_SCRIPTS_PATH);
    if (Array.isArray(legacy)) return { form: 'legacy', helper: { scripts: legacy } };
    return null;
}

/**
 * Moves regex scripts, Tavern Helper scripts and variables out of `rest` (the card being decoded) into `files`.
 * Records what it did in `meta` (`meta.raw`, `meta.emptyArrays`, `meta.helper`).
 */
export function splitParts(rest, files, meta) {
    const regex = getPath(rest, REGEX_PATH);
    if (hasPath(rest, REGEX_PATH) && Array.isArray(regex) && splitList(regex, REGEX_SPEC, files, meta)) {
        if (regex.length === 0) meta.emptyArrays.push(REGEX_PATH);
        unsetPath(rest, REGEX_PATH);
    }

    const found = readHelper(rest);
    if (!found) return;
    const { form, helper } = found;
    const info = { form };
    const remaining = { ...helper };
    if (Array.isArray(helper.scripts) && splitList(helper.scripts, SCRIPT_SPEC, files, meta)) {
        info.scripts = true;
        delete remaining.scripts;
    }
    if (form !== 'legacy' && isPlainObject(helper.variables)) {
        files[VARIABLES_FILE] = json(helper.variables);
        info.variables = true;
        delete remaining.variables;
    }
    if (!info.scripts && !info.variables) return;

    if (form === 'legacy') {
        unsetPath(rest, LEGACY_SCRIPTS_PATH);
    } else if (form === 'pairs') {
        info.keys = found.keys;
        setPath(rest, HELPER_PATH, found.keys.filter(k => k in remaining).map(k => [k, remaining[k]]));
    } else {
        setPath(rest, HELPER_PATH, remaining);
    }
    meta.helper = info;
}

/** Inverse of splitParts: puts the parts from `files` back into `card`. */
export function joinParts(card, files, meta) {
    const raw = new Set(meta.raw ?? []);

    const regex = joinList(files, REGEX_SPEC, raw);
    if (regex.length > 0) setPath(card, REGEX_PATH, regex);
    else if ((meta.emptyArrays ?? []).includes(REGEX_PATH)) setPath(card, REGEX_PATH, []);

    const info = meta.helper;
    if (!info) return;
    const parts = {};
    if (info.scripts) parts.scripts = joinList(files, SCRIPT_SPEC, raw);
    if (info.variables && files[VARIABLES_FILE] !== undefined) {
        try {
            parts.variables = JSON.parse(files[VARIABLES_FILE].replace(/^\uFEFF/, ''));
        } catch (error) {
            throw new Error(`${VARIABLES_FILE}: invalid JSON (${error.message})`);
        }
    }

    if (info.form === 'legacy') {
        if (parts.scripts) setPath(card, LEGACY_SCRIPTS_PATH, parts.scripts);
    } else if (info.form === 'pairs') {
        const current = getPath(card, HELPER_PATH);
        const merged = { ...(Array.isArray(current) ? Object.fromEntries(current) : {}), ...parts };
        const order = [...info.keys.filter(k => k in merged), ...Object.keys(merged).filter(k => !info.keys.includes(k))];
        setPath(card, HELPER_PATH, order.map(k => [k, merged[k]]));
    } else {
        const current = getPath(card, HELPER_PATH);
        setPath(card, HELPER_PATH, { ...(isPlainObject(current) ? deepClone(current) : {}), ...parts });
    }
}
