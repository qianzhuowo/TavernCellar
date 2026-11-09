/**
 * Workspace on disk: cellar.json manifest, .cellar/ internal state, item folders.
 * See docs/workspace-format.md. All paths handled here stay inside the workspace root.
 */
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { ERR, HOST_CHARACTER_FIELDS, ProtocolError, withoutHostFields } from '../../../shared/protocol.js';
import { hashData } from '../../../shared/hash.js';
import { safeSegment } from '../codec/text.js';
import { CODECS, codecFor } from '../codec/index.js';
import { META_FILE as ITEM_META } from '../codec/character.js';
import { Vcs } from '../vcs/vcs.js';

export const MANIFEST_FILE = 'cellar.json';
const INTERNAL_DIR = '.cellar';
const MANIFEST_VERSION = 1;
/** How an item's kind is written after its name when it shares a project folder with a same-named item. */
export const KIND_LABEL = Object.freeze({ character: '角色卡', lorebook: '世界书', preset: '预设', regex: '正则' });
/** Workspace root folders that hold no items (预设工坊's workshop/prompts.json). */
const RESERVED_FOLDERS = new Set(['workshop']);
const KIND_FOLDERS = new Map(Object.entries(CODECS).map(([kind, codec]) => [codec.folder.toLowerCase(), kind]));

export class Workspace {
    /** @param {string} root absolute workspace directory */
    constructor(root) {
        this.root = resolve(root);
        this.manifest = { version: MANIFEST_VERSION, targets: {}, items: [] };
        this.state = { version: 2, items: {} };
    }

    /** Creates a workspace (idempotent) and returns it loaded. */
    static async init(root) {
        await mkdir(resolve(root), { recursive: true });
        // Expand 8.3 short names (e.g. C:\Users\USERNA~1): libuv's recursive watcher asserts on them.
        const ws = new Workspace(realpathSync.native(resolve(root)));
        await mkdir(join(ws.root, INTERNAL_DIR), { recursive: true });
        const gitignore = join(ws.root, '.gitignore');
        try { await readFile(gitignore, 'utf8'); } catch { await writeFile(gitignore, `${INTERNAL_DIR}/\n`, 'utf8'); }
        try {
            await readFile(join(ws.root, MANIFEST_FILE), 'utf8');
        } catch {
            await ws.saveManifest();
        }
        await ws.load();
        return ws;
    }

    async load() {
        try {
            this.manifest = JSON.parse(await readFile(join(this.root, MANIFEST_FILE), 'utf8'));
        } catch (error) {
            throw new Error(`Not a TavernCellar workspace (${join(this.root, MANIFEST_FILE)}): ${error.message}`);
        }
        if (this.manifest.version !== MANIFEST_VERSION) throw new Error(`Unsupported ${MANIFEST_FILE} version: ${this.manifest.version}`);
        this.manifest.targets ??= {};
        this.manifest.items ??= [];
        try {
            this.state = JSON.parse(await readFile(this.internal('state.json'), 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            this.state = { version: 1, items: {} };
        }
        this.state.items ??= {};
        if (this.state.version === 1) await this.#migrateHostFields();
    }

    /**
     * State version 1 -> 2: `chat` became host-owned (shared/protocol.js HOST_CHARACTER_FIELDS) and left the card.
     * Character base snapshots and card.json files lose it; every stored hash of the old base takes the new one, so
     * the items stay in sync instead of all showing tavern changes once.
     */
    async #migrateHostFields() {
        for (const item of this.manifest.items) {
            if (item.kind !== 'character') continue;
            const cardFile = this.resolveInside(`${item.path}/card.json`);
            const card = await readFile(cardFile, 'utf8').then(JSON.parse, () => null);
            if (card && typeof card === 'object' && HOST_CHARACTER_FIELDS.some(key => key in card)) {
                await atomicWrite(cardFile, JSON.stringify(withoutHostFields(card), null, 2) + '\n');
            }
            for (const [targetId, state] of Object.entries(this.state.items[item.path] ?? {})) {
                const base = await this.loadBase(item.path, targetId);
                if (!base || !HOST_CHARACTER_FIELDS.some(key => key in base)) continue;
                const [from, to] = [await hashData(base), await hashData(withoutHostFields(base))];
                await this.saveBase(item.path, targetId, withoutHostFields(base));
                for (const key of ['base', 'tavern', 'mergeBase', 'pinHash']) if (state[key] === from) state[key] = to;
            }
        }
        this.state.version = 2;
        await this.saveState();
    }

    internal(...parts) {
        return join(this.root, INTERNAL_DIR, ...parts);
    }

    /** Version history of this workspace (docs/versioning.md); call `await vcs.ready()` before use. */
    get vcs() {
        this._vcs ??= new Vcs(this.root, { ignore: isIgnoredName, itemPaths: () => this.manifest.items.map(item => item.path) });
        return this._vcs;
    }

    /** Resolves an item-relative "/" path inside the workspace; rejects escapes. */
    resolveInside(relPath) {
        const abs = resolve(this.root, ...relPath.split('/'));
        const rel = relative(this.root, abs);
        if (!rel || isAbsolute(rel) || rel.split(/[\\/]/)[0] === '..') {
            throw new Error(`Path escapes workspace: ${relPath}`);
        }
        return abs;
    }

    async saveManifest() {
        await atomicWrite(join(this.root, MANIFEST_FILE), JSON.stringify(this.manifest, null, 2) + '\n');
    }

    async saveState() {
        await mkdir(this.internal(), { recursive: true });
        await atomicWrite(this.internal('state.json'), JSON.stringify(this.state, null, 2) + '\n');
    }

    // ---- targets & items ------------------------------------------------

    rememberTarget(target) {
        const prev = this.manifest.targets[target.id];
        const next = { host: target.host, label: target.label };
        if (!prev || prev.host !== next.host || prev.label !== next.label) {
            this.manifest.targets[target.id] = next;
            return true;
        }
        return false;
    }

    getItem(path) {
        return this.manifest.items.find(item => item.path === path) ?? null;
    }

    /** Every path an item has had: the current one first, then where it was before moves (`formerPaths`, newest last). */
    itemPaths(item) {
        return [item.path, ...(item.formerPaths ?? [])];
    }

    /** The current path of the item that has or had `path` (history speaks current paths); `path` itself otherwise. */
    currentPath(path) {
        return this.manifest.items.find(item => item.path === path || item.formerPaths?.includes(path))?.path ?? path;
    }

    findBinding(targetId, kind, id) {
        for (const item of this.manifest.items) {
            const binding = item.bindings?.[targetId];
            if (item.kind === kind && binding?.id === id) return { item, binding };
        }
        return null;
    }

    /** Items bound to a target, as watch-list refs. */
    watchList(targetId) {
        return this.manifest.items
            .filter(item => item.bindings?.[targetId])
            .map(item => ({ kind: item.kind, id: item.bindings[targetId].id }));
    }

    /**
     * The top folder an item of `kind` goes into: its kind folder (characters, lorebooks, …) when `folder` is empty,
     * else the project folder `folder` (docs/workspace-format.md §5). Another kind's folder, `workshop` and names
     * that are not a plain folder name are refused; an existing project folder keeps its spelling (paths ignore case
     * on Windows).
     */
    itemFolder(kind, folder) {
        const own = codecFor(kind).folder;
        if (folder === undefined || folder === null || folder === '') return own;
        if (typeof folder !== 'string' || folder !== safeSegment(folder) || folder.startsWith('.') || RESERVED_FOLDERS.has(folder.toLowerCase())) {
            throw new ProtocolError(ERR.BAD_REQUEST, `项目文件夹名不能为空，不能以 . 开头，不能包含 \\ / : * ? " < > |，也不能是 workshop：${folder}`);
        }
        const kindOf = KIND_FOLDERS.get(folder.toLowerCase());
        if (kindOf && kindOf !== kind) throw new ProtocolError(ERR.BAD_REQUEST, `${folder} 是${KIND_LABEL[kindOf]}的默认文件夹`);
        if (kindOf) return own;
        return this.manifest.items.map(item => item.path.split('/')[0]).find(top => top.toLowerCase() === folder.toLowerCase()) ?? folder;
    }

    /** Picks a free folder for a new item: `<folder>/<name>` (folder: see itemFolder), see #allocate. */
    allocateItemPath(kind, id, folder) {
        return this.#allocate(kind, safeSegment(codecFor(kind).nameOf(id)), this.itemFolder(kind, folder));
    }

    /**
     * The one naming rule for item folders: `<folder>/<name>`; when that is taken, in a project folder
     * `<name>（<kind>）` (a card and its lorebook side by side), then `-2`, `-3`, …. A path any other item has or had
     * (`formerPaths`) is taken, so its history stays its own; `self`'s own paths are free (moving it back).
     */
    #allocate(kind, name, folder, self = null) {
        const taken = new Set(this.manifest.items.filter(item => item !== self).flatMap(item => this.itemPaths(item)).map(p => p.toLowerCase()));
        const base = `${folder}/${name}`;
        const label = isProjectFolder(folder) ? KIND_LABEL[kind] : null;
        for (let n = 1; ; n++) {
            const tries = n === 1 ? [base, ...(label ? [`${base}（${label}）`] : [])] : [`${base}-${n}`];
            const free = tries.find(path => !taken.has(path.toLowerCase()));
            if (free) return free;
        }
    }

    /** The name part of an item folder without the `（<kind>）` the naming rule may have added in a project folder. */
    #folderName(kind, path) {
        const [top, name] = path.split('/');
        const suffix = `（${KIND_LABEL[kind]}）`;
        return isProjectFolder(top) && name.endsWith(suffix) && name.length > suffix.length ? name.slice(0, -suffix.length) : name;
    }

    /** Where `item` goes when moved to `folder` (empty: its kind folder), by the same naming rule; its own path when it is there already. */
    movePath(item, folder) {
        const to = this.itemFolder(item.kind, folder);
        if (item.path.split('/')[0] === to) return item.path;
        const id = Object.values(item.bindings ?? {})[0]?.id;
        const name = typeof id === 'string' ? safeSegment(codecFor(item.kind).nameOf(id)) : this.#folderName(item.kind, item.path);
        return this.#allocate(item.kind, name, to, item);
    }

    /**
     * Where `item` goes after its name in the taverns changed from `oldName` (its bindings already carry the new id):
     * a folder named after the old name (the naming rule's `<name>` or `<name>（<kind>）`) gets the new name in the
     * same top folder; a folder the user named otherwise stays where it is.
     */
    renamedPath(item, oldName) {
        if (this.#folderName(item.kind, item.path) !== safeSegment(oldName)) return item.path;
        return this.#allocate(item.kind, safeSegment(this.itemName(item)), item.path.split('/')[0], item);
    }

    /** Path for an item folder imported from `sourceName` (a folder name outside the workspace) into `folder`. */
    importPath(kind, sourceName, folder) {
        const to = this.itemFolder(kind, folder);
        return this.#allocate(kind, this.#folderName(kind, `${to}/${safeSegment(sourceName)}`), to);
    }

    /**
     * The name an item has in the taverns: from its first binding, or for an unbound item the name its folder gives
     * (what publishing proposes and what a card's `extensions.world` is matched against).
     */
    itemName(item) {
        const id = Object.values(item.bindings ?? {})[0]?.id;
        if (typeof id === 'string') {
            if (item.kind === 'preset') return id.slice(id.indexOf('/') + 1);
            return codecFor(item.kind).nameOf(id);
        }
        return this.#folderName(item.kind, item.path);
    }

    /**
     * The workspace lorebook a card's `extensions.world` = `name` refers to for `targetId`: the one bound to that book
     * there, else an unbound one with that name (preferring the card's folder).
     */
    findWorld(name, targetId, near) {
        if (targetId) {
            const bound = this.findBinding(targetId, 'lorebook', name);
            if (bound) return bound.item;
        }
        const folder = near ? near.slice(0, near.lastIndexOf('/')) : null;
        const candidates = this.manifest.items.filter(item => item.kind === 'lorebook' && !Object.keys(item.bindings ?? {}).length && this.itemName(item) === name);
        return candidates.find(item => item.path.startsWith(`${folder}/`)) ?? candidates[0] ?? null;
    }

    // ---- per item/target sync state --------------------------------------

    getSyncState(path, targetId) {
        return this.state.items[path]?.[targetId] ?? null;
    }

    setSyncState(path, targetId, patch) {
        this.state.items[path] ??= {};
        const next = { ...(this.state.items[path][targetId] ?? {}), ...patch };
        for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
        this.state.items[path][targetId] = next;
    }

    // ---- item files ------------------------------------------------------

    /** Reads every file under an item folder as UTF-8, keyed by "/"-separated relative path. */
    async readItemFiles(path) {
        return readFolderFiles(this.resolveInside(path));
    }

    /**
     * Writes `files` into the item folder (changed files only, so editors don't see spurious modifications) and
     * deletes files that are no longer produced. Only files for which `owns(rel)` is true are deleted; everything
     * else in the folder (the user's notes, drafts, research) is left alone.
     */
    async writeItemFiles(path, files, owns) {
        if (typeof owns !== 'function') throw new Error('writeItemFiles needs the codec ownership test');
        const dir = this.resolveInside(path);
        const current = await this.readItemFiles(path);
        for (const [rel, content] of Object.entries(files)) {
            if (current[rel] === content) continue;
            const abs = this.resolveInside(`${path}/${rel}`);
            await mkdir(dirname(abs), { recursive: true });
            await atomicWrite(abs, content);
        }
        for (const rel of Object.keys(current)) {
            if (!Object.prototype.hasOwnProperty.call(files, rel) && owns(rel)) await rm(this.resolveInside(`${path}/${rel}`), { force: true });
        }
        await pruneEmptyDirs(dir);
    }

    /**
     * One file of an item folder ("/"-separated path relative to the item); null when it does not exist.
     * Ignored names (editor temp files, internal folders) are never read or written here.
     */
    async readItemFile(path, rel) {
        const abs = this.#itemFile(path, rel);
        try {
            return await readFile(abs, 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT' || error.code === 'EISDIR') return null;
            throw error;
        }
    }

    /** Replaces one existing file of an item folder (Studio's file view; the same change VS Code would make). */
    async writeItemFile(path, rel, content) {
        await atomicWrite(this.#itemFile(path, rel), content);
    }

    #itemFile(path, rel) {
        if (typeof rel !== 'string' || !rel || rel.split('/').some(part => !part || part === '.' || part === '..' || isIgnoredName(part))) {
            throw new Error(`Not a file of the item: ${rel}`);
        }
        return this.resolveInside(`${path}/${rel}`);
    }

    /**
     * Takes an item out of the manifest and deletes its codec files (`owns(rel)`), keeping everything else the user
     * put in the folder; the folder goes when nothing is left. Sync state must be forgotten by the caller first.
     * Returns the files that were kept.
     */
    async removeItem(path, owns, { deleteFiles = true } = {}) {
        const index = this.manifest.items.findIndex(item => item.path === path);
        if (index < 0) return [];
        let kept = [];
        if (deleteFiles) {
            const dir = this.resolveInside(path);
            const current = await this.readItemFiles(path);
            for (const rel of Object.keys(current)) {
                if (owns(rel)) await rm(this.resolveInside(`${path}/${rel}`), { force: true });
                else kept.push(rel);
            }
            await pruneEmptyDirs(dir);
            // Only an empty folder goes: hidden files (not read as item files) are the user's too.
            if ((await readdir(dir).catch(() => [null])).length === 0) await rm(dir, { recursive: true, force: true });
            await removeIfEmpty(dirname(dir));
        }
        this.manifest.items.splice(index, 1);
        delete this.state.items[path];
        await rm(this.internal('base', ...path.split('/')), { recursive: true, force: true });
        await rm(this.internal('conflicts', ...path.split('/')), { recursive: true, force: true });
        await this.saveManifest();
        await this.saveState();
        return kept;
    }

    /**
     * Moves an item folder (with the user's own files in it) to `to`, and everything the workspace keeps under its
     * path: sync state, base snapshots, conflicts. The old path goes to `formerPaths` so history can follow the item.
     * Version refs and in-memory state are the caller's (SyncEngine.moveItem).
     */
    async moveItem(item, to) {
        const from = item.path;
        const dest = this.resolveInside(to);
        if (existsSync(dest)) throw new ProtocolError(ERR.CONFLICT, `${to} 已经存在，请先把这个文件夹移走或改名`);
        await mkdir(dirname(dest), { recursive: true });
        try {
            await rename(this.resolveInside(from), dest);
        } catch (error) {
            await removeIfEmpty(dirname(dest));
            throw new ProtocolError(ERR.HOST_ERROR, `无法移动 ${from}（文件可能正被其他程序打开）：${error.message}`);
        }
        await removeIfEmpty(dirname(this.resolveInside(from)));
        for (const kind of ['base', 'conflicts']) {
            const old = this.internal(kind, ...from.split('/'));
            if (!existsSync(old)) continue;
            const next = this.internal(kind, ...to.split('/'));
            await mkdir(dirname(next), { recursive: true });
            await rename(old, next);
        }
        if (this.state.items[from]) {
            for (const [targetId, state] of Object.entries(this.state.items[from])) {
                if (state.conflict?.file) state.conflict.file = this.internal('conflicts', ...to.split('/'), `${targetId}.json`);
            }
            this.state.items[to] = this.state.items[from];
            delete this.state.items[from];
        }
        const former = [...(item.formerPaths ?? []).filter(p => p !== to && p !== from), from];
        item.path = to;
        item.formerPaths = former;
        await this.saveManifest();
        await this.saveState();
    }

    /**
     * Cellar item folders at `source`, a folder outside the workspace: `source` itself when it is one (has
     * cellar-item.json), else its direct subfolders that are. [{dir, name, kind, files}]; a folder whose
     * cellar-item.json names no known kind has `error` instead.
     */
    async itemFoldersAt(source) {
        const dir = resolve(source);
        const contains = (a, b) => { const r = relative(a, b); return !r || (!isAbsolute(r) && r.split(/[\\/]/)[0] !== '..'); };
        if (contains(dir, this.root) || contains(this.root, dir)) {
            throw new ProtocolError(ERR.BAD_REQUEST, `${dir} 和工作区是同一个文件夹或互相包含，不能导入`);
        }
        const at = async (folder) => {
            const files = await readFolderFiles(folder);
            if (files[ITEM_META] === undefined) return null;
            let kind;
            try { kind = JSON.parse(files[ITEM_META]).kind; } catch { /* reported below */ }
            const name = basename(folder);
            return CODECS[kind] ? { dir: folder, name, kind, files } : { dir: folder, name, error: `${ITEM_META} 没有写明资料项类型` };
        };
        let entries;
        try {
            entries = await readdir(dir, { withFileTypes: true });
        } catch (error) {
            throw new ProtocolError(ERR.NOT_FOUND, `读不到文件夹 ${dir}：${error.message}`);
        }
        const own = await at(dir);
        if (own) return [own];
        const found = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || isIgnoredName(entry.name)) continue;
            const item = await at(join(dir, entry.name));
            if (item) found.push(item);
        }
        return found;
    }

    /**
     * Copies an item folder from outside the workspace to `to` (a copy, never a link): every file but ignored names
     * (dotfiles such as .git, temp files, backups). The caller registers the item.
     */
    async copyIntoWorkspace(source, to) {
        const dest = this.resolveInside(to);
        if (existsSync(dest)) throw new ProtocolError(ERR.CONFLICT, `${to} 已经存在`);
        await cp(source, dest, { recursive: true, filter: src => src === source || !isIgnoredName(basename(src)) });
    }

    async saveConflict(path, targetId, payload) {
        const file = this.internal('conflicts', ...path.split('/'), `${targetId}.json`);
        await mkdir(dirname(file), { recursive: true });
        await atomicWrite(file, JSON.stringify(payload, null, 2) + '\n');
        return file;
    }

    async clearConflict(path, targetId) {
        await rm(this.internal('conflicts', ...path.split('/'), `${targetId}.json`), { force: true });
    }

    async loadConflict(path, targetId) {
        try {
            return JSON.parse(await readFile(this.internal('conflicts', ...path.split('/'), `${targetId}.json`), 'utf8'));
        } catch {
            return undefined;
        }
    }

    /** The data both sides last agreed on (three-way merge base), per item and target. */
    async saveBase(path, targetId, data) {
        const file = this.internal('base', ...path.split('/'), `${targetId}.json`);
        await mkdir(dirname(file), { recursive: true });
        await atomicWrite(file, JSON.stringify(data) + '\n');
    }

    async loadBase(path, targetId) {
        try {
            return JSON.parse(await readFile(this.internal('base', ...path.split('/'), `${targetId}.json`), 'utf8'));
        } catch {
            return undefined;
        }
    }

    /** Forgets everything recorded for one binding: sync state, base snapshot, conflict. */
    async forgetSync(path, targetId) {
        if (this.state.items[path]) {
            delete this.state.items[path][targetId];
            if (!Object.keys(this.state.items[path]).length) delete this.state.items[path];
        }
        await rm(this.internal('base', ...path.split('/'), `${targetId}.json`), { force: true });
        await this.clearConflict(path, targetId);
    }

    async saveTemplate(name, value) {
        const file = this.internal('templates', `${name}.json`);
        await mkdir(dirname(file), { recursive: true });
        await atomicWrite(file, JSON.stringify(value, null, 2) + '\n');
    }

    async loadTemplate(name) {
        try {
            return JSON.parse(await readFile(this.internal('templates', `${name}.json`), 'utf8'));
        } catch {
            return undefined;
        }
    }

    /** A workspace file outside the items (e.g. workshop/prompts.json, see docs/workspace-format.md); null if missing. */
    async readExtraFile(rel) {
        try {
            return await readFile(join(this.root, ...rel.split('/')), 'utf8');
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async writeExtraFile(rel, content) {
        const abs = join(this.root, ...rel.split('/'));
        await mkdir(dirname(abs), { recursive: true });
        await atomicWrite(abs, content);
    }
}

/** A root folder that is not a kind folder (characters, lorebooks, …): a user's project folder. */
export function isProjectFolder(top) {
    return !KIND_FOLDERS.has(top.toLowerCase());
}

/** Dotfiles, temp files and editor backups are never part of an item. */
export function isIgnoredName(name) {
    return name.startsWith('.') || name.endsWith('.tmp') || name.endsWith('~');
}

/** Every file under a folder as UTF-8, keyed by "/"-separated relative path (ignored names skipped; none when missing). */
async function readFolderFiles(dir) {
    const files = {};
    const walk = async (abs, prefix) => {
        let entries;
        try {
            entries = await readdir(abs, { withFileTypes: true });
        } catch (error) {
            if (error.code === 'ENOENT') return;
            throw error;
        }
        for (const entry of entries) {
            if (isIgnoredName(entry.name)) continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await walk(join(abs, entry.name), rel);
            else if (entry.isFile()) files[rel] = await readFile(join(abs, entry.name), 'utf8');
        }
    };
    await walk(dir, '');
    return files;
}

async function atomicWrite(file, content) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
}

/** Deletes a project folder an item left when nothing is left in it; kind folders always stay. */
async function removeIfEmpty(dir) {
    if (KIND_FOLDERS.has(basename(dir).toLowerCase())) return;
    if ((await readdir(dir).catch(() => [null])).length === 0) await rm(dir, { recursive: true, force: true });
}

async function pruneEmptyDirs(dir) {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const child = join(dir, entry.name);
        await pruneEmptyDirs(child);
        if ((await readdir(child)).length === 0) await rm(child, { recursive: true, force: true });
    }
}
