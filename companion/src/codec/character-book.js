/**
 * Embedded character book (data.character_book, V2 card spec) <-> entry files. See docs/workspace-format.md §3.
 *
 *   character_book/[<group>/]NNNN-<comment>.md   one entry: YAML front matter (all fields except content) + content
 *
 * The number decides the order; subfolders under character_book/ map to extensions.cellar.group (same rule as
 * lorebooks/entries/). Other book fields (name, scan_depth, extensions, ...) stay in card.json.
 * A book whose entries are not all objects with string content stays verbatim in card.json.
 */
import { deepClone, getPath, isPlainObject, setPath } from './object-path.js';
import { needsRaw, normalizeText, safeSegment } from './text.js';
import { parseEntry, serializeEntry } from './front-matter.js';
import { groupOfFile, putGroup, takeGroup } from './lorebook.js';

export const BOOK_PATH = 'data.character_book';
const ENTRIES_PATH = `${BOOK_PATH}.entries`;
const ENTRY_RE = /^character_book\/(?:[^/]+\/)*(\d+)-[^/]*\.md$/;

export function ownsBookFile(rel) {
    return ENTRY_RE.test(rel);
}

/** Moves the embedded book's entries into files; records `meta.characterBook` when it did. */
export function splitBook(rest, files, meta) {
    const book = getPath(rest, BOOK_PATH);
    if (!isPlainObject(book) || !Array.isArray(book.entries)) return;
    if (!book.entries.every(e => isPlainObject(e) && typeof e.content === 'string')) return;
    const width = Math.max(4, String(book.entries.length).length);
    book.entries.forEach((entry, i) => {
        const frontMatter = deepClone(entry);
        const content = frontMatter.content;
        delete frontMatter.content;
        const folders = takeGroup(frontMatter);
        const dir = folders ? `character_book/${folders.join('/')}` : 'character_book';
        const label = [entry.comment, entry.name, Array.isArray(entry.keys) ? entry.keys[0] : ''].find(x => typeof x === 'string' && x.trim()) ?? '';
        const name = `${dir}/${String(i + 1).padStart(width, '0')}${label ? `-${safeSegment(label.replace(/\s+/g, ' '), 40)}` : '-'}.md`;
        files[name] = serializeEntry(frontMatter, content);
        if (needsRaw(content)) meta.raw.push(`${ENTRIES_PATH}.${i}.content`);
    });
    delete book.entries;
    meta.characterBook = true;
}

/** Inverse of splitBook. Deleting every entry file leaves an empty entries list. */
export function joinBook(card, files, meta) {
    if (!meta.characterBook) return;
    const raw = new Set(meta.raw ?? []);
    const entries = Object.keys(files)
        .map(name => ({ name, match: ENTRY_RE.exec(name) }))
        .filter(x => x.match)
        .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || a.name.localeCompare(b.name))
        .map(({ name }, i) => {
            const { frontMatter, body } = parseEntry(files[name], name);
            const entry = { ...frontMatter, content: normalizeText(body, raw.has(`${ENTRIES_PATH}.${i}.content`)) };
            const group = groupOfFile(name);
            if (group !== null) putGroup(entry, group, name);
            return entry;
        });
    const book = getPath(card, BOOK_PATH);
    setPath(card, BOOK_PATH, { ...(isPlainObject(book) ? book : {}), entries });
}
