/**
 * Character card <-> workspace files. See docs/workspace-format.md §3.
 * Input/output is the canonical card JSON (what the PNG stores; JSON.parse(json_data)).
 */
import { deepClone, getPath, hasPath, isPlainObject, setPath, unsetPath } from './object-path.js';
import { needsRaw, normalizeText } from './text.js';
import { HELPER_PATH, LEGACY_SCRIPTS_PATH, REGEX_PATH, hasHelper, joinParts, ownsPartFile, splitParts } from './character-parts.js';
import { XB_TASKS_PATH, XB_TEMPLATE_PATH, XB_VARIABLES_PATH, hasXiaobaix, joinXiaobaix, ownsXiaobaixFile, splitXiaobaix } from './character-xiaobaix.js';
import { joinBook, ownsBookFile, splitBook } from './character-book.js';

export const META_FILE = 'cellar-item.json';
export const CARD_FILE = 'card.json';
/**
 * 2: regex / Tavern Helper scripts / variables in their own files. 3: embedded character book entries too.
 * 4: "extraction" parts: the base text fields always have their own files; first_mes follows the greetings part.
 * 5: Tavern Helper scripts + variables are one part ('helper'), extracted only when non-empty; LittleWhiteBox data
 *    is the new 'xiaobaix' part.
 */
export const CHARACTER_CODEC_VERSION = 5;
const CODEC_VERSION = CHARACTER_CODEC_VERSION;

/** Long text fields split into their own files: [file, card path]. */
export const TEXT_FIELDS = Object.freeze([
    ['description.md', 'data.description'],
    ['personality.md', 'data.personality'],
    ['scenario.md', 'data.scenario'],
    ['first_mes.md', 'data.first_mes'],
    ['mes_example.md', 'data.mes_example'],
    ['system_prompt.md', 'data.system_prompt'],
    ['post_history_instructions.md', 'data.post_history_instructions'],
    ['creator_notes.md', 'data.creator_notes'],
    ['depth_prompt.md', 'data.extensions.depth_prompt.prompt'],
]);

/** Top-level fields that mirror V2 data fields (V1 legacy, plus copies TauriTavern keeps): [top-level key, card path]. */
export const V1_MIRRORS = Object.freeze([
    ['description', 'data.description'],
    ['personality', 'data.personality'],
    ['scenario', 'data.scenario'],
    ['first_mes', 'data.first_mes'],
    ['mes_example', 'data.mes_example'],
    ['creatorcomment', 'data.creator_notes'],
    ['creator_notes', 'data.creator_notes'],
    ['system_prompt', 'data.system_prompt'],
    ['post_history_instructions', 'data.post_history_instructions'],
]);

const GREETINGS_PATH = 'data.alternate_greetings';
const FIRST_MES_PATH = 'data.first_mes';
const GREETING_FILE_RE = /^alternate_greetings\/(\d+)\.md$/;
const TEXT_FIELD_FILES = new Set(TEXT_FIELDS.map(([file]) => file));

/** True for files the character codec reads or writes (see CODECS.owns). */
export function ownsCharacterFile(rel) {
    return rel === CARD_FILE || rel === META_FILE || TEXT_FIELD_FILES.has(rel) || GREETING_FILE_RE.test(rel) || ownsPartFile(rel) || ownsXiaobaixFile(rel) || ownsBookFile(rel);
}

/**
 * Parts of a character card the user extracts for editing ("文件提取"). An extracted part gets its own files and is
 * loaded by Studio's editor; a part that is not extracted stays inside card.json and is not loaded (item layout
 * `exclude` lists those). The base fields (name, description, personality, scenario, mes_example, prompt overrides,
 * character note, creator metadata, talkativeness) are always extracted.
 *   greetings       first_mes + alternate_greetings (开场白)
 *   regex           data.extensions.regex_scripts
 *   xiaobaix        LittleWhiteBox (小白X) tasks, template and variables (character-xiaobaix.js)
 *   helper          Tavern Helper scripts and variables
 *   character_book  embedded lorebook entries (checkout also takes the lorebook bound in extensions.world)
 * xiaobaix and helper are optional: a card without such data has nothing to extract (see presentParts).
 */
export const CHARACTER_PARTS = Object.freeze(['greetings', 'regex', 'xiaobaix', 'helper', 'character_book']);
/** Part ids of older workspaces (codec <= 3 'fields'; codec <= 4 'scripts' / 'variables'), see migrateExclude. */
export const RETIRED_PARTS = Object.freeze(['fields', 'scripts', 'variables']);

/** Card paths each part covers, for editors that load only the extracted parts. */
const PART_PATHS = Object.freeze({
    greetings: [FIRST_MES_PATH, 'first_mes', GREETINGS_PATH],
    regex: [REGEX_PATH],
    xiaobaix: [XB_TASKS_PATH, XB_TEMPLATE_PATH, XB_VARIABLES_PATH],
    helper: [HELPER_PATH, LEGACY_SCRIPTS_PATH],
    character_book: ['data.character_book'],
});

/** Optional parts the card actually has data for (Studio shows only those). */
export function presentParts(card) {
    return [...(hasXiaobaix(card) ? ['xiaobaix'] : []), ...(hasHelper(card) ? ['helper'] : [])];
}

/**
 * Layout `exclude` of an item written by an older codec, in today's part ids. 'scripts' left out -> 'helper' left out
 * ('variables' alone was never left out of the editor); 'fields' is gone. Before codec 5 LittleWhiteBox data stayed in
 * card.json, so it stays there (not extracted) unless the user extracts it.
 */
export function migrateExclude(exclude, fromCodec) {
    const out = new Set();
    for (const part of exclude ?? []) {
        if (part === 'scripts') out.add('helper');
        else if (!RETIRED_PARTS.includes(part)) out.add(part);
    }
    if (fromCodec < 5) out.add('xiaobaix');
    return CHARACTER_PARTS.filter(p => out.has(p));
}

/**
 * The card without the parts that are not extracted. `omitted` names the parts actually left out (a part the card
 * does not have is not listed); hand it back to restoreParts when saving.
 * @param {object} card canonical card JSON
 * @param {string[]} exclude parts that are not extracted
 * @returns {{data: object, omitted: string[]}}
 */
export function omitParts(card, exclude) {
    const data = deepClone(card);
    const omitted = [];
    for (const part of CHARACTER_PARTS) {
        if (!exclude.includes(part)) continue;
        const present = PART_PATHS[part].filter(path => hasPath(data, path));
        if (!present.length) continue;
        for (const path of present) unsetPath(data, path);
        omitted.push(part);
    }
    return { data, omitted };
}

/**
 * Puts the parts an editor did not load back from `full` (the card as stored), at their original key positions, so
 * a partial edit never drops or reorders them. Changes `data` in place.
 * @param {object} data card from the editor
 * @param {object} full card as stored in the workspace
 * @param {string[]} omitted parts the editor did not load (from omitParts)
 */
export function restoreParts(data, full, omitted) {
    for (const part of omitted) {
        if (!Object.hasOwn(PART_PATHS, part)) throw new Error(`Unknown part: ${part}`);
        for (const path of PART_PATHS[part]) putBack(data, full, path);
    }
    return data;
}

function putBack(target, source, path) {
    const keys = path.split('.');
    const leaf = keys.pop();
    const parentPath = keys.join('.');
    const src = parentPath ? getPath(source, parentPath) : source;
    if (!isPlainObject(src) || !Object.hasOwn(src, leaf)) {
        unsetPath(target, path);
        return;
    }
    const value = deepClone(src[leaf]);
    const dst = parentPath ? getPath(target, parentPath) : target;
    if (!isPlainObject(dst)) {
        setPath(target, path, value);
        return;
    }
    // Insert before the first key that follows it in the stored card, keeping the stored key order.
    const order = Object.keys(src);
    const later = new Set(order.slice(order.indexOf(leaf) + 1));
    const entries = Object.entries(dst).filter(([key]) => key !== leaf);
    const at = entries.findIndex(([key]) => later.has(key));
    entries.splice(at < 0 ? entries.length : at, 0, [leaf, value]);
    for (const key of Object.keys(dst)) delete dst[key];
    for (const [key, v] of entries) Object.defineProperty(dst, key, { value: v, enumerable: true, writable: true, configurable: true });
}

/**
 * @param {object} card canonical card JSON
 * @param {{exclude?: string[]}} [options] parts that are not extracted and stay in card.json (see CHARACTER_PARTS)
 * @returns {Record<string,string>} files keyed by item-relative path ("/" separated)
 */
export function decodeCharacter(card, { exclude = [] } = {}) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('Character card must be an object');
    const skip = new Set(exclude);
    const rest = deepClone(card);
    const meta = { kind: 'character', codec: CODEC_VERSION, mirrors: [], raw: [], emptyArrays: [] };
    const files = {};

    for (const [top, path] of V1_MIRRORS) {
        if (Object.prototype.hasOwnProperty.call(rest, top) && typeof rest[top] === 'string' && getPath(rest, path) === rest[top]) {
            meta.mirrors.push(top);
            delete rest[top];
        }
    }

    for (const [file, path] of TEXT_FIELDS) {
        if (path === FIRST_MES_PATH && skip.has('greetings')) continue;
        const value = getPath(rest, path);
        if (hasPath(rest, path) && typeof value === 'string') {
            files[file] = value;
            if (needsRaw(value)) meta.raw.push(path);
            unsetPath(rest, path);
        }
    }

    const greetings = getPath(rest, GREETINGS_PATH);
    if (!skip.has('greetings') && hasPath(rest, GREETINGS_PATH) && Array.isArray(greetings) && greetings.every(g => typeof g === 'string')) {
        if (greetings.length === 0) meta.emptyArrays.push(GREETINGS_PATH);
        const width = Math.max(2, String(greetings.length).length);
        greetings.forEach((text, i) => {
            files[`alternate_greetings/${String(i + 1).padStart(width, '0')}.md`] = text;
            if (needsRaw(text)) meta.raw.push(`${GREETINGS_PATH}.${i}`);
        });
        unsetPath(rest, GREETINGS_PATH);
    }

    if (!skip.has('xiaobaix')) splitXiaobaix(rest, files, meta);
    splitParts(rest, files, meta, skip);
    if (!skip.has('character_book')) splitBook(rest, files, meta);

    files[CARD_FILE] = JSON.stringify(rest, null, 2) + '\n';
    files[META_FILE] = JSON.stringify(meta, null, 2) + '\n';
    return files;
}

/**
 * @param {Record<string,string>} files
 * @returns {object} canonical card JSON
 */
export function encodeCharacter(files) {
    const meta = parseJsonFile(files, META_FILE);
    if (meta.kind !== 'character') throw new Error(`${META_FILE}: expected kind "character", got "${meta.kind}"`);
    const card = files[CARD_FILE] === undefined ? {} : parseJsonFile(files, CARD_FILE);
    const raw = new Set(meta.raw ?? []);

    for (const [file, path] of TEXT_FIELDS) {
        if (files[file] !== undefined) setPath(card, path, normalizeText(files[file], raw.has(path)));
    }

    const greetingFiles = Object.keys(files)
        .map(name => ({ name, match: GREETING_FILE_RE.exec(name) }))
        .filter(x => x.match)
        .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || a.name.localeCompare(b.name));
    if (greetingFiles.length > 0) {
        setPath(card, GREETINGS_PATH, greetingFiles.map((x, i) => normalizeText(files[x.name], raw.has(`${GREETINGS_PATH}.${i}`))));
    } else if ((meta.emptyArrays ?? []).includes(GREETINGS_PATH)) {
        setPath(card, GREETINGS_PATH, []);
    }

    joinParts(card, files, meta);
    joinXiaobaix(card, files, meta);
    joinBook(card, files, meta);

    for (const top of meta.mirrors ?? []) {
        const path = V1_MIRRORS.find(([key]) => key === top)?.[1];
        if (path && hasPath(card, path)) card[top] = getPath(card, path);
    }

    return card;
}

export function parseJsonFile(files, name) {
    if (files[name] === undefined) throw new Error(`Missing ${name}`);
    try {
        return JSON.parse(files[name].replace(/^\uFEFF/, ''));
    } catch (error) {
        throw new Error(`${name}: invalid JSON (${error.message})`);
    }
}
