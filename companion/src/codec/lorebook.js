/**
 * Lorebook (world info) <-> workspace files. See docs/workspace-format.md §4.
 * Input/output is the object returned by /api/worldinfo/get.
 */
import { deepClone, isPlainObject } from './object-path.js';
import { needsRaw, normalizeText, safeSegment } from './text.js';
import { META_FILE, parseJsonFile } from './character.js';
import { stableStringify } from '../../../shared/hash.js';
import { parseEntry, serializeEntry } from './front-matter.js';

export { parseEntry, serializeEntry };

export const BOOK_FILE = 'book.json';
/** 2: front matter omits fields equal to the entry template snapshot stored in meta.template. */
export const LOREBOOK_CODEC_VERSION = 2;
const CODEC_VERSION = LOREBOOK_CODEC_VERSION;
/** Always written to front matter, even when equal to the template (identity and what users look for first). */
const ALWAYS_SHOWN = new Set(['uid', 'key', 'comment', 'content']);
const ENTRY_FILE_RE = /^entries\/(?:[^/]+\/)*[^/]+\.md$/;

/** True for files the lorebook codec reads or writes (see CODECS.owns). */
export function ownsLorebookFile(rel) {
    return rel === BOOK_FILE || rel === META_FILE || ENTRY_FILE_RE.test(rel);
}

// ---- entry groups (docs/studio-design.md §4.4) ----------------------------------------------------------------
// A Cellar group lives on the entry as extensions.cellar.group ("世界背景/地理"); in the workspace it is the
// sub-folder under entries/, and the folder is its only source there (front matter does not repeat it).

/** Folder segments for a group path, or null when it cannot be a folder losslessly (then it stays in front matter). */
function groupFolders(group) {
    if (typeof group !== 'string' || !group) return null;
    const parts = group.split('/');
    return parts.every(p => p && p !== '.' && p !== '..' && p === p.trim() && safeSegment(p, 80) === p) ? parts : null;
}

/** Group path of an entry file from its folder (entries/a/b/x.md -> "a/b"), or null at the top level. */
function groupOfFile(name) {
    const parts = name.split('/').slice(1, -1);
    return parts.length ? parts.join('/') : null;
}

/** Removes extensions.cellar.group from a front matter copy, dropping objects it leaves empty. */
function takeGroup(frontMatter) {
    const ext = frontMatter.extensions;
    if (!isPlainObject(ext) || !isPlainObject(ext.cellar)) return null;
    const folders = groupFolders(ext.cellar.group);
    if (!folders) return null;
    delete ext.cellar.group;
    if (!Object.keys(ext.cellar).length) delete ext.cellar;
    if (!Object.keys(ext).length) delete frontMatter.extensions;
    return folders;
}

/** Puts the folder's group back onto an entry (inverse of takeGroup). */
function putGroup(entry, group, name) {
    const ext = entry.extensions;
    if (isPlainObject(ext) && isPlainObject(ext.cellar) && ext.cellar.group !== undefined) {
        throw new Error(`${name}: 分组同时写在文件夹和文件头里；在工作区中用文件夹表示分组，请删掉文件头中的 extensions.cellar.group`);
    }
    if (ext !== undefined && !isPlainObject(ext)) throw new Error(`${name}: extensions 不是对象，无法记录分组`);
    if (ext?.cellar !== undefined && !isPlainObject(ext.cellar)) throw new Error(`${name}: extensions.cellar 不是对象，无法记录分组`);
    entry.extensions = { ...(ext ?? {}), cellar: { ...(ext?.cellar ?? {}), group } };
}

function entryFileName(key, entry, used, folders = null) {
    const idPart = Number.isInteger(entry.uid) && entry.uid >= 0 ? String(entry.uid).padStart(4, '0') : safeSegment(key, 20);
    const label = typeof entry.comment === 'string' && entry.comment.trim()
        ? entry.comment
        : (Array.isArray(entry.key) && typeof entry.key[0] === 'string' ? entry.key[0] : '');
    const slug = label.trim() ? safeSegment(label.replace(/\s+/g, ' '), 40) : '';
    const base = slug ? `${idPart}-${slug}` : idPart;
    const dir = folders ? `entries/${folders.join('/')}` : 'entries';
    let name = `${dir}/${base}.md`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${dir}/${base}~${n}.md`;
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
            const folders = takeGroup(frontMatter);
            const file = entryFileName(key, entry, used, folders);
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
        const group = groupOfFile(name);
        if (group !== null) putGroup(entry, group, name);
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
