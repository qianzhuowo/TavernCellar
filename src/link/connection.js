/**
 * Cellar Link WebSocket client: hello handshake, request dispatch, reconnect with backoff.
 * See docs/protocol.md §2–3.
 */
import {
    MSG, PROTOCOL_VERSION, TERMINAL_CLOSE_CODES, CLOSE, ERR, ProtocolError,
    request, event, okResponse, errorResponse, parseMessage,
} from '../../shared/protocol.js';

export const STATUS = Object.freeze({
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    WAITING: 'waiting',   // disconnected, will retry
    REFUSED: 'refused',   // companion turned this tavern type off; retries slowly so re-enabling reconnects
    STOPPED: 'stopped',   // terminal error; needs user action
});

const MIN_BACKOFF_MS = 5000;
const MAX_BACKOFF_MS = 60000;
const KEEPALIVE_LOCK = 'tavern-cellar-link';

/**
 * Holding a Web Lock exempts the tab from background freezing (Chrome/Edge "sleeping tabs", energy saver).
 * A frozen tab keeps its WebSocket open but runs no JavaScript, so every companion request would time out.
 */
class KeepAlive {
    #release = null;

    hold() {
        if (this.#release || !navigator.locks?.request) return;
        navigator.locks.request(KEEPALIVE_LOCK, { mode: 'shared' }, () => new Promise(resolve => { this.#release = resolve; }))
            .catch(error => console.warn('[Cellar Link] keep-alive lock unavailable', error));
    }

    release() {
        this.#release?.();
        this.#release = null;
    }
}

export class LinkClient {
    /**
     * @param {object} options
     * @param {() => {url: string, target: object, capabilities: object}} options.getHello
     * @param {(type: string, payload: any) => Promise<any>} options.onRequest
     * @param {(status: string, detail?: string) => void} options.onStatus
     * @param {() => void} [options.onReady]
     */
    constructor({ getHello, onRequest, onStatus, onReady }) {
        this.getHello = getHello;
        this.onRequest = onRequest;
        this.onStatus = onStatus;
        this.onReady = onReady ?? (() => {});
        this.socket = null;
        this.ready = false;
        this.wanted = false;
        this.backoff = MIN_BACKOFF_MS;
        this.retryTimer = null;
        this.server = null;
        this.keepAlive = new KeepAlive();
    }

    start() {
        this.wanted = true;
        this.backoff = MIN_BACKOFF_MS;
        this.#connect();
    }

    stop() {
        this.wanted = false;
        clearTimeout(this.retryTimer);
        const socket = this.socket;
        this.socket = null;
        this.ready = false;
        this.keepAlive.release();
        if (socket) socket.close(1000, 'stopped');
        this.onStatus(STATUS.IDLE);
    }

    restart() {
        this.stop();
        this.start();
    }

    /** Skips the remaining backoff when waiting for the companion (e.g. the tab regained focus). */
    retryNow() {
        if (!this.wanted || this.socket || !this.retryTimer) return;
        this.backoff = MIN_BACKOFF_MS;
        this.#connect();
    }

    /** Sends an event; silently dropped when not connected (the companion re-reads state on reconnect). */
    emit(type, payload) {
        if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event(type, payload)));
    }

    #connect() {
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        const hello = this.getHello();
        this.onStatus(STATUS.CONNECTING, hello.url);
        let socket;
        try {
            socket = new WebSocket(hello.url);
        } catch (error) {
            this.onStatus(STATUS.STOPPED, `地址无效：${error.message}`);
            return;
        }
        this.socket = socket;
        this.ready = false;

        socket.addEventListener('open', () => {
            socket.send(JSON.stringify(request('hello', MSG.HELLO, {
                protocol: PROTOCOL_VERSION,
                target: hello.target,
                capabilities: hello.capabilities,
            })));
        });

        socket.addEventListener('message', ev => this.#onMessage(socket, ev.data));

        socket.addEventListener('close', ev => {
            if (this.socket !== socket) return; // superseded
            this.socket = null;
            this.ready = false;
            this.keepAlive.release();
            if (!this.wanted) return;
            if (TERMINAL_CLOSE_CODES.includes(ev.code)) {
                const reason = {
                    [CLOSE.UNAUTHORIZED]: '握手被拒绝',
                    [CLOSE.PROTOCOL_MISMATCH]: '协议版本不一致，请更新插件或伴侣程序',
                    [CLOSE.REPLACED]: '同一酒馆在别处建立了新连接',
                }[ev.code];
                this.onStatus(STATUS.STOPPED, reason ?? ev.reason);
                return;
            }
            if (ev.code === CLOSE.TAVERN_DISABLED) {
                this.backoff = MAX_BACKOFF_MS;
                this.onStatus(STATUS.REFUSED, '在伴侣程序中运行 cellar use all 可重新接受');
            } else {
                this.onStatus(STATUS.WAITING, `${Math.round(this.backoff / 1000)} 秒后重试`);
            }
            const delay = this.backoff;
            this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
            this.retryTimer = setTimeout(() => this.#connect(), delay);
        });
    }

    async #onMessage(socket, raw) {
        let msg;
        try {
            msg = parseMessage(String(raw));
        } catch (error) {
            console.warn('[Cellar Link] bad frame', error);
            return;
        }

        if (msg.type === MSG.RESPONSE) {
            if (msg.id !== 'hello') return;
            if (msg.ok) {
                this.ready = true;
                this.backoff = MIN_BACKOFF_MS;
                this.server = msg.payload?.server ?? null;
                this.keepAlive.hold();
                this.onStatus(STATUS.CONNECTED, this.server ? `${this.server.name} ${this.server.version}` : '');
                this.onReady();
            }
            // On failure the server closes with a terminal code; the close handler reports it.
            return;
        }

        if (!msg.id) return; // server sends no events in v1
        let reply;
        try {
            if (!this.ready) throw new ProtocolError(ERR.UNAUTHORIZED, 'Handshake not complete');
            // Heartbeat: answered here so the companion learns whether this page is actually running.
            reply = okResponse(msg.id, msg.type === MSG.PING ? {} : await this.onRequest(msg.type, msg.payload ?? {}));
        } catch (error) {
            if (!(error instanceof ProtocolError)) console.error('[Cellar Link] request failed', msg.type, error);
            reply = errorResponse(msg.id, error);
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
    }
}
