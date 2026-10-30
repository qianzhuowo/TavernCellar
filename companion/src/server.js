/**
 * HTTP + WebSocket server. /link is the Cellar Link WebSocket; /api/* is the control API (CLI, future editor).
 * Listens on 127.0.0.1 only. See docs/protocol.md.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
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
import { detectTtDataRoot, resolveLocations } from './taverns/locations.js';
import { OfflineLink } from './taverns/offline.js';

export const SERVER_NAME = 'TavernCellar';
export const SERVER_VERSION = '0.1.0';

function tokenMatches(expected, given) {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
}

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

    /** Sends a request to the plugin and resolves with its response payload. */
    request(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
        if (!this.target) return Promise.reject(new ProtocolError(ERR.NOT_CONNECTED, 'Link not ready'));
        const id = `s${++this.seq}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ProtocolError(ERR.TIMEOUT, `${type} timed out`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.send(request(id, type, payload));
        });
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
        this.target = { id: t.id, host: t.host, label: String(t.label ?? t.host).slice(0, 120), hostVersion: String(t.hostVersion ?? ''), origin: this.origin };
        this.send(okResponse(msg.id, { server: { name: SERVER_NAME, version: SERVER_VERSION, protocol: PROTOCOL_VERSION } }));
        try {
            await this.onReady(this, p.capabilities ?? {});
        } catch (error) {
            this.log(`link ready handling failed: ${error.message}`);
        }
    }

    #onSocketClose() {
        clearTimeout(this.helloTimer);
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
    [ERR.NOT_CONNECTED]: 503, [ERR.TIMEOUT]: 504, [ERR.HOST_ERROR]: 502, [ERR.TAVERN_RUNNING]: 423,
};

/** Validates a locations object from the API: { st: [{dir, user?}], tt: [{install?, data}] }. */
function normalizeLocations(body) {
    const str = v => (typeof v === 'string' ? v.trim() : '');
    const list = (value, host) => {
        if (value === undefined) return [];
        if (!Array.isArray(value)) throw new ProtocolError(ERR.BAD_REQUEST, `${host} must be an array`);
        return value;
    };
    const st = list(body.st, 'st').map(e => {
        const dir = str(e?.dir);
        if (!dir) throw new ProtocolError(ERR.BAD_REQUEST, 'st[].dir is required');
        const user = str(e?.user);
        return user ? { dir, user } : { dir };
    });
    const tt = list(body.tt, 'tt').map(e => {
        const data = str(e?.data);
        if (!data) throw new ProtocolError(ERR.BAD_REQUEST, 'tt[].data is required');
        return { install: str(e?.install), data };
    });
    return { st, tt };
}

/**
 * @param {{config: {port:number, token:string, allowOrigins:string[], taverns:{st:boolean, tt:boolean}, stPorts?:number[], stDir?:string|null}, workspace: import('./workspace/workspace.js').Workspace, log?: Function, watch?: boolean, persistConfig?: (config: object) => Promise<void>}} options
 */
export async function startServer({ config, workspace, log = console.log, watch = true, persistConfig = saveConfig }) {
    const targets = new TargetRegistry();
    const engine = new SyncEngine({ workspace, targets, log });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
    let port = config.port;

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

    const routes = {
        'GET /api/status': async () => { await refreshOffline(); return { ...await engine.status(), taverns: config.taverns }; },
        'GET /api/detect': async () => {
            await refreshOffline();
            return detectTaverns({ config, connected: connectedTargets(), offline: targets.listOffline() });
        },
        'POST /api/taverns': b => setTaverns(b),
        'GET /api/taverns/locations': async () => ({ locations: config.locations, resolved: await resolveLocations(config.locations), detectedTtDataRoot: await detectTtDataRoot() }),
        'POST /api/taverns/locations': b => setLocations(b),
        'POST /api/catalog': b => engine.catalog(b.target, b),
        'POST /api/checkout': b => engine.checkout(b.target, b),
        'POST /api/sync': b => engine.sync(b.path, b),
        'POST /api/pull': b => engine.pull(b.path, b),
        'POST /api/auto-sync': b => engine.setAutoSync(b.path, b),
    };

    const server = createServer(async (req, res) => {
        const send = (status, body) => {
            res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        try {
            if (!isLoopbackHost(req.headers.host, port)) throw new ProtocolError(ERR.UNAUTHORIZED, 'Unexpected Host header');
            // Control API is for local non-browser clients only (CLI, Studio main process); no CORS by design.
            // The bearer token is read from the local config file by those clients; it is never shown to users.
            if (req.headers.origin) throw new ProtocolError(ERR.UNAUTHORIZED, 'Browser origins may not use the control API');
            const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
            if (!tokenMatches(config.token, auth)) throw new ProtocolError(ERR.UNAUTHORIZED, 'Missing or wrong token');
            const path = new URL(req.url, 'http://127.0.0.1').pathname;
            const handler = routes[`${req.method} ${path}`];
            if (!handler) throw new ProtocolError(ERR.NOT_FOUND, `No route ${req.method} ${path}`);
            const body = req.method === 'POST' ? await readJsonBody(req) : {};
            send(200, { ok: true, result: await handler(body) });
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
                    await engine.onTargetConnected(link.target, capabilities, link);
                },
                onClose: link => {
                    if (!link.target) return;
                    targets.remove(link.target.id, link);
                    log(`tavern disconnected: ${link.target.label}`);
                },
                onEvent: async (link, msg) => {
                    if (msg.type === MSG.ITEM_CHANGED) await engine.onItemChanged(link.target.id, msg.payload ?? {});
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
    const stopWatching = watch ? watchWorkspace(workspace, path => engine.onFilesChanged(path), log) : () => {};
    log(`TavernCellar listening on 127.0.0.1:${server.address().port}, workspace ${workspace.root}`);

    return {
        engine,
        targets,
        port: server.address().port,
        async close() {
            stopWatching();
            for (const client of wss.clients) client.terminate();
            await new Promise(resolve => server.close(() => resolve()));
        },
    };
}
