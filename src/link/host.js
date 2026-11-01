/**
 * Host adapter: reads and writes tavern data through the same frontend APIs both ST and tt provide.
 * See docs/architecture.md §4 (write paths) and docs/ROADMAP.md (source references).
 */
import { diffPaths, hashData } from '../../shared/hash.js';
import { ASSET_MAX_BYTES, ERR, GLOBAL_REGEX_ID, MSG, ProtocolError, assertAssetRef, assertItemRef, assertKind } from '../../shared/protocol.js';
import { world_names, newWorldInfoEntryTemplate, worldInfoCache } from '../../../../../world-info.js';

const ctx = () => SillyTavern.getContext();
const watchKey = (kind, id) => `${kind}\u0000${id}`;

/** Whether a dotted path from diffPaths exists in a value ('(root)' always does). */
function hasPath(value, path) {
    if (path === '(root)') return true;
    let v = value;
    for (const key of path.split('.')) {
        if (v === null || typeof v !== 'object' || !Object.prototype.hasOwnProperty.call(v, key)) return false;
        v = v[key];
    }
    return true;
}

async function postJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: ctx().getRequestHeaders(),
        body: JSON.stringify(body),
        cache: 'no-cache',
    });
    return response;
}

async function responseError(response, what) {
    let text = '';
    try { text = (await response.text()).slice(0, 300); } catch { /* ignore */ }
    return new ProtocolError(response.status === 404 ? ERR.NOT_FOUND : ERR.HOST_ERROR, `${what} failed: HTTP ${response.status} ${text}`.trim());
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---- characters -----------------------------------------------------------

/** Canonical card JSON exactly as stored in the PNG. */
async function readCharacter(avatar) {
    const response = await postJson('/api/characters/get', { avatar_url: avatar });
    if (!response.ok) throw await responseError(response, `Reading character ${avatar}`);
    const character = await response.json();
    if (typeof character?.json_data !== 'string' || !character.json_data.trim()) {
        throw new ProtocolError(ERR.HOST_ERROR, `Character ${avatar} has no raw card data`);
    }
    const card = JSON.parse(character.json_data);
    delete card.json_data;
    return card;
}

async function writeCharacter(avatar, card) {
    const response = await postJson('/api/characters/merge-attributes', characterPayload(avatar, card));
    if (!response.ok) throw await responseError(response, `Saving character ${avatar}`);
    await refreshCharacterUi(avatar);
}

/** merge-attributes locates the file by `avatar`, so the stored card always carries it. */
function characterPayload(avatar, card) {
    const body = { ...card, avatar };
    delete body.json_data;
    return body;
}

/** Updates the in-memory character list and re-renders the editor if this character is open. */
async function refreshCharacterUi(avatar) {
    const c = ctx();
    await c.getOneCharacter(avatar);
    const index = c.characters.findIndex(ch => ch.avatar === avatar);
    if (index !== -1 && String(c.characterId) === String(index)) {
        await c.selectCharacterById(index, { switchMenu: false });
    }
}

function listCharacters() {
    return ctx().characters
        .filter(ch => ch && typeof ch.avatar === 'string' && ch.name)
        .map(ch => ({
            id: ch.avatar,
            name: ch.name,
            tags: Array.isArray(ch.tags) ? ch.tags : [],
            dateLastChat: ch.date_last_chat || 0,
        }));
}

// ---- lorebooks ------------------------------------------------------------

/** Reads straight from the backend: the frontend cache could hide a failed save. */
async function readLorebookFromDisk(name) {
    const response = await postJson('/api/worldinfo/get', { name });
    if (!response.ok) throw await responseError(response, `Reading lorebook ${name}`);
    const data = await response.json();
    if (!isPlainObject(data)) throw new ProtocolError(ERR.NOT_FOUND, `Lorebook ${name} not found`);
    return data;
}

async function readLorebook(name) {
    // A book created outside this page (another tab, file copy, offline write-back) is missing until the list refreshes.
    if (!world_names?.includes(name)) await ctx().updateWorldInfoList();
    if (!world_names?.includes(name)) throw new ProtocolError(ERR.NOT_FOUND, `Lorebook ${name} not found`);
    const data = await ctx().loadWorldInfo(name); // cache returns a clone and includes pending editor changes
    if (!isPlainObject(data)) throw new ProtocolError(ERR.NOT_FOUND, `Lorebook ${name} not found`);
    return data;
}

async function writeLorebook(name, data) {
    await ctx().saveWorldInfo(name, structuredClone(data), true);
}

function listLorebooks() {
    return (world_names ?? []).map(name => ({ id: name, name }));
}

// ---- global regex ---------------------------------------------------------

/** Item data of kind 'regex', id 'global': the tavern's global regex list, as kept in extension_settings.regex. */
function readGlobalRegex() {
    const scripts = ctx().extensionSettings.regex;
    return scripts === undefined ? {} : { scripts: structuredClone(scripts) };
}

/** What the backend stored: settings.json read back through the tavern's own settings API (ST and tt alike). */
async function readGlobalRegexFromDisk() {
    const response = await postJson('/api/settings/get', {});
    if (!response.ok) throw await responseError(response, 'Reading settings');
    const body = await response.json();
    const settings = typeof body?.settings === 'string' ? JSON.parse(body.settings) : body?.settings;
    const scripts = settings?.extension_settings?.regex;
    return scripts === undefined ? {} : { scripts };
}

function assertGlobalRegexData(data) {
    const extra = Object.keys(data).filter(k => k !== 'scripts');
    if (extra.length) throw new ProtocolError(ERR.BAD_REQUEST, `Global regex data has unknown keys: ${extra.join(', ')}`);
    if (!Array.isArray(data.scripts) || !data.scripts.every(isPlainObject)) {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Global regex scripts must be a list of objects');
    }
}

const SETTINGS_SAVE_TIMEOUT_MS = 15000;

/**
 * Same write path as the regex extension's own saveScriptsByType(GLOBAL): assign extension_settings.regex and save
 * the settings. Resolves with what settings.json holds once it matches `scripts` (or the timeout passes; the caller
 * then reports the difference).
 */
async function writeGlobalRegex(scripts) {
    const c = ctx();
    const wanted = await hashData({ scripts });
    const deadline = Date.now() + SETTINGS_SAVE_TIMEOUT_MS;
    c.extensionSettings.regex = structuredClone(scripts);
    let stored;
    do {
        const saved = new Promise(resolve => {
            const done = () => { clearTimeout(timer); c.eventSource.removeListener(c.eventTypes.SETTINGS_UPDATED, done); resolve(); };
            const timer = setTimeout(done, Math.max(0, deadline - Date.now()));
            c.eventSource.on(c.eventTypes.SETTINGS_UPDATED, done);
        });
        c.saveSettingsDebounced();
        await saved;
        stored = await readGlobalRegexFromDisk();
        if (await hashData(stored) === wanted) return stored; // a save already in flight may land first: retry
    } while (Date.now() < deadline);
    return stored;
}

/**
 * The regex panel keeps every row bound to the script object it rendered (by index), so after we replace the list a
 * stale row would write the old script back. Refresh choices (Cellar Link settings, `regexRefresh`):
 *   'lock'  lock the stale global list with a notice until the regex extension re-renders it (page reload, or any
 *           regex action that re-renders); no tavern events are emitted
 *   'event' emit MAIN_API_CHANGED for the current API: the regex extension re-renders its panel right away, but every
 *           other extension listening to that event also reacts as if the API had been switched
 */
/** Removes the lock of a stale regex list; set while one is shown. */
let unlockRegexPanel = () => {};

async function refreshRegexPanel(mode) {
    if (mode === 'event') {
        const c = ctx();
        await c.eventSource.emit(c.eventTypes.MAIN_API_CHANGED, { apiId: c.mainApi });
        unlockRegexPanel(); // re-rendered (an empty list re-renders without any DOM change, so don't rely on the observer)
        return;
    }
    const list = document.getElementById('saved_regex_scripts');
    if (!list || list.classList.contains('tavern-cellar-stale')) return;
    list.classList.add('tavern-cellar-stale');
    const notice = document.createElement('div');
    notice.className = 'tavern-cellar-stale-notice';
    notice.textContent = '全局正则已由 TavernCellar 更新，新内容已生效。下面的列表是旧的，已锁定，刷新页面后可再编辑。';
    list.before(notice);
    const observer = new MutationObserver(() => unlockRegexPanel()); // the regex extension re-rendered the list
    unlockRegexPanel = () => {
        observer.disconnect();
        list.classList.remove('tavern-cellar-stale');
        notice.remove();
        unlockRegexPanel = () => {};
    };
    observer.observe(list, { childList: true });
}

function assertGlobalRegexId(id) {
    if (id !== GLOBAL_REGEX_ID) throw new ProtocolError(ERR.NOT_FOUND, `Regex list ${id} not found (only "${GLOBAL_REGEX_ID}")`);
    return id;
}

// ---- assets ---------------------------------------------------------------

function bytesToBase64(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

/** Avatar thumbnail through the tavern's own thumbnail URL (ST and tt both expose getThumbnailUrl). */
async function readAsset({ type, id }) {
    const response = await fetch(ctx().getThumbnailUrl(type, id), { cache: 'no-cache' });
    if (!response.ok) throw await responseError(response, `Reading ${type} ${id}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > ASSET_MAX_BYTES) throw new ProtocolError(ERR.BAD_REQUEST, `${type} ${id} is larger than ${ASSET_MAX_BYTES} bytes`);
    const mime = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
    return { type, id, mime, data: bytesToBase64(bytes) };
}

// ---- host -----------------------------------------------------------------

export class Host {
    /** @param {{emit: (type: string, payload: any) => void}} link */
    /**
     * @param {{emit: (type: string, payload: any) => void}} link
     * @param {{regexRefresh?: () => 'lock'|'event'}} [options]
     */
    constructor(link, { regexRefresh = () => 'lock' } = {}) {
        this.link = link;
        this.regexRefresh = regexRefresh;
        /** Hash of the global regex list last seen, so settings saves that did not touch it are not reported. */
        this.regexHash = null;
        this.onSettingsUpdated = this.onSettingsUpdated.bind(this);
        this.watched = new Set();
        /** Items currently being written by us; their change events are our own echo. */
        this.writing = new Set();
        this.onWorldInfoUpdated = this.onWorldInfoUpdated.bind(this);
        this.onCharacterEdited = this.onCharacterEdited.bind(this);
    }

    capabilities() {
        return {
            kinds: ['character', 'lorebook', 'regex'],
            worldInfoEntryTemplate: structuredClone(newWorldInfoEntryTemplate),
        };
    }

    attachEvents() {
        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.WORLDINFO_UPDATED, this.onWorldInfoUpdated);
        eventSource.on(eventTypes.CHARACTER_EDITED, this.onCharacterEdited);
        eventSource.on(eventTypes.SETTINGS_UPDATED, this.onSettingsUpdated);
    }

    detachEvents() {
        const { eventSource, eventTypes } = ctx();
        eventSource.removeListener(eventTypes.WORLDINFO_UPDATED, this.onWorldInfoUpdated);
        eventSource.removeListener(eventTypes.CHARACTER_EDITED, this.onCharacterEdited);
        eventSource.removeListener(eventTypes.SETTINGS_UPDATED, this.onSettingsUpdated);
    }

    async handle(type, payload) {
        switch (type) {
            case MSG.PING: return {};
            case MSG.CATALOG_LIST: return this.catalog(payload);
            case MSG.ITEM_GET: return this.get(payload);
            case MSG.ITEM_PUT: return this.put(payload);
            case MSG.WATCH_SET: return this.setWatch(payload);
            case MSG.ASSET_GET: assertAssetRef(payload); return readAsset(payload);
            default: throw new ProtocolError(ERR.BAD_REQUEST, `Unknown request type: ${type}`);
        }
    }

    async catalog({ kind, query, offset = 0, limit = 50 }) {
        assertKind(kind);
        const start = Math.max(0, Number(offset) || 0);
        if (kind === 'regex') {
            const scripts = ctx().extensionSettings.regex;
            const items = [{ id: GLOBAL_REGEX_ID, name: '全局正则', count: Array.isArray(scripts) ? scripts.length : 0 }];
            return { total: 1, items: start === 0 ? items : [] };
        }
        // Browsing starts at page one: reload the list so items added outside this page show up; later pages reuse it.
        if (start === 0) await (kind === 'character' ? ctx().getCharacters() : ctx().updateWorldInfoList());
        let items = kind === 'character' ? listCharacters() : listLorebooks();
        if (typeof query === 'string' && query.trim()) {
            const q = query.trim().toLowerCase();
            items = items.filter(item => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q));
        }
        items.sort((a, b) => a.name.localeCompare(b.name));
        const count = Math.min(500, Math.max(1, Number(limit) || 50));
        return { total: items.length, items: items.slice(start, start + count) };
    }

    async read(kind, id) {
        if (kind === 'regex') return readGlobalRegex(assertGlobalRegexId(id));
        return kind === 'character' ? readCharacter(id) : readLorebook(id);
    }

    async get(payload) {
        assertItemRef(payload);
        const data = await this.read(payload.kind, payload.id);
        return { data, hash: await hashData(data) };
    }

    async put(payload) {
        assertItemRef(payload);
        const { kind, id, data, baseHash } = payload;
        if (!isPlainObject(data)) throw new ProtocolError(ERR.BAD_REQUEST, 'data must be an object');
        const key = watchKey(kind, id);
        if (this.writing.has(key)) throw new ProtocolError(ERR.CONFLICT, `${kind} ${id} is already being written`);
        this.writing.add(key);
        try {
            const current = await this.read(kind, id);
            const currentHash = await hashData(current);
            if (baseHash !== currentHash) {
                throw new ProtocolError(ERR.CONFLICT, `${kind} ${id} changed in the tavern`, { currentHash });
            }
            if (kind === 'character') await writeCharacter(id, data);
            else if (kind === 'regex') assertGlobalRegexData(data);
            else await writeLorebook(id, data);

            // Re-read what the backend actually stored (lorebooks: bypass the frontend cache).
            const stored = kind === 'character' ? await readCharacter(id)
                : kind === 'regex' ? await writeGlobalRegex(data.scripts)
                    : await readLorebookFromDisk(id);
            const sent = kind === 'character' ? characterPayload(id, data) : data;
            const hash = await hashData(stored);
            const sentHash = await hashData(sent);
            if (hash === currentHash && sentHash !== currentHash) {
                // The only changes were deleted fields and the tavern kept them: saved, worth a warning, not an error.
                const paths = diffPaths(sent, current, 50);
                if (!paths.length || !paths.every(p => !hasPath(sent, p))) {
                    throw new ProtocolError(ERR.HOST_ERROR, `${kind} ${id} was not saved (backend still returns the old data)`);
                }
                return { data: stored, hash, warnings: [{ code: 'kept-deleted', paths }] };
            }
            const warnings = [];
            // Structured warnings ({ code, ...params }): Cellar Studio words them in the user's language.
            if (hash !== sentHash) warnings.push({ code: 'normalized', paths: diffPaths(sent, stored) });
            if (kind === 'lorebook') {
                if (hash !== sentHash) worldInfoCache.set(id, structuredClone(stored));
                ctx().reloadWorldInfoEditor(id, false);
            }
            if (kind === 'regex') {
                this.regexHash = hash;
                refreshRegexPanel(this.regexRefresh()).catch(error => console.warn('[Cellar Link] regex panel refresh failed', error));
            }
            return { data: stored, hash, warnings };
        } finally {
            this.writing.delete(key);
        }
    }

    setWatch({ items }) {
        if (!Array.isArray(items)) throw new ProtocolError(ERR.BAD_REQUEST, 'items must be an array');
        this.watched = new Set(items.filter(i => i && typeof i.id === 'string').map(i => watchKey(i.kind, i.id)));
        return { count: this.watched.size };
    }

    async notify(kind, id, data) {
        const key = watchKey(kind, id);
        if (!this.watched.has(key) || this.writing.has(key)) return;
        try {
            const value = data ?? await this.read(kind, id);
            this.link.emit(MSG.ITEM_CHANGED, { kind, id, hash: await hashData(value) });
        } catch (error) {
            console.warn('[Cellar Link] change notification failed', kind, id, error);
        }
    }

    onWorldInfoUpdated(name, data) {
        if (typeof name === 'string') this.notify('lorebook', name, isPlainObject(data) ? data : undefined);
    }

    onCharacterEdited(event) {
        const avatar = event?.detail?.character?.avatar;
        if (typeof avatar === 'string') this.notify('character', avatar);
    }

    /** Every settings save: report the global regex list only when it actually changed. */
    async onSettingsUpdated() {
        const key = watchKey('regex', GLOBAL_REGEX_ID);
        if (!this.watched.has(key) || this.writing.has(key)) return;
        const data = readGlobalRegex();
        const hash = await hashData(data);
        if (hash === this.regexHash) return;
        this.regexHash = hash;
        this.notify('regex', GLOBAL_REGEX_ID, data);
    }
}
