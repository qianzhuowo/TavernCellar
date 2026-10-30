/**
 * Host adapter: reads and writes tavern data through the same frontend APIs both ST and tt provide.
 * See docs/architecture.md §4 (write paths) and docs/ROADMAP.md (source references).
 */
import { diffPaths, hashData } from '../../shared/hash.js';
import { ERR, MSG, ProtocolError, assertItemRef, assertKind } from '../../shared/protocol.js';
import { world_names, newWorldInfoEntryTemplate, worldInfoCache } from '../../../../../world-info.js';

const ctx = () => SillyTavern.getContext();
const watchKey = (kind, id) => `${kind}\u0000${id}`;

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

// ---- host -----------------------------------------------------------------

export class Host {
    /** @param {{emit: (type: string, payload: any) => void}} link */
    constructor(link) {
        this.link = link;
        this.watched = new Set();
        /** Items currently being written by us; their change events are our own echo. */
        this.writing = new Set();
        this.onWorldInfoUpdated = this.onWorldInfoUpdated.bind(this);
        this.onCharacterEdited = this.onCharacterEdited.bind(this);
    }

    capabilities() {
        return {
            kinds: ['character', 'lorebook'],
            worldInfoEntryTemplate: structuredClone(newWorldInfoEntryTemplate),
        };
    }

    attachEvents() {
        const { eventSource, eventTypes } = ctx();
        eventSource.on(eventTypes.WORLDINFO_UPDATED, this.onWorldInfoUpdated);
        eventSource.on(eventTypes.CHARACTER_EDITED, this.onCharacterEdited);
    }

    detachEvents() {
        const { eventSource, eventTypes } = ctx();
        eventSource.removeListener(eventTypes.WORLDINFO_UPDATED, this.onWorldInfoUpdated);
        eventSource.removeListener(eventTypes.CHARACTER_EDITED, this.onCharacterEdited);
    }

    async handle(type, payload) {
        switch (type) {
            case MSG.PING: return {};
            case MSG.CATALOG_LIST: return this.catalog(payload);
            case MSG.ITEM_GET: return this.get(payload);
            case MSG.ITEM_PUT: return this.put(payload);
            case MSG.WATCH_SET: return this.setWatch(payload);
            default: throw new ProtocolError(ERR.BAD_REQUEST, `Unknown request type: ${type}`);
        }
    }

    async catalog({ kind, query, offset = 0, limit = 50 }) {
        assertKind(kind);
        const start = Math.max(0, Number(offset) || 0);
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
            else await writeLorebook(id, data);

            // Re-read what the backend actually stored (lorebooks: bypass the frontend cache).
            const stored = kind === 'character' ? await readCharacter(id) : await readLorebookFromDisk(id);
            const sent = kind === 'character' ? characterPayload(id, data) : data;
            const hash = await hashData(stored);
            const sentHash = await hashData(sent);
            if (hash === currentHash && sentHash !== currentHash) {
                throw new ProtocolError(ERR.HOST_ERROR, `${kind} ${id} was not saved (backend still returns the old data)`);
            }
            const warnings = [];
            if (hash !== sentHash) warnings.push(`Tavern normalized the saved data: ${diffPaths(sent, stored).join(', ')}`);
            if (kind === 'lorebook') {
                if (hash !== sentHash) worldInfoCache.set(id, structuredClone(stored));
                ctx().reloadWorldInfoEditor(id, false);
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
}
