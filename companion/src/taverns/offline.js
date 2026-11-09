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
import { ASSET_MAX_BYTES, ERR, GLOBAL_REGEX_ID, MSG, PRESET_APIS, ProtocolError, assertAssetRef, assertAvatarRequest, assertItemRef, assertKind, assertNewItemName, canonicalCharacter, parsePresetId, withHostFields, presetId } from '../../../shared/protocol.js';
import { isTavernRunning } from './locations.js';
import { placeholderPng, readCardText, withImage, writeCard } from './png.js';

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

/** Thumbnails keep the card's .png name but are usually JPEG: tell by the bytes. */
export function imageMime(bytes) {
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
    if (bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return 'application/octet-stream';
}

/** settings.json of a tavern user: a JSON object (BOM tolerated). */
function parseSettings(content) {
    const settings = JSON.parse(content.toString('utf8').replace(/^\uFEFF/, ''));
    if (!isPlainObject(settings)) throw new Error('settings.json is not a JSON object');
    return settings;
}

function assertRegexData(data) {
    const extra = Object.keys(data).filter(k => k !== 'scripts');
    if (extra.length) throw new ProtocolError(ERR.BAD_REQUEST, `Global regex data has unknown keys: ${extra.join(', ')}`);
    if (!Array.isArray(data.scripts) || !data.scripts.every(isPlainObject)) {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Global regex scripts must be a list of objects');
    }
}

/**
 * JSON text in the layout of `original`: same indentation (detected from the first key; tabs kept), line endings,
 * BOM and trailing newline. Presets are written by the taverns with different indents (ST 4 spaces, tt 2 or 4).
 */
export function formatLike(original, value) {
    const text = original.toString('utf8');
    const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
    const body = text.slice(bom.length);
    const indent = /^\{\r?\n([ \t]+)"/.exec(body)?.[1] ?? (/^\{\s*\r?\n/.test(body) ? 4 : undefined);
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    let out = JSON.stringify(value, null, indent);
    if (eol === '\r\n') out = out.replace(/\n/g, '\r\n');
    if (/\r?\n$/.test(text)) out += eol;
    return Buffer.from(bom + out, 'utf8');
}

/**
 * settings.json with only extension_settings.regex replaced. Keeps the file's indentation (ST writes 4 spaces, tt 2),
 * line endings and key order, so nothing else in the file changes.
 */
export function replaceSettingsRegex(content, scripts) {
    const settings = parseSettings(content);
    if (!isPlainObject(settings.extension_settings)) settings.extension_settings = {};
    settings.extension_settings.regex = scripts;
    return formatLike(content, settings);
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
            case MSG.ITEM_CREATE: return this.create(payload);
            // Renaming also moves chats and updates the tavern's settings in memory: only the running tavern does it.
            case MSG.ITEM_RENAME: throw new ProtocolError(ERR.BAD_REQUEST, '改名需要酒馆在运行（打开酒馆后再试）');
            case MSG.ASSET_GET: return this.asset(payload);
            case MSG.ITEM_AVATAR: return this.setAvatar(payload);
            default: throw new ProtocolError(ERR.BAD_REQUEST, `Unknown request type: ${type}`);
        }
    }

    // ---- paths --------------------------------------------------------------

    charactersDir() { return join(this.location.userDir, 'characters'); }
    worldsDir() { return join(this.location.userDir, 'worlds'); }

    fileFor(kind, id) {
        if (kind === 'regex') {
            if (id !== GLOBAL_REGEX_ID) throw new ProtocolError(ERR.NOT_FOUND, `Regex list ${id} not found (only "${GLOBAL_REGEX_ID}")`);
            return join(this.location.userDir, 'settings.json');
        }
        if (kind === 'preset') {
            const { apiId, name } = parsePresetId(id);
            return join(this.location.userDir, PRESET_APIS[apiId], safeFileName(`${name}.json`));
        }
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
            if (kind === 'character') return canonicalCharacter(JSON.parse(readCardText(content)), id);
            if (kind === 'regex') {
                const scripts = parseSettings(content).extension_settings?.regex;
                return scripts === undefined ? {} : { scripts };
            }
            const data = JSON.parse(content.toString('utf8').replace(/^\uFEFF/, ''));
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
        if (kind === 'regex') {
            const { data } = await this.readItem('regex', GLOBAL_REGEX_ID).catch(() => ({ data: {} }));
            items = [{ id: GLOBAL_REGEX_ID, name: '全局正则', count: Array.isArray(data.scripts) ? data.scripts.length : 0 }];
        } else if (kind === 'preset') {
            items = [];
            for (const [apiId, folder] of Object.entries(PRESET_APIS)) {
                const names = (await readdir(join(this.location.userDir, folder)).catch(() => [])).filter(n => n.toLowerCase().endsWith('.json'));
                for (const n of names) {
                    const name = n.slice(0, -5);
                    try { items.push({ id: presetId(apiId, name), name, apiId }); } catch { /* not a valid preset name */ }
                }
            }
        } else if (kind === 'character') {
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

    // ---- assets -------------------------------------------------------------

    /**
     * Avatar thumbnail without the tavern: the thumbnail it generated earlier when that is not older than the card,
     * else the card itself when small enough. Never generates or writes thumbnails (the tavern owns that folder).
     */
    async asset(payload) {
        assertAssetRef(payload);
        const { type, id } = payload;
        const original = join(this.charactersDir(), safeFileName(id));
        const thumb = join(this.location.userDir, 'thumbnails', 'avatar', safeFileName(id));
        const [o, t] = await Promise.all([stat(original).catch(() => null), stat(thumb).catch(() => null)]);
        if (!o) throw new ProtocolError(ERR.NOT_FOUND, `${type} ${id} not found`);
        const file = t && t.mtimeMs >= o.mtimeMs && t.size <= ASSET_MAX_BYTES ? thumb : o.size <= ASSET_MAX_BYTES ? original : null;
        if (!file) throw new ProtocolError(ERR.NOT_FOUND, `${type} ${id} has no thumbnail small enough to read offline`);
        const bytes = await readFile(file);
        return { type, id, mime: imageMime(bytes), data: bytes.toString('base64') };
    }

    // ---- write --------------------------------------------------------------

    async backup(kind, id, file) {
        const root = this.backupDir();
        if (!root) throw new ProtocolError(ERR.HOST_ERROR, 'No workspace for offline backups');
        const dir = join(root, this.location.targetId, kind === 'preset' ? `preset-${parsePresetId(id).apiId}` : kind);
        await mkdir(dir, { recursive: true });
        const base = safeFileName(kind === 'character' ? id : kind === 'regex' ? 'settings.json' : kind === 'preset' ? `${parsePresetId(id).name}.json` : `${id}.json`);
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
        const sent = kind === 'character' ? withHostFields(canonicalCharacter(data, id), JSON.parse(readCardText(current.content))) : structuredClone(data);
        delete sent.json_data;
        if (kind === 'regex') assertRegexData(sent);
        const content = kind === 'character' ? writeCard(current.content, sent)
            : kind === 'regex' ? replaceSettingsRegex(current.content, sent.scripts)
                : kind === 'preset' ? formatLike(current.content, sent)
                    : Buffer.from(JSON.stringify(sent, null, 4), 'utf8');
        const backup = await this.backup(kind, id, file);
        await writeAtomic(file, content);

        const stored = (await this.readItem(kind, id)).data;
        const hash = await hashData(stored);
        const warnings = [{ code: 'offline-written', file, backup }];
        if (hash !== await hashData(sent)) warnings.push({ code: 'normalized', paths: diffPaths(sent, stored) });
        return { kind, id, hash, data: stored, warnings };
    }

    /**
     * Replaces a character's avatar (`item.avatar`): the new PNG gets the card's chunks byte for byte, so the card
     * data and its hash stay. Same rules as `put`: only while the tavern is closed, backed up first, written
     * atomically and re-read. The tavern regenerates its thumbnail since the card is newer.
     */
    async setAvatar(payload) {
        assertAvatarRequest(payload);
        const { kind, id, image } = payload;
        if (await this.isRunning(this.location)) {
            throw new ProtocolError(ERR.TAVERN_RUNNING, `${this.location.label} is running; enable Cellar Link in it to change the avatar, or close it to write offline`);
        }
        const file = this.fileFor(kind, id);
        const current = await this.readItem(kind, id);
        let content;
        try {
            content = withImage(current.content, Buffer.from(image, 'base64'));
        } catch (error) {
            throw new ProtocolError(ERR.BAD_REQUEST, `头像不是有效的 PNG 图片：${error.message}`);
        }
        const backup = await this.backup(kind, id, file);
        await writeAtomic(file, content);
        const stored = (await this.readItem(kind, id)).data;
        return { kind, id, hash: await hashData(stored), data: stored, warnings: [{ code: 'offline-written', file, backup }] };
    }

    /**
     * Creates an item that is not in the data folder yet (`item.create`). Characters are named `<name>.png` (like the
     * tavern does) with a plain placeholder avatar; an existing file is never replaced.
     */
    async create({ kind, name, id: requested, data }) {
        assertKind(kind);
        if (kind === 'regex') throw new ProtocolError(ERR.BAD_REQUEST, 'The global regex list always exists');
        assertNewItemName(name);
        if (!isPlainObject(data)) throw new ProtocolError(ERR.BAD_REQUEST, 'data must be an object');
        if (await this.isRunning(this.location)) {
            throw new ProtocolError(ERR.TAVERN_RUNNING, `${this.location.label} is running; enable Cellar Link in it to create items, or close it to write offline`);
        }
        const id = kind === 'character' ? `${name}.png` : kind === 'preset' ? (requested ?? presetId('openai', name)) : name;
        assertItemRef({ kind, id });
        const file = this.fileFor(kind, id);
        if (await stat(file).then(() => true, () => false)) throw new ProtocolError(ERR.CONFLICT, `酒馆里已有同名的${kind === 'character' ? '角色卡' : kind === 'preset' ? '预设' : '世界书'}：${name}`, { kind, id });
        await mkdir(join(file, '..'), { recursive: true });
        const sent = kind === 'character' ? canonicalCharacter(data, id) : structuredClone(data);
        delete sent.json_data;
        const content = kind === 'character' ? writeCard(placeholderPng(), sent) : Buffer.from(JSON.stringify(sent, null, 4), 'utf8');
        await writeAtomic(file, content);
        const stored = (await this.readItem(kind, id)).data;
        const hash = await hashData(stored);
        const warnings = [{ code: 'offline-written', file }];
        if (hash !== await hashData(sent)) warnings.push({ code: 'normalized', paths: diffPaths(sent, stored) });
        return { kind, id, hash, data: stored, warnings };
    }
}
