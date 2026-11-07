/**
 * Cellar protocol v1 — see docs/protocol.md.
 * Pure ESM, no dependencies: imported by Cellar Link (browser) and the companion (Node).
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7349;
export const LINK_PATH = '/link';
export const HELLO_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 30000;

export const KINDS = Object.freeze(['character', 'lorebook', 'regex', 'preset']);
/** The only id of kind 'regex': the tavern's global regex list (extension_settings.regex). */
export const GLOBAL_REGEX_ID = 'global';

/**
 * Preset types (the tavern's preset manager apiIds) and their data folder. A preset id is `<apiId>/<name>`; the name
 * is the file name without `.json`, which the tavern sanitizes, so it never contains `/`.
 */
export const PRESET_APIS = Object.freeze({
    openai: 'OpenAI Settings',
    textgenerationwebui: 'TextGen Settings',
    kobold: 'KoboldAI Settings',
    novel: 'NovelAI Settings',
    instruct: 'instruct',
    context: 'context',
    sysprompt: 'sysprompt',
    reasoning: 'reasoning',
});

/** Splits a preset id into its apiId and name; throws bad_request when it is not one. */
export function parsePresetId(id) {
    const slash = typeof id === 'string' ? id.indexOf('/') : -1;
    const apiId = slash > 0 ? id.slice(0, slash) : '';
    const name = slash > 0 ? id.slice(slash + 1) : '';
    if (!Object.hasOwn(PRESET_APIS, apiId) || !name || name.includes('/') || /[\\:*?"<>|\u0000-\u001f]/.test(name) || name === '.' || name === '..') {
        throw new ProtocolError(ERR.BAD_REQUEST, `Invalid preset id: ${id}`);
    }
    return { apiId, name };
}

export const presetId = (apiId, name) => `${apiId}/${name}`;

/**
 * Character card as read from a tavern (live or offline): the JSON stored in the PNG, without the tavern's
 * `json_data` copy, with `avatar` set to the card's file name. Cards made elsewhere often store `avatar: "none"`;
 * the tavern replaces it with the file name on its first save (merge-attributes locates the card by `avatar`), so
 * reading it this way from the start keeps a fresh checkout equal to what the first sync stores.
 */
export function canonicalCharacter(card, avatar) {
    const out = { ...card, avatar };
    delete out.json_data;
    return out;
}

export const MSG = Object.freeze({
    HELLO: 'hello',
    RESPONSE: 'response',
    CATALOG_LIST: 'catalog.list',
    ITEM_GET: 'item.get',
    ITEM_PUT: 'item.put',
    /** Creates an item that does not exist in the tavern yet; Cellar Link declares it as `capabilities.create`. */
    ITEM_CREATE: 'item.create',
    WATCH_SET: 'watch.set',
    PING: 'ping',
    ASSET_GET: 'asset.get',
    PROMPT_PREVIEW: 'prompt.preview',
    ITEM_CHANGED: 'item.changed',
});

/** Version of `item.create` a Cellar Link declares in `hello.capabilities.create` (absent: not supported). */
export const CREATE_VERSION = 1;

/** Validates an `item.create` name: a character / lorebook / preset name that can be a file name. */
export function assertNewItemName(name) {
    if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 200 || /[\\/:*?"<>|\u0000-\u001f]/.test(name) || name === '.' || name === '..') {
        throw new ProtocolError(ERR.BAD_REQUEST, `名称不能为空，也不能包含 \\ / : * ? " < > |：${name}`);
    }
}

/** Version of `prompt.preview` a Cellar Link declares in `hello.capabilities.preview` (absent: not supported). */
export const PREVIEW_VERSION = 1;
/** Longest test input `prompt.preview` accepts, in characters. */
export const PREVIEW_INPUT_MAX = 8000;
/** A dry run may tokenize a long chat: the companion waits this long for `prompt.preview`. */
export const PREVIEW_TIMEOUT_MS = 120000;

/** Validates a `prompt.preview` payload: `{ input? }`, input a string of at most PREVIEW_INPUT_MAX characters. */
export function assertPreviewRequest(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ProtocolError(ERR.BAD_REQUEST, 'Missing payload');
    const extra = Object.keys(payload).filter(k => k !== 'input');
    if (extra.length) throw new ProtocolError(ERR.BAD_REQUEST, `Unknown preview options: ${extra.join(', ')}`);
    if (payload.input !== undefined && typeof payload.input !== 'string') throw new ProtocolError(ERR.BAD_REQUEST, 'input must be a string');
    if ((payload.input ?? '').length > PREVIEW_INPUT_MAX) throw new ProtocolError(ERR.BAD_REQUEST, `input is longer than ${PREVIEW_INPUT_MAX} characters`);
}

/** Asset types `asset.get` serves (only character avatar thumbnails for now). */
export const ASSET_TYPES = Object.freeze(['avatar']);
/** Largest asset `asset.get` returns, in bytes (before base64). */
export const ASSET_MAX_BYTES = 512 * 1024;

/** Validates an `asset.get` payload: a known type and an id that names one file (no path parts). */
export function assertAssetRef(payload) {
    if (!payload || typeof payload !== 'object') throw new ProtocolError(ERR.BAD_REQUEST, 'Missing payload');
    if (!ASSET_TYPES.includes(payload.type)) throw new ProtocolError(ERR.BAD_REQUEST, `Unknown asset type: ${payload.type}`);
    const id = payload.id;
    if (typeof id !== 'string' || !id || id === '.' || id === '..' || /[\\/:*?"<>|\u0000-\u001f]/.test(id)) {
        throw new ProtocolError(ERR.BAD_REQUEST, `Invalid asset id: ${id}`);
    }
}

export const ERR = Object.freeze({
    UNAUTHORIZED: 'unauthorized',
    PROTOCOL_MISMATCH: 'protocol_mismatch',
    BAD_REQUEST: 'bad_request',
    NOT_FOUND: 'not_found',
    CONFLICT: 'conflict',
    HOST_ERROR: 'host_error',
    TIMEOUT: 'timeout',
    NOT_CONNECTED: 'not_connected',
    TAVERN_DISABLED: 'tavern_disabled',
    /** Offline write refused: the tavern is (or may be) running, so its own cache could overwrite the file. */
    TAVERN_RUNNING: 'tavern_running',
    /** The tavern is not running and its offline mode is "wait until it starts". */
    WAITING_FOR_TAVERN: 'waiting_for_tavern',
    /** Prompt preview: the tavern has no character or group chat open. */
    NO_CHAT: 'no_chat',
    /** Prompt preview: another preview or a generation is running in the tavern. */
    BUSY: 'busy',
});

export const CLOSE = Object.freeze({
    PROTOCOL_MISMATCH: 4400,
    UNAUTHORIZED: 4401,
    TAVERN_DISABLED: 4403,
    HELLO_TIMEOUT: 4408,
    REPLACED: 4409,
});

/** Close codes after which Cellar Link must not reconnect automatically. */
export const TERMINAL_CLOSE_CODES = Object.freeze([CLOSE.PROTOCOL_MISMATCH, CLOSE.UNAUTHORIZED, CLOSE.REPLACED]);

/** Host types a Cellar Link can identify as. */
export const TAVERN_HOSTS = Object.freeze(['st', 'tt']);

export class ProtocolError extends Error {
    /**
     * @param {string} code one of ERR
     * @param {string} message
     * @param {object} [details]
     */
    constructor(code, message, details) {
        super(message);
        this.name = 'ProtocolError';
        this.code = code;
        this.details = details;
    }
}

export function request(id, type, payload = {}) {
    return { v: PROTOCOL_VERSION, id, type, payload };
}

export function event(type, payload = {}) {
    return { v: PROTOCOL_VERSION, type, payload };
}

export function okResponse(id, payload = {}) {
    return { v: PROTOCOL_VERSION, id, type: MSG.RESPONSE, ok: true, payload };
}

export function errorResponse(id, error) {
    const code = error instanceof ProtocolError ? error.code : ERR.HOST_ERROR;
    const body = { code, message: String(error?.message ?? error) };
    if (error instanceof ProtocolError && error.details !== undefined) {
        body.details = error.details;
    }
    return { v: PROTOCOL_VERSION, id, type: MSG.RESPONSE, ok: false, error: body };
}

/**
 * Parses and validates one incoming frame.
 * @param {string} text
 * @returns {{v:number,id?:string,type:string,payload?:any,ok?:boolean,error?:any}}
 */
export function parseMessage(text) {
    let msg;
    try {
        msg = JSON.parse(text);
    } catch {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Frame is not valid JSON');
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Frame must be a JSON object');
    }
    if (msg.v !== PROTOCOL_VERSION) {
        throw new ProtocolError(ERR.PROTOCOL_MISMATCH, `Unsupported protocol version: ${msg.v}`);
    }
    if (typeof msg.type !== 'string' || !msg.type) {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Frame has no type');
    }
    if (msg.id !== undefined && (typeof msg.id !== 'string' || !msg.id)) {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Frame id must be a non-empty string');
    }
    if (msg.type === MSG.RESPONSE && (msg.id === undefined || typeof msg.ok !== 'boolean')) {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Response must carry id and ok');
    }
    return msg;
}

export function assertKind(kind) {
    if (!KINDS.includes(kind)) {
        throw new ProtocolError(ERR.BAD_REQUEST, `Unknown kind: ${kind}`);
    }
}

export function assertItemRef(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Missing payload');
    }
    assertKind(payload.kind);
    if (typeof payload.id !== 'string' || !payload.id) {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Item id must be a non-empty string');
    }
    if (payload.kind === 'preset') parsePresetId(payload.id);
}

/**
 * Origins allowed to open the Link WebSocket (in addition to user-configured ones).
 * Loopback pages (ST) and TauriTavern WebView origins. Browsers always send a truthful Origin on
 * WebSocket upgrades, so this is what keeps arbitrary websites out; there is no pairing token.
 */
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/,
    /^https?:\/\/tauri\.localhost$/,
    /^tauri:\/\/localhost$/,
]);

/** A Link upgrade must come from a browser page (Origin present) whose origin is allowed. */
export function isAllowedOrigin(origin, extra = []) {
    if (!origin) return false;
    if (DEFAULT_ALLOWED_ORIGINS.some(re => re.test(origin))) return true;
    return extra.includes(origin);
}

/**
 * Rejects requests whose Host header is not the companion's own loopback address
 * (defends against DNS rebinding, where a website's hostname resolves to 127.0.0.1).
 */
export function isLoopbackHost(host, port) {
    if (typeof host !== 'string') return false;
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}
