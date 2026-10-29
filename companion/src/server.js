/**
 * HTTP + WebSocket server. /link is the Cellar Link WebSocket; /api/* is the control API (CLI, future editor).
 * Listens on 127.0.0.1 only. See docs/protocol.md.
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import {
    CLOSE, ERR, HELLO_TIMEOUT_MS, LINK_PATH, MSG, PROTOCOL_VERSION, ProtocolError, REQUEST_TIMEOUT_MS,
    errorResponse, isAllowedOrigin, okResponse, parseMessage, request,
} from '../../shared/protocol.js';
import { TargetRegistry } from './targets.js';
import { SyncEngine } from './sync.js';
import { watchWorkspace } from './watch.js';

export const SERVER_NAME = 'TavernCellar';
export const SERVER_VERSION = '0.1.0';

function tokenMatches(expected, given) {
    if (typeof given !== 'string') return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(given);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** One Cellar Link WebSocket connection. */
class LinkConnection {
    constructor(socket, { token, onReady, onClose, onEvent, log }) {
        this.socket = socket;
        this.token = token;
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
        if (!tokenMatches(this.token, p.token)) {
            this.send(errorResponse(msg.id, new ProtocolError(ERR.UNAUTHORIZED, 'Pairing token rejected')));
            this.close(CLOSE.UNAUTHORIZED, 'unauthorized');
            return;
        }
        const t = p.target ?? {};
        if (typeof t.id !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(t.id) || !['st', 'tt'].includes(t.host)) {
            this.send(errorResponse(msg.id, new ProtocolError(ERR.BAD_REQUEST, 'Invalid target descriptor')));
            this.close(CLOSE.UNAUTHORIZED, 'bad target');
            return;
        }
        this.target = { id: t.id, host: t.host, label: String(t.label ?? t.host).slice(0, 120), hostVersion: String(t.hostVersion ?? '') };
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
    [ERR.BAD_REQUEST]: 400, [ERR.UNAUTHORIZED]: 401, [ERR.NOT_FOUND]: 404, [ERR.CONFLICT]: 409,
    [ERR.NOT_CONNECTED]: 503, [ERR.TIMEOUT]: 504, [ERR.HOST_ERROR]: 502,
};

/**
 * @param {{config: {port:number, token:string, allowOrigins:string[]}, workspace: import('./workspace/workspace.js').Workspace, log?: Function, watch?: boolean}} options
 */
export async function startServer({ config, workspace, log = console.log, watch = true }) {
    const targets = new TargetRegistry();
    const engine = new SyncEngine({ workspace, targets, log });
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

    const routes = {
        'GET /api/status': () => engine.status(),
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
            // Control API is for local non-browser clients only (CLI, editor extension); no CORS by design.
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
        if (path !== LINK_PATH || !isAllowedOrigin(req.headers.origin, config.allowOrigins)) {
            log(`rejected upgrade: path=${path} origin=${req.headers.origin ?? '-'}`);
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => {
            new LinkConnection(ws, {
                token: config.token,
                log,
                onReady: async (link, capabilities) => {
                    const previous = targets.add(link.target, link);
                    if (previous) previous.link.close(CLOSE.REPLACED, 'replaced by a newer connection');
                    log(`tavern connected: ${link.target.label} [${link.target.host} ${link.target.hostVersion}] id=${link.target.id}`);
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
