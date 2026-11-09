/**
 * Workspace version history (phase 2, docs/versioning.md). The workspace is a git repository driven through
 * isomorphic-git; the model follows JJ:
 *
 *   - The draft `@` is the branch tip marked by refs/cellar/draft. Snapshots amend it (same parent, new tree), so
 *     saving often does not litter the history. Only a commit that is both the draft ref and the branch tip is ever
 *     replaced; anything else (the user's own commits) is left alone and a new draft starts on top.
 *   - "Record a version" (commit) or tagging the draft = end it; the next change starts a new draft. Everything else
 *     (edits, checkouts, pulls and merges from a tavern, restores) only goes into the draft.
 *   - Deployed pointers refs/cellar/deployed/<target>/<item key> name the version an item was last synced
 *     to a tavern. They are history information only; sync decisions use .cellar/state.json and .cellar/base.
 *   - Origin pointers refs/cellar/origin/<item key> name the draft snapshot taken right after an item
 *     entered the workspace (取出 / 新建): 撤销当前的修改 goes back there while that draft is still open.
 *
 * All operations are serialized: the file watcher, Studio and sync may snapshot at the same time.
 *
 * Every snapshot amends the draft, so the replaced draft states (and files only they used) stay behind as unused
 * objects; compact() deletes them and packs the rest into one file (压缩历史, docs/versioning.md §7).
 */
import fs from 'node:fs';
import { readdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import git from 'isomorphic-git';
import ignore from 'ignore';

export const DRAFT_REF = 'refs/cellar/draft';
const DEPLOYED_PREFIX = 'refs/cellar/deployed';
const ORIGIN_PREFIX = 'refs/cellar/origin';
/** Tags belong to one item: refs/cellar/tags/<item key>/<name>. */
const TAGS_PREFIX = 'refs/cellar/tags';
/** Descriptions changed after recording live here (git notes), so a version keeps its id. */
const NOTES_REF = 'refs/notes/cellar';
/** Shown for drafts and versions nobody described (git requires a message). */
export const UNDESCRIBED = '(未写说明)';
const AUTHOR = { name: 'TavernCellar', email: 'cellar@localhost' };
/** A cached file hash is trusted only if computed this long after the file's mtime (racy-git guard). */
const RACY_MS = 2000;
/** 压缩历史 leaves unused objects younger than this (a git command or a write may still be about to use them). */
export const COMPACT_GRACE_MS = 10 * 60 * 1000;
/** Dotfiles at the workspace root that belong to the history (other dotfiles follow the workspace ignore rule). */
const ROOT_DOTFILES = new Set(['.gitignore', '.gitattributes']);
const decoder = new TextDecoder();

/**
 * Item path -> ref-name segment: the first 20 hex digits of its SHA-1. Fixed length, so a long CJK name cannot make
 * the ref file path too long for git on Windows (percent-encoded names, used before, could pass 260 characters).
 */
export const itemKey = itemPath => createHash('sha1').update(itemPath, 'utf8').digest('hex').slice(0, 20);
const ITEM_KEY_RE = /^[0-9a-f]{20}$/;
/** Entries of #entries / #changedItems that are items (`<folder>/<name>`); root files are workspace settings. */
export const isItemEntry = entryPath => entryPath.includes('/');

export const deployedRef = (targetId, itemPath) => `${DEPLOYED_PREFIX}/${targetId}/${itemKey(itemPath)}`;
const originRef = itemPath => `${ORIGIN_PREFIX}/${itemKey(itemPath)}`;
const tagRef = (itemPath, name) => `${TAGS_PREFIX}/${itemKey(itemPath)}/${name}`;

export class Vcs {
    /**
     * @param {string} root workspace root; `ignore(name)` skips files and folders (temp files, editor backups);
     * `itemPaths()` lists the workspace's current item paths (a moved item's pointers are keyed by its current path)
     */
    constructor(root, { ignore = () => false, warn = () => {}, itemPaths = () => [] } = {}) {
        this.dir = root;
        this.ignore = ignore;
        this.warn = warn;
        this.itemPaths = itemPaths;
        this.queue = Promise.resolve();
        /** rel path -> {mtimeMs, size, oid, at}: content hashes of workspace files (see #blob) */
        this.hashes = new Map();
        /** isomorphic-git's pack cache: without it every read from a pack reloads the pack file (reset by compact) */
        this.cache = {};
    }

    /** init() once; every user of the history awaits this first. */
    ready() {
        this.readyPromise ??= this.init().then(created => { this.created = created; }, error => { this.readyPromise = null; throw error; });
        return this.readyPromise;
    }

    /** True exactly once after ready() created the first version (for one-time setup such as deployed pointers). */
    takeCreated() {
        const created = Boolean(this.created);
        this.created = false;
        return created;
    }

    /** Runs fn after every earlier operation (never concurrently). */
    serial(fn) {
        const run = this.queue.then(fn);
        this.queue = run.then(() => {}, () => {});
        return run;
    }

    #opts(extra = {}) { return { fs, dir: this.dir, cache: this.cache, ...extra }; }

    /**
     * Makes the workspace a repository (keeps an existing one and its branch). A workspace without commits gets an
     * initial version of its current files. Returns true when that initial version was created.
     */
    init() {
        return this.serial(async () => {
            const attributes = join(this.dir, '.gitattributes');
            try { await readFile(attributes, 'utf8'); } catch { await writeFile(attributes, '* -text\n', 'utf8'); }
            if (!fs.existsSync(join(this.dir, '.git'))) await git.init(this.#opts({ defaultBranch: 'main' }));
            await this.#renameLongRefs();
            if (await this.#head()) {
                await this.#migrateGitTags();
                return false;
            }
            const oid = await this.#snapshotLocked('开始版本记录');
            if (oid) await git.deleteRef(this.#opts({ ref: DRAFT_REF })).catch(() => {});
            return Boolean(oid);
        });
    }

    /** Pointers named the old way (percent-encoded item path) move to the short item key. */
    async #renameLongRefs() {
        for (const prefix of [DEPLOYED_PREFIX, ORIGIN_PREFIX]) {
            for (const name of await git.listRefs(this.#opts({ filepath: prefix })).catch(() => [])) {
                const parts = name.split('/');
                const last = parts.pop();
                if (ITEM_KEY_RE.test(last)) continue;
                const ref = `${prefix}/${name}`;
                const oid = await this.#ref(ref);
                let itemPath;
                try { itemPath = decodeURIComponent(last); } catch { itemPath = null; }
                if (oid && itemPath) await git.writeRef(this.#opts({ ref: [prefix, ...parts, itemKey(itemPath)].join('/'), value: oid, force: true }));
                await git.deleteRef(this.#opts({ ref })).catch(() => {});
            }
        }
    }

    /**
     * Workspace-wide git tags (refs/tags/*, the model before tags belonged to items) become tags of the items their
     * version recorded (none recorded: every item in it), then the git tag goes. Runs on every start, so a tag made
     * with git later is taken over the same way.
     */
    async #migrateGitTags() {
        for (const name of await git.listTags(this.#opts()).catch(() => [])) {
            const oid = await this.#peel(await this.#ref(`refs/tags/${name}`));
            if (!oid) continue;
            let commit;
            try { ({ commit } = await git.readCommit(this.#opts({ oid }))); } catch { continue; }
            let items = (await this.#changedItems(commit.parent[0] ?? null, oid)).filter(isItemEntry);
            if (!items.length) items = [...(await this.#entries(oid)).keys()].filter(isItemEntry);
            for (const path of items) {
                if (!(await this.#ref(tagRef(path, name)))) await git.writeRef(this.#opts({ ref: tagRef(path, name), value: oid }));
            }
            await git.deleteRef(this.#opts({ ref: `refs/tags/${name}` })).catch(() => {});
        }
    }

    /** Annotated tags point to tag objects: the commit they name. */
    async #peel(oid) {
        if (!oid) return null;
        try { return (await git.readTag(this.#opts({ oid }))).tag.object; } catch { return oid; }
    }

    async #head() {
        try { return await git.resolveRef(this.#opts({ ref: 'HEAD' })); } catch { return null; }
    }

    async #ref(ref) {
        try { return await git.resolveRef(this.#opts({ ref })); } catch { return null; }
    }

    async #treeOf(oid) {
        return oid ? (await git.readCommit(this.#opts({ oid }))).commit.tree : null;
    }

    /**
     * Writes the files on disk (respecting .gitignore) as a tree and returns its oid. Change detection does not use
     * the git index: isomorphic-git compares mtimes in whole seconds, so a same-size edit within a second would be
     * missed. A file's cached hash is reused only when it was computed well after the file's last write. The index
     * is still updated for changed files, so `git status` agrees with the recorded versions.
     */
    async #buildTree() {
        const seen = new Set();
        const changed = [];
        // First build since start: the files of the last snapshot are what the index already holds.
        const known = this.hashes.size ? null : await this.#filesOf(await this.#head());
        const isIgnored = await this.#gitIgnore();
        const writeDir = async (abs, rel) => {
            const entries = [];
            for (const d of await readdir(abs, { withFileTypes: true })) {
                const r = rel ? `${rel}/${d.name}` : d.name;
                if (!rel && d.name === '.git') continue;
                if (this.ignore(d.name) && !(!rel && ROOT_DOTFILES.has(d.name))) continue;
                if (await isIgnored(r)) continue;
                if (d.isDirectory()) {
                    const oid = await writeDir(join(abs, d.name), r);
                    if (oid) entries.push({ mode: '040000', path: d.name, oid, type: 'tree' });
                } else if (d.isFile()) {
                    const oid = await this.#blob(join(abs, d.name), r, changed, known);
                    if (!oid) continue; // removed while scanning
                    seen.add(r);
                    entries.push({ mode: '100644', path: d.name, oid, type: 'blob' });
                }
            }
            return entries.length || !rel ? this.#tree(entries) : null;
        };
        const tree = await writeDir(this.dir, '');
        // One index write per batch: git.add per file rewrites the whole index each time (minutes on a first
        // snapshot of a large workspace). Ignore rules were applied above, hence force.
        for (let i = 0; i < changed.length; i += 200) {
            await git.add(this.#opts({ filepath: changed.slice(i, i + 200), force: true })).catch(() => {});
        }
        for (const filepath of [...this.hashes.keys()].filter(p => !seen.has(p))) {
            this.hashes.delete(filepath);
            await git.remove(this.#opts({ filepath })).catch(() => {});
        }
        return tree;
    }

    /**
     * The same rules as isomorphic-git's isIgnored (.git/info/exclude, then every .gitignore from the root down; a
     * file under an ignored folder stays ignored), but each .gitignore is read once per tree build instead of once
     * per file and folder: git.isIgnored re-reads them on every call, which made a snapshot of a few thousand files
     * take most of a second.
     * @returns {Promise<(filepath: string) => Promise<boolean>>}
     */
    async #gitIgnore() {
        const excludes = await readFile(join(this.dir, '.git', 'info', 'exclude'), 'utf8').catch(() => '');
        const rules = new Map();
        const rulesIn = folder => {
            if (!rules.has(folder)) {
                rules.set(folder, readFile(join(this.dir, ...folder.split('/').filter(Boolean), '.gitignore'), 'utf8').catch(() => '').then(text => {
                    const ign = ignore();
                    if (!folder) ign.add(excludes);
                    return ign.add(text);
                }));
            }
            return rules.get(folder);
        };
        return async filepath => {
            const pieces = filepath.split('/');
            if (pieces[pieces.length - 1] === '.git') return true;
            let ignored = false;
            for (let i = 0; i < pieces.length; i++) {
                const ign = await rulesIn(pieces.slice(0, i).join('/'));
                const parent = pieces.slice(i, -1).join('/');
                if (parent && ign.ignores(parent)) return true;
                const file = pieces.slice(i).join('/');
                ignored = ignored ? !ign.test(file).unignored : ign.test(file).ignored;
            }
            return ignored;
        };
    }

    async #blob(abs, rel, changed, known) {
        let s, content;
        try {
            s = await stat(abs);
            const cached = this.hashes.get(rel);
            if (cached && cached.mtimeMs === s.mtimeMs && cached.size === s.size && cached.at - s.mtimeMs > RACY_MS) return cached.oid;
            content = await readFile(abs);
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
        // Hash first and write only new content: after 压缩历史 most files are in the pack, and writing them again
        // as loose objects (what writeBlob does) would undo it on every restart.
        const { oid } = await git.hashBlob({ object: content });
        if (!(await this.#hasObject(oid))) await git.writeBlob(this.#opts({ blob: content }));
        if ((this.hashes.get(rel)?.oid ?? known?.get(rel)) !== oid) changed.push(rel);
        this.hashes.set(rel, { mtimeMs: s.mtimeMs, size: s.size, oid, at: Date.now() });
        return oid;
    }

    /** rel path -> blob oid of every file in a commit (empty map for none). */
    async #filesOf(commit) {
        const files = new Map();
        if (!commit) return files;
        const walk = async (oid, prefix) => {
            for (const e of (await git.readTree(this.#opts({ oid }))).tree) {
                const rel = prefix ? `${prefix}/${e.path}` : e.path;
                if (e.type === 'tree') await walk(e.oid, rel);
                else if (e.type === 'blob') files.set(rel, e.oid);
            }
        };
        await walk(await this.#treeOf(commit), '');
        return files;
    }

    /**
     * git.writeTree, but an existing tree is not written again: writeTree only looks for loose objects, so after
     * 压缩历史 every folder would come back as a loose duplicate. The id is git's (entries in byte order, folders
     * compared with a trailing "/"), the same serialization isomorphic-git writes.
     */
    async #tree(entries) {
        const key = e => Buffer.from(e.type === 'tree' ? `${e.path}/` : e.path, 'utf8');
        const body = Buffer.concat([...entries].sort((a, b) => Buffer.compare(key(a), key(b))).map(e => Buffer.concat([
            Buffer.from(`${e.mode.replace(/^0/, '')} ${e.path}\0`, 'utf8'), Buffer.from(e.oid, 'hex'),
        ])));
        const oid = createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
        return (await this.#hasObject(oid)) ? oid : git.writeTree(this.#opts({ tree: entries }));
    }

    async #hasObject(oid) {
        try {
            await stat(join(this.dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)));
            return true;
        } catch {
            return git.readObject(this.#opts({ oid, format: 'content' })).then(() => true, () => false);
        }
    }

    /** The draft commit if it is still the branch tip, else null. */
    async #draft() {
        const head = await this.#head();
        const draft = await this.#ref(DRAFT_REF);
        return head && draft === head ? head : null;
    }

    /**
     * Records the current files in the draft. `message` replaces the draft's message (default: keep it).
     * Returns the draft commit, or null when the files equal the last recorded version (no draft).
     */
    snapshot(message) {
        return this.serial(() => this.#snapshotLocked(message));
    }

    async #snapshotLocked(message) {
        const branch = await git.currentBranch(this.#opts({ fullname: true }));
        if (!branch) { this.warn('version history: HEAD is detached, snapshot skipped'); return null; }
        const head = await this.#head();
        const draft = await this.#draft();
        const parent = draft ? (await git.readCommit(this.#opts({ oid: draft }))).commit.parent[0] ?? null : head;
        const tree = await this.#buildTree();
        const draftMessage = draft ? (await git.readCommit(this.#opts({ oid: draft }))).commit.message.replace(/\n$/, '') : UNDESCRIBED;
        const nextMessage = message ?? draftMessage;
        if (draft && tree === (await this.#treeOf(draft)) && nextMessage === draftMessage) return draft;
        if (parent && tree === (await this.#treeOf(parent))) {
            // Nothing left in the draft: drop it, the branch goes back to the last version.
            if (draft) {
                await git.writeRef(this.#opts({ ref: branch, value: parent, force: true }));
                await git.deleteRef(this.#opts({ ref: DRAFT_REF })).catch(() => {});
            }
            return null;
        }
        const oid = await git.commit(this.#opts({ message: nextMessage, author: AUTHOR, tree, parent: parent ? [parent] : [], noUpdateBranch: true }));
        await git.writeRef(this.#opts({ ref: branch, value: oid, force: true }));
        await git.writeRef(this.#opts({ ref: DRAFT_REF, value: oid, force: true }));
        return oid;
    }

    /** Sets the draft's message (snapshotting first). Returns the draft commit or null when nothing changed. */
    describe(message) {
        return this.serial(async () => {
            if (!(await this.#snapshotLocked())) return null;
            return this.#snapshotLocked(message?.trim() || UNDESCRIBED);
        });
    }

    /** "Record a version" (存档) of the items in `paths` (default: every item in the draft). Returns the new
     * version, or null when nothing changed. See #commitLocked. */
    commit(message, paths) {
        return this.serial(() => this.#commitLocked(message, paths));
    }

    /**
     * The new version is the last one plus the chosen items and the workspace settings files (root files) as they
     * are now; the other items' changes become a new draft on top of it, and their origin pointers move along so
     * 撤销当前的修改 still finds them. Without a message the draft's description is used.
     */
    async #commitLocked(message, paths) {
        const draft = await this.#snapshotLocked();
        if (!draft) return null;
        const { commit } = await git.readCommit(this.#opts({ oid: draft }));
        const parent = commit.parent[0] ?? null;
        const draftMessage = commit.message.replace(/\n$/, '');
        const text = message?.trim() || draftMessage;
        const changed = await this.#changedItems(parent, draft);
        if (paths?.length && !changed.some(p => paths.includes(p))) throw new Error('所选的项没有未存档的修改');
        const defer = paths?.length ? changed.filter(p => isItemEntry(p) && !paths.includes(p)) : [];
        if (!defer.length) {
            const oid = await this.#snapshotLocked(text);
            await git.deleteRef(this.#opts({ ref: DRAFT_REF })).catch(() => {});
            return oid;
        }
        const branch = await git.currentBranch(this.#opts({ fullname: true }));
        const tree = await this.#withEntries(commit.tree, await this.#treeOf(parent), defer);
        const oid = await git.commit(this.#opts({ message: text, author: AUTHOR, tree, parent: parent ? [parent] : [], noUpdateBranch: true }));
        for (const path of defer) {
            const origin = await this.#ref(originRef(path));
            if (!origin) continue;
            const o = (await git.readCommit(this.#opts({ oid: origin }))).commit;
            if ((o.parent[0] ?? null) !== parent) continue;
            // Every deferred entry as it was there: the item may have been elsewhere then (moved since).
            const moved = await git.commit(this.#opts({
                message: o.message, author: AUTHOR, tree: await this.#withEntries(tree, o.tree, defer), parent: [oid], noUpdateBranch: true,
            }));
            await git.writeRef(this.#opts({ ref: originRef(path), value: moved, force: true }));
        }
        const rest = await git.commit(this.#opts({
            message: message?.trim() ? draftMessage : UNDESCRIBED, author: AUTHOR, tree: commit.tree, parent: [oid], noUpdateBranch: true,
        }));
        await git.writeRef(this.#opts({ ref: branch, value: rest, force: true }));
        await git.writeRef(this.#opts({ ref: DRAFT_REF, value: rest, force: true }));
        return oid;
    }

    /**
     * `base` with each entry path (`name` or `folder/name`) taken from `source` (removed where `source` lacks it).
     */
    async #withEntries(base, source, entryPaths) {
        const read = async oid => (oid ? [...(await git.readTree(this.#opts({ oid }))).tree] : []);
        const root = await read(base);
        const sourceRoot = await read(source);
        const put = (entries, name, entry) => {
            const i = entries.findIndex(e => e.path === name);
            if (i !== -1) entries.splice(i, 1);
            if (entry) entries.push({ mode: entry.mode, path: name, oid: entry.oid, type: entry.type });
        };
        for (const entryPath of entryPaths) {
            const [top, name] = entryPath.split('/');
            const sourceTop = sourceRoot.find(e => e.path === top);
            if (!name) { put(root, top, sourceTop); continue; }
            const baseTop = root.find(e => e.path === top);
            const sub = baseTop?.type === 'tree' ? await read(baseTop.oid) : [];
            const sourceSub = sourceTop?.type === 'tree' ? await read(sourceTop.oid) : [];
            put(sub, name, sourceSub.find(e => e.path === name));
            put(root, top, sub.length ? { mode: '040000', oid: await this.#tree(sub), type: 'tree' } : null);
        }
        return this.#tree(root);
    }

    /**
     * Tags one item at a version (default: the last recorded version). `itemPaths`: the item's paths, current first
     * (the tag is keyed by that one; a version from before a move has the item at a former path). Tagging the draft
     * records that item first (with `message`), so the tag names the version it became.
     */
    tag(name, itemPaths, rev, message) {
        const itemPath = itemPaths[0];
        return this.serial(async () => {
            const draft = await this.#draft();
            let oid = rev ? await this.#resolveLocked(rev) : null;
            if (oid && oid === draft) {
                const { commit } = await git.readCommit(this.#opts({ oid: draft }));
                const inDraft = (await this.#changedItems(commit.parent[0] ?? null, draft)).some(p => itemPaths.includes(p));
                oid = inDraft ? await this.#commitLocked(message, itemPaths) : commit.parent[0] ?? null;
            } else if (!oid) {
                oid = draft ? (await git.readCommit(this.#opts({ oid: draft }))).commit.parent[0] ?? null : await this.#head();
            }
            const entries = oid ? await this.#entries(oid) : new Map();
            if (!itemPaths.some(p => entries.has(p))) throw new Error(`这个版本里没有 ${itemPath}`);
            if (await this.#ref(tagRef(itemPath, name))) throw Object.assign(new Error(`${itemPath} 已有标签 ${name}`), { code: 'AlreadyExistsError' });
            await git.writeRef(this.#opts({ ref: tagRef(itemPath, name), value: oid }));
            return oid;
        });
    }

    /** Removes one item's tag; false when it did not exist. */
    untag(name, itemPath) {
        return this.serial(async () => {
            if (!(await this.#ref(tagRef(itemPath, name)))) return false;
            await git.deleteRef(this.#opts({ ref: tagRef(itemPath, name) }));
            return true;
        });
    }

    /** Every item tag: {key, name, oid}. */
    async #tagList() {
        const out = [];
        for (const ref of await git.listRefs(this.#opts({ filepath: TAGS_PREFIX })).catch(() => [])) {
            const slash = ref.indexOf('/');
            if (slash === -1) continue;
            const oid = await this.#ref(`${TAGS_PREFIX}/${ref}`);
            if (oid) out.push({ key: ref.slice(0, slash), name: ref.slice(slash + 1), oid });
        }
        return out;
    }

    /**
     * Tags on a version as {path, name}: the item is found among the version's entries by its key, else among the
     * workspace's current items (a tag moved along with its item names it by the current path).
     */
    async #tagsOn(oid, list) {
        const here = list.filter(t => t.oid === oid);
        if (!here.length) return [];
        const paths = [...this.itemPaths(), ...[...(await this.#entries(oid)).keys()].filter(isItemEntry)];
        const byKey = new Map(paths.map(p => [itemKey(p), p]));
        return here.filter(t => byKey.has(t.key)).map(t => ({ path: byKey.get(t.key), name: t.name }))
            .sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
    }

    /** Item tags on a version: [{path, name}]. */
    tagsAt(oid) {
        return this.serial(async () => this.#tagsOn(oid, await this.#tagList()));
    }

    /** Descriptions written after recording (git notes): version id -> text. */
    async #notes() {
        const out = new Map();
        for (const { target, note } of await git.listNotes(this.#opts({ ref: NOTES_REF })).catch(() => [])) {
            out.set(target, decoder.decode((await git.readBlob(this.#opts({ oid: note }))).blob).replace(/\n$/, ''));
        }
        return out;
    }

    /**
     * Changes the description of a version: the draft's own message, or a note on a recorded version (its id, and
     * every pointer to it, stay). Returns the version id.
     */
    describeVersion(rev, message) {
        const text = message?.trim() || UNDESCRIBED;
        return this.serial(async () => {
            const oid = await this.#resolveLocked(rev);
            if (oid === await this.#draft()) return this.#snapshotLocked(text);
            await git.addNote(this.#opts({ ref: NOTES_REF, oid, note: text, force: true, author: AUTHOR, committer: AUTHOR }));
            return oid;
        });
    }

    /** Commit id for a full / abbreviated oid, `HEAD` / a ref name, `<item path>:<tag>` or a tag only one item has. */
    resolve(rev) { return this.serial(() => this.#resolveLocked(rev)); }

    async #resolveLocked(rev) {
        if (!rev) return null;
        const colon = rev.lastIndexOf(':');
        if (colon > 0) {
            const oid = await this.#ref(tagRef(rev.slice(0, colon), rev.slice(colon + 1)));
            if (oid) return oid;
        }
        const direct = await this.#ref(rev);
        if (direct) return this.#peel(direct);
        const tagged = (await this.#tagList()).filter(t => t.name === rev);
        if (new Set(tagged.map(t => t.oid)).size === 1) return tagged[0].oid;
        if (tagged.length) throw new Error(`有多个项都有标签 ${rev}，请写成 <项路径>:${rev}`);
        if (/^[0-9a-f]{4,40}$/i.test(rev)) {
            try { return await git.expandOid(this.#opts({ oid: rev.toLowerCase() })); } catch { /* not an object */ }
        }
        throw new Error(`找不到版本 ${rev}`);
    }

    setDeployed(targetId, itemPath, oid) {
        return this.serial(async () => {
            if (oid) await git.writeRef(this.#opts({ ref: deployedRef(targetId, itemPath), value: oid, force: true }));
        });
    }

    getDeployed(targetId, itemPath) {
        return this.serial(() => this.#ref(deployedRef(targetId, itemPath)));
    }

    dropDeployed(targetId, itemPath) {
        return this.serial(() => git.deleteRef(this.#opts({ ref: deployedRef(targetId, itemPath) })).catch(() => {}));
    }

    /** Marks the snapshot taken right after an item entered the workspace. */
    setOrigin(itemPath, oid) {
        return this.serial(async () => {
            if (oid) await git.writeRef(this.#opts({ ref: originRef(itemPath), value: oid, force: true }));
        });
    }

    /**
     * Where 撤销当前的修改 goes for an item (`itemPaths`: current first, then former paths): its origin snapshot when
     * that was taken in the current draft (the item entered the workspace after the last recorded version), else
     * the last recorded version. Null: neither has it.
     */
    revertPoint(itemPaths) {
        return this.serial(async () => {
            const draft = await this.#draft();
            const last = draft ? (await git.readCommit(this.#opts({ oid: draft }))).commit.parent[0] ?? null : await this.#head();
            const origin = await this.#ref(originRef(itemPaths[0]));
            if (origin) {
                const parent = await git.readCommit(this.#opts({ oid: origin })).then(c => c.commit.parent[0] ?? null, () => undefined);
                if (parent !== undefined && parent === last && origin !== last) return { oid: origin, origin: true };
            }
            if (!last) return null;
            const entries = await this.#entries(last);
            return itemPaths.some(p => entries.has(p)) ? { oid: last, origin: false } : null;
        });
    }

    dropOrigin(itemPath) {
        return this.serial(() => git.deleteRef(this.#opts({ ref: originRef(itemPath) })).catch(() => {}));
    }

    /**
     * An item moved (SyncEngine.moveItem): its deployed and origin pointers and its tags follow it to the new key.
     * All or nothing: the new refs are written first and the old ones deleted after; a failure undoes what was done,
     * so the caller can refuse the move with nothing changed.
     */
    renameItem(fromPath, toPath) {
        return this.serial(async () => {
            const from = itemKey(fromPath);
            const to = itemKey(toPath);
            const moves = [];
            for (const name of await git.listRefs(this.#opts({ filepath: DEPLOYED_PREFIX })).catch(() => [])) {
                const [target, key] = name.split('/');
                if (key === from) moves.push([`${DEPLOYED_PREFIX}/${name}`, `${DEPLOYED_PREFIX}/${target}/${to}`]);
            }
            moves.push([`${ORIGIN_PREFIX}/${from}`, `${ORIGIN_PREFIX}/${to}`]);
            for (const t of await this.#tagList()) if (t.key === from) moves.push([`${TAGS_PREFIX}/${from}/${t.name}`, `${TAGS_PREFIX}/${to}/${t.name}`]);
            const found = [];
            for (const [ref, next] of moves) {
                const oid = await this.#ref(ref);
                if (oid) found.push({ ref, next, oid });
            }
            const written = [];
            const deleted = [];
            try {
                for (const m of found) {
                    await git.writeRef(this.#opts({ ref: m.next, value: m.oid, force: true }));
                    written.push(m);
                }
                for (const m of found) {
                    await git.deleteRef(this.#opts({ ref: m.ref }));
                    deleted.push(m);
                }
            } catch (error) {
                for (const m of deleted) await git.writeRef(this.#opts({ ref: m.ref, value: m.oid, force: true })).catch(() => {});
                for (const m of written) await git.deleteRef(this.#opts({ ref: m.next })).catch(() => {});
                throw error;
            }
        });
    }

    // ---- storage: 压缩历史 -------------------------------------------------------------------------------

    /** Object files of the repository: loose objects (one file each) and pack files. */
    async #objectFiles() {
        const root = join(this.dir, '.git', 'objects');
        const loose = [];
        const packs = [];
        for (const d of await readdir(root).catch(() => [])) {
            if (/^[0-9a-f]{2}$/.test(d)) {
                for (const name of await readdir(join(root, d)).catch(() => [])) {
                    if (!/^[0-9a-f]{38}$/.test(name)) continue;
                    const path = join(root, d, name);
                    const s = await stat(path).catch(() => null);
                    if (s) loose.push({ oid: d + name, path, size: s.size, mtimeMs: s.mtimeMs });
                }
            } else if (d === 'pack') {
                for (const name of await readdir(join(root, d)).catch(() => [])) {
                    const s = await stat(join(root, d, name)).catch(() => null);
                    if (s) packs.push({ name, path: join(root, d, name), size: s.size });
                }
            }
        }
        return { loose, packs };
    }

    /**
     * Everything a ref still needs: every branch, tag, draft / deployed / origin pointer and HEAD, through commits,
     * trees and annotated tags. Blobs are taken from the trees without being read.
     */
    async #reachable() {
        const roots = [];
        const head = await this.#head();
        if (head) roots.push(head);
        for (const ref of await git.listRefs(this.#opts({ filepath: 'refs' }))) {
            const oid = await this.#ref(`refs/${ref}`);
            if (oid) roots.push(oid);
        }
        const seen = new Set();
        const stack = [...roots];
        while (stack.length) {
            const oid = stack.pop();
            if (seen.has(oid)) continue;
            seen.add(oid);
            const { type, object } = await git.readObject(this.#opts({ oid, format: 'parsed' }));
            if (type === 'commit') stack.push(object.tree, ...object.parent);
            else if (type === 'tag') stack.push(object.object);
            else if (type === 'tree') {
                for (const e of object) {
                    if (e.type === 'tree') stack.push(e.oid);
                    else if (e.type === 'blob') seen.add(e.oid);
                }
            }
        }
        return seen;
    }

    /** Bytes and files the history takes on disk; with `unused` (a walk) also what compact({keepMs}) would delete. */
    storage({ unused = false, keepMs = COMPACT_GRACE_MS } = {}) {
        return this.serial(async () => {
            const { loose, packs } = await this.#objectFiles();
            const sum = list => list.reduce((n, o) => n + o.size, 0);
            const out = { bytes: sum(loose) + sum(packs), files: loose.length + packs.length, loose: loose.length, packs: packs.filter(p => p.name.endsWith('.pack')).length };
            if (unused) {
                const keep = await this.#reachable();
                // the files on disk right now are in the latest snapshot; their cached hashes are kept anyway
                for (const { oid } of this.hashes.values()) keep.add(oid);
                const now = Date.now();
                const drop = loose.filter(o => !keep.has(o.oid) && now - o.mtimeMs >= keepMs);
                out.unusedBytes = sum(drop);
                out.unusedFiles = drop.length;
            }
            return out;
        });
    }

    /**
     * 压缩历史: deletes loose objects no ref needs any more (replaced draft states and files only they used) once
     * they are older than `keepMs`, and with `pack` writes everything still needed into one pack file and removes
     * the loose copies and older packs. Versions, tags, drafts and deployed / origin pointers are untouched.
     * The new pack is indexed before anything is deleted, so an interruption leaves at most duplicates.
     */
    compact({ keepMs = COMPACT_GRACE_MS, pack = true } = {}) {
        return this.serial(async () => {
            const before = await this.#objectFiles();
            const sum = list => list.reduce((n, o) => n + o.size, 0);
            const beforeBytes = sum(before.loose) + sum(before.packs);
            const reachable = await this.#reachable();
            const protect = new Set([...this.hashes.values()].map(h => h.oid));
            const now = Date.now();
            let removed = 0;
            const emptied = new Set();
            for (const o of before.loose) {
                if (reachable.has(o.oid) || protect.has(o.oid) || now - o.mtimeMs < keepMs) continue;
                await unlink(o.path).then(() => { removed++; emptied.add(join(o.path, '..')); }, () => {});
            }
            let packed = 0;
            if (pack && reachable.size) {
                const oids = [...reachable];
                const { filename } = await git.packObjects(this.#opts({ oids, write: true }));
                await git.indexPack(this.#opts({ filepath: join('.git', 'objects', 'pack', filename) }));
                this.cache = {};
                const keep = new Set([filename, filename.replace(/\.pack$/, '.idx')]);
                for (const p of before.packs) if (!keep.has(p.name)) await unlink(p.path).catch(() => {});
                for (const o of before.loose) {
                    if (!reachable.has(o.oid)) continue;
                    await unlink(o.path).then(() => emptied.add(join(o.path, '..')), () => {});
                }
                packed = oids.length;
            }
            for (const d of emptied) await rmdir(d).catch(() => {}); // only succeeds when empty
            const after = await this.#objectFiles();
            return { beforeBytes, afterBytes: sum(after.loose) + sum(after.packs), removed, packed, files: after.loose.length + after.packs.length };
        });
    }

    /** Entries of a commit: root files and `<folder>/<name>` second-level entries -> object id (empty for null). */
    async #entries(oid) {
        const out = new Map();
        if (!oid) return out;
        const root = await git.readTree(this.#opts({ oid }));
        for (const top of root.tree) {
            if (top.type !== 'tree') { out.set(top.path, top.oid); continue; }
            const sub = await git.readTree(this.#opts({ oid: top.oid }));
            for (const e of sub.tree) out.set(`${top.path}/${e.path}`, e.oid);
        }
        return out;
    }

    /** Item folders (`<folder>/<name>`) whose content differs between two commits (either may be null). */
    async #changedItems(fromOid, toOid) {
        const [a, b] = await Promise.all([this.#entries(fromOid), this.#entries(toOid)]);
        return [...new Set([...a.keys(), ...b.keys()])].filter(p => a.get(p) !== b.get(p)).sort();
    }

    /**
     * Version list, newest first: {id, parents, message, time, draft, items, tags}. `paths` (an item's current and
     * former paths) keeps versions that touch that item. `items` are top-level paths that changed against the first
     * parent; `tags` are [{path, name}]; `message` is the latest description (a note written later wins over the one
     * recorded).
     */
    log({ paths, limit = 100 } = {}) {
        return this.serial(async () => {
            const head = await this.#head();
            if (!head) return [];
            const draft = await this.#draft();
            const tags = await this.#tagList();
            const notes = await this.#notes();
            const commits = await git.log(this.#opts({ ref: 'HEAD', depth: paths ? Math.max(limit * 5, 200) : limit }));
            const out = [];
            for (const { oid, commit } of commits) {
                const items = await this.#changedItems(commit.parent[0] ?? null, oid);
                if (paths && !items.some(p => paths.includes(p))) continue;
                out.push({
                    id: oid, parents: commit.parent, message: notes.get(oid) ?? commit.message.replace(/\n$/, ''), time: commit.committer.timestamp * 1000,
                    draft: oid === draft, items, tags: await this.#tagsOn(oid, tags),
                });
                if (out.length >= limit) break;
            }
            return out;
        });
    }

    /** Files of one item folder in a version (item-relative "/" paths -> UTF-8 text), or null when absent there. */
    readItemAt(rev, itemPath) {
        return this.serial(async () => {
            const oid = await this.#resolveLocked(rev);
            let tree;
            try {
                tree = (await git.readTree(this.#opts({ oid, filepath: itemPath }))).tree;
            } catch {
                return null;
            }
            const files = {};
            const walk = async (entries, prefix) => {
                for (const e of entries) {
                    const rel = prefix ? `${prefix}/${e.path}` : e.path;
                    if (e.type === 'tree') await walk((await git.readTree(this.#opts({ oid: e.oid }))).tree, rel);
                    else if (e.type === 'blob') files[rel] = decoder.decode((await git.readBlob(this.#opts({ oid: e.oid }))).blob);
                }
            };
            await walk(tree, '');
            return files;
        });
    }

    /** Items that differ between two versions (`to` null = the files on disk are not considered; use HEAD). */
    changedItems(from, to) {
        return this.serial(async () => this.#changedItems(from ? await this.#resolveLocked(from) : null, await this.#resolveLocked(to)));
    }

    /** First parent of a version (null for the first version). */
    parentOf(rev) {
        return this.serial(async () => (await git.readCommit(this.#opts({ oid: await this.#resolveLocked(rev) }))).commit.parent[0] ?? null);
    }

    /** Whether two versions hold the same files (e.g. a draft before and after only its description changed). */
    sameContent(a, b) {
        return this.serial(async () => (await this.#treeOf(await this.#resolveLocked(a))) === (await this.#treeOf(await this.#resolveLocked(b))));
    }

    /** Draft commit id (or null) and the items it changes against the last version. */
    draftInfo() {
        return this.serial(async () => {
            const draft = await this.#draft();
            if (!draft) return { id: null, items: [], message: null };
            const { commit } = await git.readCommit(this.#opts({ oid: draft }));
            return { id: draft, items: await this.#changedItems(commit.parent[0] ?? null, draft), message: commit.message.replace(/\n$/, '') };
        });
    }
}
