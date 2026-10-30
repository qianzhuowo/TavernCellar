/**
 * Offline access to a tavern's data folder, with the same request interface as a live Cellar Link
 * (`request(type, payload)`), so the sync engine treats both alike.
 *
 * Reads produce exactly the data the live link reports (card JSON as stored in the PNG, world JSON as stored on disk),
 * so hashes match across online and offline access.
 * Writes are allowed only while the tavern is not running: a running tavern keeps its own copy in memory and would
 * overwrite the file later. Every write re-checks baseHash against the file, backs the file up, writes atomically
 * (temp file + rename) and reads the result back.
 */
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { diffPaths, hashData } from '../../../shared/hash.js';
import { ERR, MSG, ProtocolError, assertItemRef, assertKind } from '../../../shared/protocol.js';
import { isTavernRunning } from './locations.js';
import { readCardText, writeCard } from './png.js';

const BACKUPS_PER_ITEM = 5;

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Ids come from the workspace or the user; they must name a file directly inside the folder. */
function safeFileName(id) {
    if (typeof id !== 'string' || !id || id !== basename(id) || id === '.' || id === '..' || /[\\/:*?"<>|]/.test(id)) {
        throw new ProtocolError(ERR.BAD_REQUEST, `Invalid item id: ${id}`);
    }
    return id;
}

async function writeAtomic(file, content) {
    const temp = `${file}.cellar-${process.pid}-${Date.now()}.tmp`;
    await writeFile(temp, content);
    try {
        await rename(temp, file);
    } catch (error) {
        await rm(temp, { force: true });
        throw error;
    }
}

export class OfflineLink {
    /**
     * @param {import('./locations.js').TavernLocation} location resolved location with userDir and targetId
     * @param {{backupDir: () => string|null, isRunning?: (loc: object) => Promise<boolean>}} options
     */
    constructor(location, { backupDir, isRunning = isTavernRunning }) {
        this.location = location;
        this.backupDir = backupDir;
        this.isRunning = isRunning;
        /** @type {Map<string, {mtimeMs: number, size: number, summary: object|null}>} */
        this.summaries = new Map();
    }

    get target() {
        const loc = this.location;
        return { id: loc.targetId, host: loc.host, label: loc.label, offline: true, location: loc.key };
    }

    close() { /* nothing to close */ }

    async request(type, payload = {}) {
        switch (type) {
            case MSG.PING: return { now: Date.now() };
            case MSG.WATCH_SET: return { count: 0 }; // no change events offline; pull compares hashes instead
            case MSG.CATALOG_LIST: return this.catalog(payload);
            case MSG.ITEM_GET: return this.get(payload);
            case MSG.ITEM_PUT: return this.put(payload);
            default: throw new ProtocolError(ERR.BAD_REQUEST, `Unknown request type: ${type}`);
        }
    }

    // ---- paths --------------------------------------------------------------

    charactersDir() { return join(this.location.userDir, 'characters'); }
    worldsDir() { return join(this.location.userDir, 'worlds'); }

    fileFor(kind, id) {
        return kind === 'character'
            ? join(this.charactersDir(), safeFileName(id))
            : join(this.worldsDir(), safeFileName(`${id}.json`));
    }

    // ---- read ---------------------------------------------------------------

    async readItem(kind, id) {
        const file = this.fileFor(kind, id);
        let content;
        try {
            content = await readFile(file);
        } catch (error) {
            if (error.code === 'ENOENT') throw new ProtocolError(ERR.NOT_FOUND, `${kind} ${id} not found`);
            throw new ProtocolError(ERR.HOST_ERROR, `Reading ${file}: ${error.message}`);
        }
        return { content, data: this.decode(kind, id, content) };
    }

    decode(kind, id, content) {
        try {
            if (kind === 'character') {
                const card = JSON.parse(readCardText(content));
                delete card.json_data;
                return card;
            }
            const data = JSON.parse(content.toString('utf8'));
            if (!isPlainObject(data)) throw new Error('not a JSON object');
            return data;
        } catch (error) {
            throw new ProtocolError(ERR.HOST_ERROR, `${kind} ${id} cannot be parsed: ${error.message}`);
        }
    }

    async get({ kind, id }) {
        assertItemRef({ kind, id });
        const { data } = await this.readItem(kind, id);
        return { kind, id, hash: await hashData(data), data };
    }

    /** Summary of one character card, cached by mtime + size so listing 200+ cards stays cheap. */
    async characterSummary(name) {
        const file = join(this.charactersDir(), name);
        const info = await stat(file);
        const cached = this.summaries.get(file);
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.summary;
        let summary = null;
        try {
            const card = JSON.parse(readCardText(await readFile(file)));
            const data = isPlainObject(card.data) ? card.data : card;
            const cardName = data.name || card.name;
            if (cardName) summary = { id: name, name: String(cardName), tags: Array.isArray(data.tags) ? data.tags : [] };
        } catch { /* not a character card */ }
        this.summaries.set(file, { mtimeMs: info.mtimeMs, size: info.size, summary });
        return summary;
    }

    /** Last chat time: newest file in chats/<avatar without .png>/ (what the tavern shows as "last chat"). */
    async lastChat(avatar) {
        const dir = join(this.location.userDir, 'chats', avatar.replace(/\.png$/i, ''));
        try {
            const files = await readdir(dir);
            let newest = 0;
            for (const f of files) {
                if (!f.endsWith('.jsonl')) continue;
                newest = Math.max(newest, (await stat(join(dir, f))).mtimeMs);
            }
            return Math.round(newest);
        } catch {
            return 0;
        }
    }

    async catalog({ kind, query, offset = 0, limit = 50 }) {
        assertKind(kind);
        let items;
        if (kind === 'character') {
            const names = (await readdir(this.charactersDir()).catch(() => [])).filter(n => n.toLowerCase().endsWith('.png'));
            items = (await Promise.all(names.map(n => this.characterSummary(n).catch(() => null)))).filter(Boolean);
            await Promise.all(items.map(async item => { item.dateLastChat = await this.lastChat(item.id); }));
        } else {
            const names = (await readdir(this.worldsDir()).catch(() => [])).filter(n => n.toLowerCase().endsWith('.json'));
            items = names.map(n => { const name = n.slice(0, -5); return { id: name, name }; });
        }
        if (typeof query === 'string' && query.trim()) {
            const q = query.trim().toLowerCase();
            items = items.filter(item => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q));
        }
        items.sort((a, b) => a.name.localeCompare(b.name));
        const start = Math.max(0, Number(offset) || 0);
        const count = Math.min(500, Math.max(1, Number(limit) || 50));
        return { total: items.length, items: items.slice(start, start + count) };
    }

    // ---- write --------------------------------------------------------------

    async backup(kind, id, file) {
        const root = this.backupDir();
        if (!root) throw new ProtocolError(ERR.HOST_ERROR, 'No workspace for offline backups');
        const dir = join(root, this.location.targetId, kind);
        await mkdir(dir, { recursive: true });
        const base = safeFileName(kind === 'character' ? id : `${id}.json`);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const target = join(dir, `${stamp}__${base}`);
        await copyFile(file, target);
        const mine = (await readdir(dir)).filter(n => n.endsWith(`__${base}`)).sort();
        for (const old of mine.slice(0, Math.max(0, mine.length - BACKUPS_PER_ITEM))) await rm(join(dir, old), { force: true });
        return target;
    }

    async put({ kind, id, data, baseHash }) {
        assertItemRef({ kind, id });
        if (!isPlainObject(data)) throw new ProtocolError(ERR.BAD_REQUEST, 'data must be an object');
        if (typeof baseHash !== 'string') throw new ProtocolError(ERR.BAD_REQUEST, 'baseHash is required');
        if (await this.isRunning(this.location)) {
            throw new ProtocolError(ERR.TAVERN_RUNNING, `${this.location.label} is running; enable Cellar Link in it to sync, or close it to write offline`);
        }
        const file = this.fileFor(kind, id);
        const current = await this.readItem(kind, id);
        const currentHash = await hashData(current.data);
        if (currentHash !== baseHash) {
            throw new ProtocolError(ERR.CONFLICT, `${kind} ${id} changed in the tavern`, { currentHash });
        }
        const sent = structuredClone(data);
        delete sent.json_data;
        const content = kind === 'character'
            ? writeCard(current.content, sent)
            : Buffer.from(JSON.stringify(sent, null, 4), 'utf8');
        const backup = await this.backup(kind, id, file);
        await writeAtomic(file, content);

        const stored = (await this.readItem(kind, id)).data;
        const hash = await hashData(stored);
        const warnings = [`Written offline to ${file} (backup: ${backup})`];
        if (hash !== await hashData(sent)) warnings.push(`Tavern normalized the saved data: ${diffPaths(sent, stored).join(', ')}`);
        return { kind, id, hash, data: stored, warnings };
    }
}
