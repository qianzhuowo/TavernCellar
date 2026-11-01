/**
 * Workspace version history (phase 2, docs/versioning.md). The workspace is a git repository driven through
 * isomorphic-git; the model follows JJ:
 *
 *   - The draft `@` is the branch tip marked by refs/cellar/draft. Snapshots amend it (same parent, new tree), so
 *     saving often does not litter the history. Only a commit that is both the draft ref and the branch tip is ever
 *     replaced; anything else (the user's own commits) is left alone and a new draft starts on top.
 *   - "Record a version" (commit) = describe the draft and end it; the next change starts a new draft.
 *   - Deployed pointers refs/cellar/deployed/<target>/<encoded item path> name the version an item was last synced
 *     to a tavern. They are history information only; sync decisions use .cellar/state.json and .cellar/base.
 *
 * All operations are serialized: the file watcher, Studio and sync may snapshot at the same time.
 */
import fs from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import git from 'isomorphic-git';

export const DRAFT_REF = 'refs/cellar/draft';
const DEPLOYED_PREFIX = 'refs/cellar/deployed';
/** Shown for drafts and versions nobody described (git requires a message). */
export const UNDESCRIBED = '(未写说明)';
const AUTHOR = { name: 'TavernCellar', email: 'cellar@localhost' };
/** A cached file hash is trusted only if computed this long after the file's mtime (racy-git guard). */
const RACY_MS = 2000;
/** Dotfiles at the workspace root that belong to the history (other dotfiles follow the workspace ignore rule). */
const ROOT_DOTFILES = new Set(['.gitignore', '.gitattributes']);
const decoder = new TextDecoder();

/** Item path -> a single ref-name segment: everything outside [A-Za-z0-9_-] percent-encoded (dots, spaces, CJK, "/"). */
export function encodeRefSegment(value) {
    return [...new TextEncoder().encode(value)]
        .map(b => (/[A-Za-z0-9_-]/.test(String.fromCharCode(b)) && b < 128 ? String.fromCharCode(b) : `%${b.toString(16).toUpperCase().padStart(2, '0')}`))
        .join('');
}

export const deployedRef = (targetId, itemPath) => `${DEPLOYED_PREFIX}/${encodeRefSegment(targetId)}/${encodeRefSegment(itemPath)}`;

export class Vcs {
    /** @param {string} root workspace root; `ignore(name)` skips files and folders (temp files, editor backups) */
    constructor(root, { ignore = () => false, warn = () => {} } = {}) {
        this.dir = root;
        this.ignore = ignore;
        this.warn = warn;
        this.queue = Promise.resolve();
        /** rel path -> {mtimeMs, size, oid, at}: content hashes of workspace files (see #blob) */
        this.hashes = new Map();
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

    #opts(extra = {}) { return { fs, dir: this.dir, ...extra }; }

    /**
     * Makes the workspace a repository (keeps an existing one and its branch). A workspace without commits gets an
     * initial version of its current files. Returns true when that initial version was created.
     */
    init() {
        return this.serial(async () => {
            const attributes = join(this.dir, '.gitattributes');
            try { await readFile(attributes, 'utf8'); } catch { await writeFile(attributes, '* -text\n', 'utf8'); }
            if (!fs.existsSync(join(this.dir, '.git'))) await git.init(this.#opts({ defaultBranch: 'main' }));
            if (await this.#head()) return false;
            const oid = await this.#snapshotLocked('开始版本记录');
            if (oid) await git.deleteRef(this.#opts({ ref: DRAFT_REF })).catch(() => {});
            return Boolean(oid);
        });
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
        const writeDir = async (abs, rel) => {
            const entries = [];
            for (const d of await readdir(abs, { withFileTypes: true })) {
                const r = rel ? `${rel}/${d.name}` : d.name;
                if (!rel && d.name === '.git') continue;
                if (this.ignore(d.name) && !(!rel && ROOT_DOTFILES.has(d.name))) continue;
                if (await git.isIgnored(this.#opts({ filepath: r }))) continue;
                if (d.isDirectory()) {
                    const oid = await writeDir(join(abs, d.name), r);
                    if (oid) entries.push({ mode: '040000', path: d.name, oid, type: 'tree' });
                } else if (d.isFile()) {
                    const oid = await this.#blob(join(abs, d.name), r, changed);
                    if (!oid) continue; // removed while scanning
                    seen.add(r);
                    entries.push({ mode: '100644', path: d.name, oid, type: 'blob' });
                }
            }
            return entries.length || !rel ? git.writeTree(this.#opts({ tree: entries })) : null;
        };
        const tree = await writeDir(this.dir, '');
        for (const filepath of changed) await git.add(this.#opts({ filepath })).catch(() => {});
        for (const filepath of [...this.hashes.keys()].filter(p => !seen.has(p))) {
            this.hashes.delete(filepath);
            await git.remove(this.#opts({ filepath })).catch(() => {});
        }
        return tree;
    }

    async #blob(abs, rel, changed) {
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
        const oid = await git.writeBlob(this.#opts({ blob: content }));
        if (this.hashes.get(rel)?.oid !== oid) changed.push(rel);
        this.hashes.set(rel, { mtimeMs: s.mtimeMs, size: s.size, oid, at: Date.now() });
        return oid;
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

    /** "Record a version": describe the draft and end it. Returns the recorded commit, or null when nothing changed. */
    commit(message) {
        return this.record(message?.trim() || UNDESCRIBED);
    }

    /** Ends the draft as it is (the next change starts a new one). Snapshots first so nothing on disk is lost. */
    endDraft() {
        return this.serial(async () => {
            const oid = await this.#snapshotLocked();
            await git.deleteRef(this.#opts({ ref: DRAFT_REF })).catch(() => {});
            return oid;
        });
    }

    /**
     * Records the current files as a finished version with `message` (also used for changes pulled from a tavern).
     * Returns the commit, or null when the files equal the last version.
     */
    record(message) {
        return this.serial(async () => {
            if (!(await this.#snapshotLocked())) return null;
            const oid = await this.#snapshotLocked(message);
            await git.deleteRef(this.#opts({ ref: DRAFT_REF })).catch(() => {});
            return oid;
        });
    }

    tag(name, rev) {
        return this.serial(async () => {
            const oid = rev ? await this.#resolveLocked(rev) : await this.#head();
            if (!oid) throw new Error('没有可以打标签的版本');
            await git.tag(this.#opts({ ref: name, object: oid }));
            return oid;
        });
    }

    /** Commit id for a full / abbreviated oid, a tag or a ref name. */
    resolve(rev) { return this.serial(() => this.#resolveLocked(rev)); }

    async #resolveLocked(rev) {
        if (!rev) return null;
        const direct = await this.#ref(rev) ?? await this.#ref(`refs/tags/${rev}`);
        if (direct) {
            // Annotated tags point to tag objects; peel to the commit.
            try { return (await git.readTag(this.#opts({ oid: direct }))).tag.object; } catch { return direct; }
        }
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

    /** Item folders (`<kind folder>/<name>`) whose content differs between two commits (either may be null). */
    async #changedItems(fromOid, toOid) {
        const listing = async oid => {
            const out = new Map();
            if (!oid) return out;
            const root = await git.readTree(this.#opts({ oid }));
            for (const top of root.tree) {
                if (top.type !== 'tree') { out.set(top.path, top.oid); continue; }
                const sub = await git.readTree(this.#opts({ oid: top.oid }));
                for (const e of sub.tree) out.set(`${top.path}/${e.path}`, e.oid);
            }
            return out;
        };
        const [a, b] = await Promise.all([listing(fromOid), listing(toOid)]);
        return [...new Set([...a.keys(), ...b.keys()])].filter(p => a.get(p) !== b.get(p)).sort();
    }

    /**
     * Version list, newest first: {id, parents, message, time, draft, items, tags}. `path` keeps versions that touch
     * that item. `items` are top-level paths that changed against the first parent.
     */
    log({ path, limit = 100 } = {}) {
        return this.serial(async () => {
            const head = await this.#head();
            if (!head) return [];
            const draft = await this.#draft();
            const tags = new Map();
            for (const name of await git.listTags(this.#opts())) {
                const oid = await this.#resolveLocked(name).catch(() => null);
                if (oid) tags.set(oid, [...(tags.get(oid) ?? []), name]);
            }
            const commits = await git.log(this.#opts({ ref: 'HEAD', depth: path ? Math.max(limit * 5, 200) : limit }));
            const out = [];
            for (const { oid, commit } of commits) {
                const items = await this.#changedItems(commit.parent[0] ?? null, oid);
                if (path && !items.includes(path)) continue;
                out.push({
                    id: oid, parents: commit.parent, message: commit.message.replace(/\n$/, ''), time: commit.committer.timestamp * 1000,
                    draft: oid === draft, items, tags: tags.get(oid) ?? [],
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
