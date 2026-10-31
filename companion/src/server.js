/**
 * HTTP + WebSocket server. /link is the Cellar Link WebSocket; /api/* is the control API (CLI, future editor).
 * Listens on 127.0.0.1 only. See docs/protocol.md.
 */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
    CLOSE, ERR, HELLO_TIMEOUT_MS, LINK_PATH, MSG, PROTOCOL_VERSION, ProtocolError, REQUEST_TIMEOUT_MS, TAVERN_HOSTS,
    errorResponse, isAllowedOrigin, isLoopbackHost, okResponse, parseMessage, request,
} from '../../shared/protocol.js';
import { TargetRegistry } from './targets.js';
import { SyncEngine } from './sync.js';
import { watchWorkspace } from './watch.js';
import { detectTaverns } from './detect.js';
import { saveConfig } from './config.js';
import { Workspace } from './workspace/workspace.js';
import { OFFLINE_SYNC_MODES, detectTtDataRoot, offlineSyncMode, resolveLocations } from './taverns/locations.js';
import { OfflineLink } from './taverns/offline.js';

export const SERVER_NAME = 'TavernCellar';
export const SERVER_VERSION = '0.1.0';
export const STUDIO_PATH = '/studio/';

/** Folder served at /studio/: the built Studio UI when present, otherwise the prototype. */
export function defaultStudioDir() {
    const studio = fileURLToPath(new URL('../../studio/', import.meta.url));
    const built = join(studio, 'dist');
    return existsSync(join(built, 'index.html')) ? built : join(studio, 'prototype');
}

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json; charset=utf-8',
};

/** Static, read-only files for the Studio page. Returns false when the path is not a Studio path. */
async function serveStudio(req, res, pathname, studioDir, extraHeaders = {}) {
    if (pathname === '/' || pathname === '/studio') {
        res.writeHead(302, { Location: STUDIO_PATH });
        res.end();
        return true;
    }
    if (!pathname.startsWith(STUDIO_PATH)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end();
        return true;
    }
    let rel;
    try {
        rel = decodeURIComponent(pathname.slice(STUDIO_PATH.length)) || 'index.html';
    } catch {
        rel = '\0';
    }
    const root = resolve(studioDir);
    const file = resolve(root, rel);
    if (rel.includes('\0') || (file !== root && !file.startsWith(root + sep))) {
        res.writeHead(400);
        res.end();
        return true;
    }
    try {
        const body = await readFile(file);
        res.writeHead(200, {
            ...extraHeaders,
            'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'",
        });
        res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    }
    return true;
}

function tokenMatches(expected, given) {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
}

const SESSION_COOKIE = 'cellar_session';
export const EVENTS_PATH = '/studio/events';

function readCookie(req, name) {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === name) return v.join('=');
    }
    return undefined;
}

const UI_DEFAULTS = { theme: 'dark', density: 'comfortable', wizardDone: false };
const UI_RULES = { theme: ['dark', 'light'], density: ['comfortable', 'compact'], wizardDone: [true, false] };

/** Heartbeat: a frozen tavern tab keeps its socket open but runs no JavaScript, so only an app-level ping reveals it. */
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const UNRESPONSIVE_MESSAGE = '酒馆页面没有响应：可能被浏览器置于后台休眠。切换到酒馆页面后会自动恢复。';

/** One Cellar Link WebSocket connection. Admission is decided by Origin/Host at upgrade time (no pairing token). */
class LinkConnection {
    constructor(socket, { origin, isHostEnabled, onReady, onClose, onEvent, log }) {
        this.socket = socket;
        this.origin = origin;
        this.isHostEnabled = isHostEnabled;
        this.onReady = onReady;
        this.onClose = onClose;
        this.onEvent = onEvent;
        this.log = log;
        this.target = null;
        this.seq = 0;
        /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
        this.pending = new Map();
        this.heartbeat = null;
        this.helloTimer = setTimeout(() => this.close(CLOSE.HELLO_TIMEOUT, 'hello timeout'), HELLO_TIMEOUT_MS);
        socket.on('message', data => this.#onMessage(String(data)));
        socket.on('close', () => this.#onSocketClose());
        socket.on('error', error => this.log(`link socket error: ${error.message}`));
    }

    send(msg) {
        if (this.socket.readyState === this.socket.OPEN) this.socket.send(JSON.stringify(msg));
    }

    close(code, reason) {
        try { this.socket.close(code, reason); } catch { /* already closed */ }
    }

    /** Sends a request to the plugin and resolves with its response payload. Fails at once while the page is unresponsive. */
    request(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
        if (!this.target) return Promise.reject(new ProtocolError(ERR.NOT_CONNECTED, 'Link not ready'));
        if (type !== MSG.PING && this.target.responsive === false) return Promise.reject(new ProtocolError(ERR.TIMEOUT, UNRESPONSIVE_MESSAGE));
        const id = `s${++this.seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ProtocolError(ERR.TIMEOUT, type === MSG.PING ? `${type} timed out` : `${type} 超时：${UNRESPONSIVE_MESSAGE}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.send(request(id, type, payload));
        });
    }

    #startHeartbeat() {
        const beat = async () => {
            const ok = await this.request(MSG.PING, {}, HEARTBEAT_TIMEOUT_MS).then(() => true, () => false);
            if (!this.target || ok === this.target.responsive) return;
            this.target.responsive = ok;
            this.log(ok ? `tavern responsive again: ${this.target.label}` : `tavern not responding (tab asleep?): ${this.target.label}`);
        };
        this.heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    }

    async #onMessage(text) {
        let msg;
        try {
            msg = parseMessage(text);
        } catch (error) {
            this.log(`bad frame from link: ${error.message}`);
            if (error.code === ERR.PROTOCOL_MISMATCH) this.close(CLOSE.PROTOCOL_MISMATCH, 'protocol mismatch');
            return;
        }

        if (msg.type === MSG.RESPONSE) {
            const waiter = this.pending.get(msg.id);
            if (!waiter) return;
            this.pending.delete(msg.id);
            clearTimeout(waiter.timer);
            if (msg.ok) waiter.resolve(msg.payload ?? {});
            else waiter.reject(new ProtocolError(msg.error?.code ?? ERR.HOST_ERROR, msg.error?.message ?? 'Request failed', msg.error?.details));
            return;
        }

        if (!this.target) {
            if (msg.type !== MSG.HELLO || !msg.id) {
                this.close(CLOSE.UNAUTHORIZED, 'hello required');
                return;
            }
            await this.#onHello(msg);
            return;
        }

        if (msg.id) {
            this.send(errorResponse(msg.id, new ProtocolError(ERR.BAD_REQUEST, `Unsupported request: ${msg.type}`)));
            return;
        }
        try {
            await this.onEvent(this, msg);
        } catch (error) {
            this.log(`event ${msg.type} failed: ${error.message}`);
        }
    }

    async #onHello(msg) {
        clearTimeout(this.helloTimer);
        const p = msg.payload ?? {};
        if (p.protocol !== PROTOCOL_VERSION) {
            this.send(errorResponse(msg.id, new ProtocolError(ERR.PROTOCOL_MISMATCH, `Server speaks protocol ${PROTOCOL_VERSION}, link sent ${p.protocol}`)));
            this.close(CLOSE.PROTOCOL_MISMATCH, 'protocol mismatch');
            return;
        }
        const t = p.target ?? {};
        if (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(t.id) || !TAVERN_HOSTS.includes(t.host)) {
            this.send(errorResponse(msg.id, new ProtocolError(ERR.BAD_REQUEST, 'Invalid target descriptor')));
            this.close(CLOSE.UNAUTHORIZED, 'bad target');
            return;
        }
        if (!this.isHostEnabled(t.host)) {
            this.send(errorResponse(msg.id, new ProtocolError(ERR.TAVERN_DISABLED, `Connections from ${t.host} are turned off in the companion`)));
            this.close(CLOSE.TAVERN_DISABLED, 'tavern disabled');
            return;
        }
        this.target = { id: t.id, host: t.host, label: String(t.label ?? t.host).slice(0, 120), hostVersion: String(t.hostVersion ?? ''), origin: this.origin, responsive: true };
        this.send(okResponse(msg.id, { server: { name: SERVER_NAME, version: SERVER_VERSION, protocol: PROTOCOL_VERSION } }));
        this.#startHeartbeat();
        try {
            await this.onReady(this, p.capabilities ?? {});
        } catch (error) {
            this.log(`link ready handling failed: ${error.message}`);
        }
    }

    #onSocketClose() {
        clearTimeout(this.helloTimer);
        clearInterval(this.heartbeat);
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new ProtocolError(ERR.NOT_CONNECTED, 'Link closed'));
        }
        this.pending.clear();
        this.onClose(this);
    }
}

async function readJsonBody(req, limit = 32 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new ProtocolError(ERR.BAD_REQUEST, 'Request body too large');
        chunks.push(chunk);
    }
    if (!size) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new ProtocolError(ERR.BAD_REQUEST, 'Body is not valid JSON');
    }
}

const STATUS_BY_CODE = {
    [ERR.BAD_REQUEST]: 400, [ERR.UNAUTHORIZED]: 401, [ERR.TAVERN_DISABLED]: 403, [ERR.NOT_FOUND]: 404, [ERR.CONFLICT]: 409,
    [ERR.NOT_CONNECTED]: 503, [ERR.TIMEOUT]: 504, [ERR.HOST_ERROR]: 502, [ERR.TAVERN_RUNNING]: 423, [ERR.WAITING_FOR_TAVERN]: 423,
};

/** Validates a locations object from the API: { st: [{dir, user?, offlineSync?}], tt: [{install?, data, offlineSync?}] }. */
function normalizeLocations(body) {
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const list = (value, host) => {
        if (value === undefined) return [];
        if (!Array.isArray(value)) throw new ProtocolError(ERR.BAD_REQUEST, `${host} must be an array`);
        return value;
    };
    const mode = e => {
        if (e?.offlineSync === undefined) return {};
        if (!OFFLINE_SYNC_MODES.includes(e.offlineSync)) throw new ProtocolError(ERR.BAD_REQUEST, `offlineSync must be one of ${OFFLINE_SYNC_MODES.join(', ')}`);
        return e.offlineSync === 'write' ? { offlineSync: 'write' } : {}; // 'wait' is the default and not stored
    };
    const st = list(body.st, 'st').map(e => {
        const dir = str(e?.dir);
        if (!dir) throw new ProtocolError(ERR.BAD_REQUEST, 'st[].dir is required');
        const user = str(e?.user);
        return { ...(user ? { dir, user } : { dir }), ...mode(e) };
    });
    const tt = list(body.tt, 'tt').map(e => {
        const data = str(e?.data);
        if (!data) throw new ProtocolError(ERR.BAD_REQUEST, 'tt[].data is required');
        return { install: str(e?.install), data, ...mode(e) };
    });
    return { st, tt };
}

/**
 * @param {{config: {port:number, token:string, allowOrigins:string[], taverns:{st:boolean, tt:boolean}, stPorts?:number[], stDir?:string|null}, workspace: import('./workspace/workspace.js').Workspace, log?: Function, watch?: boolean, persistConfig?: (config: object) => Promise<void>}} options
 */
export async function startServer({ config, workspace, log: baseLog = console.log, watch = true, persistConfig = saveConfig, studioDir = defaultStudioDir() }) {
    /** Studio event stream clients (Server-Sent Events). */
    const eventClients = new Set();
    const emit = (event, data) => {
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of eventClients) res.write(frame);
    };
    // Every log line is shown in Studio and hints that status may have changed (Studio debounces and refetches).
    const log = line => {
        baseLog(line);
        emit('log', { at: new Date().toISOString(), line: String(line) });
        emit('status', { reason: 'log' });
    };
    /** Per-run secret handed to the Studio page as an HttpOnly cookie; users never see a token. */
    const sessionId = randomBytes(24).toString('hex');
    const targets = new TargetRegistry();
    const engine = new SyncEngine({ workspace, targets, log });
    await engine.upgradeLayouts();
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    let port = config.port;
    let stopWatching = () => {};

    const connectedTargets = () => [...wss.clients].map(ws => ws.cellarLink?.target).filter(Boolean);

    /** Rebuilds offline links from config.locations (only taverns that are accepted and have a Cellar Link target id). */
    async function refreshOffline() {
        const locations = await resolveLocations(config.locations);
        const seen = new Set();
        const links = [];
        for (const loc of locations) {
            if (loc.error || !loc.targetId || !config.taverns[loc.host] || seen.has(loc.targetId)) continue;
            seen.add(loc.targetId);
            links.push(new OfflineLink(loc, { backupDir: () => join(workspace.root, '.cellar', 'backups') }));
        }
        targets.setOffline(links);
        return locations;
    }

    async function setLocations(body) {
        config.locations = normalizeLocations(body);
        await persistConfig(config);
        const locations = await refreshOffline();
        log(`locations: ${locations.map(l => `${l.key}=${l.error ? `error(${l.error})` : l.userDir}`).join(', ') || 'none'}`);
        return { locations: config.locations, resolved: locations };
    }

    /** body: { key: 'st:0' | 'tt:0', mode: 'wait' | 'write' } */
    async function setOfflineSync({ key, mode } = {}) {
        const [host, index] = typeof key === 'string' ? key.split(':') : [];
        const entry = TAVERN_HOSTS.includes(host) ? config.locations[host]?.[Number(index)] : undefined;
        if (!entry || !/^\d+$/.test(index ?? '')) throw new ProtocolError(ERR.NOT_FOUND, `No tavern location ${key}`);
        const locations = structuredClone(config.locations);
        locations[host][Number(index)] = { ...entry, offlineSync: mode };
        const result = await setLocations(locations); // validates mode
        await engine.flushPending(); // switching to 'write' while the tavern is closed writes pending auto-sync items now
        log(`offline sync ${key}: ${offlineSyncMode(config.locations[host][Number(index)])}`);
        return result;
    }

    async function setTaverns(body) {
        const next = { ...config.taverns };
        for (const host of TAVERN_HOSTS) {
            if (body[host] === undefined) continue;
            if (typeof body[host] !== 'boolean') throw new ProtocolError(ERR.BAD_REQUEST, `${host} must be true or false`);
            next[host] = body[host];
        }
        config.taverns = next;
        await persistConfig(config);
        await refreshOffline();
        for (const ws of wss.clients) {
            const link = ws.cellarLink;
            if (link?.target && !next[link.target.host]) link.close(CLOSE.TAVERN_DISABLED, 'tavern disabled');
        }
        log(`taverns: st=${next.st ? 'on' : 'off'} tt=${next.tt ? 'on' : 'off'}`);
        return { taverns: next };
    }

    function settings() {
        return { port, workspace: workspace.root, ui: { ...UI_DEFAULTS, ...config.ui } };
    }

    async function setSettings(body) {
        const ui = { ...UI_DEFAULTS, ...config.ui };
        for (const [key, value] of Object.entries(body?.ui ?? {})) {
            if (!UI_RULES[key]?.includes(value)) throw new ProtocolError(ERR.BAD_REQUEST, `ui.${key} must be one of ${(UI_RULES[key] ?? []).join(', ') || '(unknown setting)'}`);
            ui[key] = value;
        }
        config.ui = ui;
        await persistConfig(config);
        return settings();
    }

    /** Switches the workspace in place (creating it when the folder is empty); taverns stay connected. */
    async function switchWorkspace({ dir } = {}) {
        if (typeof dir !== 'string' || !dir.trim()) throw new ProtocolError(ERR.BAD_REQUEST, 'dir is required');
        let next;
        try {
            next = await Workspace.init(resolve(dir.trim()));
        } catch (error) {
            throw new ProtocolError(ERR.BAD_REQUEST, `Cannot use ${dir} as a workspace: ${error.message}`);
        }
        stopWatching();
        workspace = next;
        engine.ws = next;
        engine.local.clear();
        stopWatching = startWatching();
        config.workspace = next.root;
        await persistConfig(config);
        for (const { id } of targets.list()) await engine.pushWatchList(id).catch(() => {});
        log(`workspace switched to ${next.root}`);
        return { workspace: next.root };
    }

    /** Control API access: CLI / desktop main process with the internal token (no Origin), or the Studio page (same origin + session cookie). */
    function authorize(req) {
        const origin = req.headers.origin;
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!origin && bearer !== undefined) {
            if (tokenMatches(config.token, bearer)) return;
            throw new ProtocolError(ERR.UNAUTHORIZED, 'Missing or wrong token');
        }
        if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
            throw new ProtocolError(ERR.UNAUTHORIZED, 'Browser origins may not use the control API');
        }
        const site = req.headers['sec-fetch-site'];
        if (site && site !== 'same-origin') throw new ProtocolError(ERR.UNAUTHORIZED, 'Cross-site request');
        if (!tokenMatches(sessionId, readCookie(req, SESSION_COOKIE))) throw new ProtocolError(ERR.UNAUTHORIZED, 'Missing or wrong token');
    }

    function openEventStream(req, res) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
        res.write(`retry: 2000\nevent: hello\ndata: ${JSON.stringify({ version: SERVER_VERSION })}\n\n`);
        eventClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); eventClients.delete(res); });
    }

    const routes = {
        'GET /api/settings': () => settings(),
        'PUT /api/settings': b => setSettings(b),
        'POST /api/workspace': b => switchWorkspace(b),
        'GET /api/items': async () => { await refreshOffline(); return { items: (await engine.status()).items }; },
        'GET /api/status': async () => { await refreshOffline(); return { ...await engine.status(), taverns: config.taverns }; },
        'GET /api/detect': async () => {
            await refreshOffline();
            return detectTaverns({ config, connected: connectedTargets(), offline: targets.listOffline() });
        },
        'POST /api/taverns': b => setTaverns(b),
        'GET /api/taverns/locations': async () => ({ locations: config.locations, resolved: await resolveLocations(config.locations), detectedTtDataRoot: await detectTtDataRoot() }),
        'POST /api/taverns/locations': b => setLocations(b),
        'POST /api/taverns/offline-sync': b => setOfflineSync(b),
        'POST /api/catalog': b => engine.catalog(b.target, b),
        'POST /api/checkout': b => engine.checkout(b.target, b),
        'POST /api/sync': b => engine.sync(b.path, b),
        'POST /api/pull': b => engine.pull(b.path, b),
        'POST /api/conflict': b => engine.conflictDetails(b.path, b),
            'POST /api/conflict/resolve': b => engine.resolveConflict(b.path, b),
            'POST /api/item': b => engine.readItemData(b.path),
            'PUT /api/item': b => engine.writeItemData(b.path, b),
            'POST /api/item/entries': b => engine.editEntries(b.path, b),
        'POST /api/auto-sync': b => engine.setAutoSync(b.path, b),
        'POST /api/unbind': b => engine.unbind(b.path, b),
        'POST /api/bind': b => engine.bind(b.path, b),
        'POST /api/layout': b => engine.setLayout(b.path, b),
    };

    const server = createServer(async (req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        try {
            if (!isLoopbackHost(req.headers.host, port)) throw new ProtocolError(ERR.UNAUTHORIZED, 'Unexpected Host header');
            const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
            if (pathname === EVENTS_PATH) {
                authorize(req);
                openEventStream(req, res);
                return;
            }
            // Studio page: static files only; it receives the session cookie, everything it shows comes through the API.
            const cookie = `${SESSION_COOKIE}=${sessionId}; HttpOnly; SameSite=Strict; Path=/`;
            if (await serveStudio(req, res, pathname, studioDir, { 'Set-Cookie': cookie })) return;
            // Control API: no CORS by design. See authorize().
            authorize(req);
            const path = pathname;
            const handler = routes[`${req.method} ${path}`];
            if (!handler) throw new ProtocolError(ERR.NOT_FOUND, `No route ${req.method} ${path}`);
            const body = req.method === 'POST' || req.method === 'PUT' ? await readJsonBody(req) : {};
            const result = await handler(body);
            send(200, { ok: true, result });
            if (req.method !== 'GET') emit('status', { reason: path });
        } catch (error) {
            const code = error instanceof ProtocolError ? error.code : ERR.HOST_ERROR;
            send(STATUS_BY_CODE[code] ?? 500, { ok: false, error: { code, message: error.message, details: error.details } });
        }
    });

    server.on('upgrade', (req, socket, head) => {
        const path = new URL(req.url, 'http://127.0.0.1').pathname;
        const origin = req.headers.origin;
        if (path !== LINK_PATH || !isLoopbackHost(req.headers.host, port) || !isAllowedOrigin(origin, config.allowOrigins)) {
            log(`rejected upgrade: path=${path} host=${req.headers.host ?? '-'} origin=${origin ?? '-'}`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
            ws.cellarLink = new LinkConnection(ws, {
                origin,
                isHostEnabled: host => config.taverns[host] === true,
                log,
                onReady: async (link, capabilities) => {
                    const previous = targets.add(link.target, link);
                    if (previous) previous.link.close(CLOSE.REPLACED, 'replaced by a newer connection');
                    log(`tavern connected: ${link.target.label} [${link.target.host} ${link.target.hostVersion}] id=${link.target.id} origin=${origin}`);
                    emit('target', { connected: true, target: link.target });
                    await engine.onTargetConnected(link.target, capabilities, link);
                },
                onClose: link => {
                    if (!link.target) return;
                    targets.remove(link.target.id, link);
                    log(`tavern disconnected: ${link.target.label}`);
                    emit('target', { connected: false, target: link.target });
                },
                onEvent: async (link, msg) => {
                    if (msg.type === MSG.ITEM_CHANGED) {
                        await engine.onItemChanged(link.target.id, msg.payload ?? {});
                        emit('status', { reason: 'tavern-changed', target: link.target.id });
                    }
                },
            });
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    port = server.address().port;
    await refreshOffline();
    const startWatching = () => (watch ? watchWorkspace(workspace, path => engine.onFilesChanged(path).finally(() => emit('status', { reason: 'files', path })), log) : () => {});
    stopWatching = startWatching();
    log(`TavernCellar listening on 127.0.0.1:${server.address().port}, workspace ${workspace.root}`);

    return {
        engine,
        targets,
        port: server.address().port,
        /** Session cookie value (tests / desktop shell). */
        sessionId,
        async close() {
            stopWatching();
            for (const res of eventClients) res.end();
            eventClients.clear();
            for (const client of wss.clients) client.terminate();
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
