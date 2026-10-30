/**
 * Lorebook (world info) <-> workspace files. See docs/workspace-format.md §4.
 * Input/output is the object returned by /api/worldinfo/get.
 */
import yaml from 'js-yaml';
import { deepClone, isPlainObject } from './object-path.js';
import { needsRaw, normalizeText, safeSegment } from './text.js';
import { META_FILE, parseJsonFile } from './character.js';
import { stableStringify } from '../../../shared/hash.js';

export const BOOK_FILE = 'book.json';
/** 2: front matter omits fields equal to the entry template snapshot stored in meta.template. */
export const LOREBOOK_CODEC_VERSION = 2;
const CODEC_VERSION = LOREBOOK_CODEC_VERSION;
/** Always written to front matter, even when equal to the template (identity and what users look for first). */
const ALWAYS_SHOWN = new Set(['uid', 'key', 'comment', 'content']);
const ENTRY_FILE_RE = /^entries\/[^/]+\.md$/;
const YAML_OPTIONS = { schema: yaml.JSON_SCHEMA, lineWidth: -1, noRefs: true };

/** True for files the lorebook codec reads or writes (see CODECS.owns). */
export function ownsLorebookFile(rel) {
    return rel === BOOK_FILE || rel === META_FILE || ENTRY_FILE_RE.test(rel);
}

export function serializeEntry(frontMatter, body) {
    return `---\n${yaml.dump(frontMatter, YAML_OPTIONS)}---\n${body}`;
}

/**
 * @param {string} text
 * @returns {{frontMatter: object, body: string}}
 */
export function parseEntry(text, fileName = 'entry') {
    const source = text.replace(/^\uFEFF/, '');
    const match = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/.exec(source);
    if (!match) return { frontMatter: {}, body: source };
    let frontMatter;
    try {
        frontMatter = match[1]?.trim() ? yaml.load(match[1], { schema: yaml.JSON_SCHEMA }) : {};
    } catch (error) {
        throw new Error(`${fileName}: invalid YAML front matter (${error.message})`);
    }
    if (frontMatter === null || frontMatter === undefined) frontMatter = {};
    if (!isPlainObject(frontMatter)) throw new Error(`${fileName}: front matter must be a mapping`);
    return { frontMatter, body: source.slice(match[0].length) };
}

function entryFileName(key, entry, used) {
    const idPart = Number.isInteger(entry.uid) && entry.uid >= 0 ? String(entry.uid).padStart(4, '0') : safeSegment(key, 20);
    const label = typeof entry.comment === 'string' && entry.comment.trim()
        ? entry.comment
        : (Array.isArray(entry.key) && typeof entry.key[0] === 'string' ? entry.key[0] : '');
    const slug = label.trim() ? safeSegment(label.replace(/\s+/g, ' '), 40) : '';
    const base = slug ? `${idPart}-${slug}` : idPart;
    let name = `entries/${base}.md`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `entries/${base}~${n}.md`;
    used.add(name.toLowerCase());
    return name;
}

/**
 * @param {object} book
 * @param {{template?: object|null}} [options] entry template snapshot: fields equal to it are left out of front matter
 * @returns {Record<string,string>}
 */
export function decodeLorebook(book, { template = null } = {}) {
    if (!isPlainObject(book)) throw new Error('Lorebook must be an object');
    const rest = deepClone(book);
    const entries = rest.entries;
    delete rest.entries;
    const tpl = isPlainObject(template) ? deepClone(template) : null;
    const meta = { kind: 'lorebook', codec: CODEC_VERSION, hasEntries: entries !== undefined, order: [], keys: {}, raw: [], noContent: [], opaque: {}, template: tpl, absent: {} };
    const files = {};
    const used = new Set();

    if (entries !== undefined && !isPlainObject(entries)) {
        meta.opaque = { $entries: entries }; // unexpected shape: keep verbatim
    } else if (entries) {
        for (const key of Object.keys(entries)) {
            const entry = entries[key];
            if (!isPlainObject(entry)) {
                meta.opaque[key] = entry;
                meta.order.push(key);
                continue;
            }
            const frontMatter = deepClone(entry);
            let body = '';
            if (typeof entry.content === 'string') {
                body = entry.content;
                delete frontMatter.content;
                if (needsRaw(body)) meta.raw.push(key);
            } else {
                meta.noContent.push(key); // missing or non-string content stays in front matter
            }
            if (tpl) {
                const absent = [];
                for (const field of Object.keys(tpl)) {
                    if (ALWAYS_SHOWN.has(field)) continue;
                    if (!Object.prototype.hasOwnProperty.call(entry, field)) absent.push(field);
                    else if (stableStringify(entry[field]) === stableStringify(tpl[field])) delete frontMatter[field];
                }
                if (absent.length) meta.absent[key] = absent;
            }
            const file = entryFileName(key, entry, used);
            if (String(entry.uid) !== key) meta.keys[file] = key;
            meta.order.push(key);
            files[file] = serializeEntry(frontMatter, body);
        }
    }

    files[BOOK_FILE] = JSON.stringify(rest, null, 2) + '\n';
    files[META_FILE] = JSON.stringify(meta, null, 2) + '\n';
    return files;
}

/**
 * @param {Record<string,string>} files
 * @param {{entryTemplate?: object}} [options] the tavern's current entry template; used for new entries only when
 *   the item has no template snapshot (meta.template)
 * @returns {object}
 */
export function encodeLorebook(files, { entryTemplate } = {}) {
    const meta = parseJsonFile(files, META_FILE);
    if (meta.kind !== 'lorebook') throw new Error(`${META_FILE}: expected kind "lorebook", got "${meta.kind}"`);
    const book = files[BOOK_FILE] === undefined ? {} : parseJsonFile(files, BOOK_FILE);
    const raw = new Set(meta.raw ?? []);
    const noContent = new Set(meta.noContent ?? []);
    const keyByFile = meta.keys ?? {};
    const snapshot = isPlainObject(meta.template) ? meta.template : null;
    /** Template fields an existing entry inherits (those it had and that were equal to the template). */
    const defaultsFor = key => {
        if (!snapshot) return {};
        const absent = new Set(meta.absent?.[key] ?? []);
        const out = {};
        for (const [field, value] of Object.entries(snapshot)) {
            if (field !== 'content' && !absent.has(field)) out[field] = deepClone(value);
        }
        return out;
    };

    if (meta.opaque && Object.prototype.hasOwnProperty.call(meta.opaque, '$entries')) {
        book.entries = meta.opaque.$entries;
        return book;
    }

    const parsed = Object.keys(files)
        .filter(name => ENTRY_FILE_RE.test(name))
        .sort((a, b) => a.localeCompare(b))
        .map(name => ({ name, ...parseEntry(files[name], name) }));

    let maxUid = -1;
    for (const { frontMatter } of parsed) {
        if (Number.isInteger(frontMatter.uid)) maxUid = Math.max(maxUid, frontMatter.uid);
    }
    for (const key of Object.keys(meta.opaque ?? {})) {
        if (/^\d+$/.test(key)) maxUid = Math.max(maxUid, Number(key));
    }

    const byKey = new Map();
    const newKeys = [];
    for (const { name, frontMatter, body } of parsed) {
        let key = keyByFile[name] ?? (frontMatter.uid !== undefined && frontMatter.uid !== null ? String(frontMatter.uid) : null);
        let entry;
        let isNew = false;
        if (key === null) {
            isNew = true;
            const uid = ++maxUid;
            entry = { ...deepClone(snapshot ?? entryTemplate ?? {}), ...frontMatter, uid };
            key = String(uid);
            newKeys.push(key);
        } else {
            entry = { ...defaultsFor(key), ...frontMatter };
        }
        if (byKey.has(key) || Object.prototype.hasOwnProperty.call(meta.opaque ?? {}, key)) {
            throw new Error(`${name}: duplicate entry uid ${key}`);
        }
        if (isNew || !noContent.has(key)) entry.content = normalizeText(body, raw.has(key));
        byKey.set(key, entry);
    }

    const entries = {};
    for (const key of meta.order ?? []) {
        if (byKey.has(key)) entries[key] = byKey.get(key);
        else if (Object.prototype.hasOwnProperty.call(meta.opaque ?? {}, key)) entries[key] = meta.opaque[key];
    }
    for (const [key, entry] of byKey) {
        if (!Object.prototype.hasOwnProperty.call(entries, key)) entries[key] = entry;
    }

    if (meta.hasEntries || Object.keys(entries).length > 0) book.entries = entries;
    return book;
}
