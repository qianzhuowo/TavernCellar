/**
 * Workspace on disk: cellar.json manifest, .cellar/ internal state, item folders.
 * See docs/workspace-format.md. All paths handled here stay inside the workspace root.
 */
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { safeSegment } from '../codec/text.js';
import { codecFor } from '../codec/index.js';

export const MANIFEST_FILE = 'cellar.json';
const INTERNAL_DIR = '.cellar';
const MANIFEST_VERSION = 1;

export class Workspace {
    /** @param {string} root absolute workspace directory */
    constructor(root) {
        this.root = resolve(root);
        this.manifest = { version: MANIFEST_VERSION, targets: {}, items: [] };
        this.state = { version: 1, items: {} };
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
    }

    internal(...parts) {
        return join(this.root, INTERNAL_DIR, ...parts);
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

    /** Picks a free folder for a new item: characters/<name>, characters/<name>-2, ... */
    allocateItemPath(kind, id) {
        const codec = codecFor(kind);
        const base = `${codec.folder}/${safeSegment(codec.nameOf(id))}`;
        const taken = new Set(this.manifest.items.map(item => item.path.toLowerCase()));
        let path = base;
        for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${base}-${n}`;
        return path;
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
        const dir = this.resolveInside(path);
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

    async saveConflict(path, targetId, payload) {
        const file = this.internal('conflicts', ...path.split('/'), `${targetId}.json`);
        await mkdir(dirname(file), { recursive: true });
        await atomicWrite(file, JSON.stringify(payload, null, 2) + '\n');
        return file;
    }

    async clearConflict(path, targetId) {
        await rm(this.internal('conflicts', ...path.split('/'), `${targetId}.json`), { force: true });
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
}

/** Dotfiles, temp files and editor backups are never part of an item. */
export function isIgnoredName(name) {
    return name.startsWith('.') || name.endsWith('.tmp') || name.endsWith('~');
}

async function atomicWrite(file, content) {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, file);
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
