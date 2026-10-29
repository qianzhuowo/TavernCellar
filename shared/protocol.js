/**
 * Cellar protocol v1 — see docs/protocol.md.
 * Pure ESM, no dependencies: imported by Cellar Link (browser) and the companion (Node).
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7349;
export const LINK_PATH = '/link';
export const HELLO_TIMEOUT_MS = 5000;
export const REQUEST_TIMEOUT_MS = 30000;

export const KINDS = Object.freeze(['character', 'lorebook']);

export const MSG = Object.freeze({
    HELLO: 'hello',
    RESPONSE: 'response',
    CATALOG_LIST: 'catalog.list',
    ITEM_GET: 'item.get',
    ITEM_PUT: 'item.put',
    WATCH_SET: 'watch.set',
    PING: 'ping',
    ITEM_CHANGED: 'item.changed',
});

export const ERR = Object.freeze({
    UNAUTHORIZED: 'unauthorized',
    PROTOCOL_MISMATCH: 'protocol_mismatch',
    BAD_REQUEST: 'bad_request',
    NOT_FOUND: 'not_found',
    CONFLICT: 'conflict',
    HOST_ERROR: 'host_error',
    TIMEOUT: 'timeout',
    NOT_CONNECTED: 'not_connected',
});

export const CLOSE = Object.freeze({
    PROTOCOL_MISMATCH: 4400,
    UNAUTHORIZED: 4401,
    HELLO_TIMEOUT: 4408,
    REPLACED: 4409,
});

/** Close codes after which Cellar Link must not reconnect automatically. */
export const TERMINAL_CLOSE_CODES = Object.freeze([CLOSE.PROTOCOL_MISMATCH, CLOSE.UNAUTHORIZED, CLOSE.REPLACED]);

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
}

/**
 * Origins allowed to open the Link WebSocket (in addition to user-configured ones).
 * Loopback pages (ST) and TauriTavern WebView origins.
 */
export const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/,
    /^https?:\/\/tauri\.localhost$/,
    /^tauri:\/\/localhost$/,
]);

export function isAllowedOrigin(origin, extra = []) {
    if (!origin) return true; // non-browser clients; the token still gates access
    if (DEFAULT_ALLOWED_ORIGINS.some(re => re.test(origin))) return true;
    return extra.includes(origin);
}
