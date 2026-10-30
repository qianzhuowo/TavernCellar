/**
 * Character card <-> workspace files. See docs/workspace-format.md §3.
 * Input/output is the canonical card JSON (what the PNG stores; JSON.parse(json_data)).
 */
import { deepClone, getPath, hasPath, setPath, unsetPath } from './object-path.js';
import { needsRaw, normalizeText } from './text.js';
import { joinParts, ownsPartFile, splitParts } from './character-parts.js';

export const META_FILE = 'cellar-item.json';
export const CARD_FILE = 'card.json';
/** 2: regex scripts, Tavern Helper scripts and variables split into their own files. */
export const CHARACTER_CODEC_VERSION = 2;
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
const V1_MIRRORS = Object.freeze([
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
const GREETING_FILE_RE = /^alternate_greetings\/(\d+)\.md$/;
const TEXT_FIELD_FILES = new Set(TEXT_FIELDS.map(([file]) => file));

/** True for files the character codec reads or writes (see CODECS.owns). */
export function ownsCharacterFile(rel) {
    return rel === CARD_FILE || rel === META_FILE || TEXT_FIELD_FILES.has(rel) || GREETING_FILE_RE.test(rel) || ownsPartFile(rel);
}

/**
 * @param {object} card canonical card JSON
 * @returns {Record<string,string>} files keyed by item-relative path ("/" separated)
 */
export function decodeCharacter(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('Character card must be an object');
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
        const value = getPath(rest, path);
        if (hasPath(rest, path) && typeof value === 'string') {
            files[file] = value;
            if (needsRaw(value)) meta.raw.push(path);
            unsetPath(rest, path);
        }
    }

    const greetings = getPath(rest, GREETINGS_PATH);
    if (hasPath(rest, GREETINGS_PATH) && Array.isArray(greetings) && greetings.every(g => typeof g === 'string')) {
        if (greetings.length === 0) meta.emptyArrays.push(GREETINGS_PATH);
        const width = Math.max(2, String(greetings.length).length);
        greetings.forEach((text, i) => {
            files[`alternate_greetings/${String(i + 1).padStart(width, '0')}.md`] = text;
            if (needsRaw(text)) meta.raw.push(`${GREETINGS_PATH}.${i}`);
        });
        unsetPath(rest, GREETINGS_PATH);
    }

    splitParts(rest, files, meta);

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
