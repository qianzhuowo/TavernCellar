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
    STOPPED: 'stopped',   // terminal error; needs user action
});

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

export class LinkClient {
    /**
     * @param {object} options
     * @param {() => {url: string, token: string, target: object, capabilities: object}} options.getHello
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
        if (socket) socket.close(1000, 'stopped');
        this.onStatus(STATUS.IDLE);
    }

    restart() {
        this.stop();
        this.start();
    }

    /** Sends an event; silently dropped when not connected (the companion re-reads state on reconnect). */
    emit(type, payload) {
        if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(event(type, payload)));
    }

    #connect() {
        clearTimeout(this.retryTimer);
        const hello = this.getHello();
        if (!hello.token) {
            this.onStatus(STATUS.STOPPED, '未填写配对令牌');
            return;
        }
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
                token: hello.token,
                target: hello.target,
                capabilities: hello.capabilities,
            })));
        });

        socket.addEventListener('message', ev => this.#onMessage(socket, ev.data));

        socket.addEventListener('close', ev => {
            if (this.socket !== socket) return; // superseded
            this.socket = null;
            this.ready = false;
            if (!this.wanted) return;
            if (TERMINAL_CLOSE_CODES.includes(ev.code)) {
                const reason = {
                    [CLOSE.UNAUTHORIZED]: '配对令牌被拒绝',
                    [CLOSE.PROTOCOL_MISMATCH]: '协议版本不一致，请更新插件或伴侣程序',
                    [CLOSE.REPLACED]: '同一酒馆在别处建立了新连接',
                }[ev.code];
                this.onStatus(STATUS.STOPPED, reason ?? ev.reason);
                return;
            }
            const delay = this.backoff;
            this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
            this.onStatus(STATUS.WAITING, `${Math.round(delay / 1000)} 秒后重试`);
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
            reply = okResponse(msg.id, await this.onRequest(msg.type, msg.payload ?? {}));
        } catch (error) {
            if (!(error instanceof ProtocolError)) console.error('[Cellar Link] request failed', msg.type, error);
            reply = errorResponse(msg.id, error);
        }
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(reply));
    }
}
