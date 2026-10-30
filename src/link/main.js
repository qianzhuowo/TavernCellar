/** Cellar Link entry: settings panel, connection lifecycle. */
import { DEFAULT_PORT, LINK_PATH } from '../../shared/protocol.js';
import { LinkClient, STATUS } from './connection.js';
import { Host } from './host.js';

const SETTINGS_KEY = 'tavernCellar';
const DEFAULT_URL = `ws://127.0.0.1:${DEFAULT_PORT}${LINK_PATH}`;

const ctx = () => SillyTavern.getContext();

function detectHost() {
    const isTauri = typeof window.__TAURI_INTERNALS__ !== 'undefined'
        || location.protocol === 'tauri:'
        || location.hostname === 'tauri.localhost';
    return isTauri ? 'tt' : 'st';
}

function randomId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function getSettings() {
    const all = ctx().extensionSettings;
    all[SETTINGS_KEY] ??= {};
    const s = all[SETTINGS_KEY];
    let changed = false;
    const init = (key, value) => { if (s[key] === undefined) { s[key] = value; changed = true; } };
    // Settings from versions that used a pairing token: the token is gone and connecting is on by default now.
    if ('token' in s) { delete s.token; s.enabled = true; changed = true; }
    init('enabled', true);
    init('url', DEFAULT_URL);
    init('label', detectHost() === 'tt' ? 'TauriTavern' : 'SillyTavern');
    init('targetId', randomId());
    if (changed) ctx().saveSettingsDebounced();
    return s;
}

const STATUS_TEXT = {
    [STATUS.IDLE]: '未启用',
    [STATUS.CONNECTING]: '正在连接…',
    [STATUS.CONNECTED]: '已连接',
    [STATUS.WAITING]: '等待伴侣程序',
    [STATUS.REFUSED]: '伴侣程序未接受本酒馆',
    [STATUS.STOPPED]: '已停止',
};

function renderPanel() {
    const html = `
<div class="tavern-cellar-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Cellar Link</b>
      <span class="tavern-cellar-dot" data-status="idle" title=""></span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <small>自动连接本机的 TavernCellar 伴侣程序（运行 <code>cellar serve</code>），在外部编辑器中编辑角色卡与世界书。无需令牌。</small>
      <label class="checkbox_label"><input type="checkbox" id="tavern_cellar_enabled"><span>自动连接</span></label>
      <label for="tavern_cellar_url">伴侣程序地址</label>
      <input id="tavern_cellar_url" class="text_pole" type="text" spellcheck="false">
      <label for="tavern_cellar_label">本酒馆名称</label>
      <input id="tavern_cellar_label" class="text_pole" type="text">
      <div class="tavern-cellar-status-row">
        <span id="tavern_cellar_status_text"></span>
        <div id="tavern_cellar_reconnect" class="menu_button menu_button_icon"><i class="fa-solid fa-rotate"></i><span>重新连接</span></div>
      </div>
      <small class="tavern-cellar-muted">酒馆标识：<code id="tavern_cellar_target_id"></code></small>
    </div>
  </div>
</div>`;
    const container = document.getElementById('extensions_settings2') ?? document.getElementById('extensions_settings');
    container?.insertAdjacentHTML('beforeend', html);
}

export function init() {
    const settings = getSettings();
    const host = detectHost();
    renderPanel();

    const $status = $('#tavern_cellar_status_text');
    const $dot = $('.tavern-cellar-settings .tavern-cellar-dot');

    let hostAdapter;
    const client = new LinkClient({
        getHello: () => ({
            url: settings.url || DEFAULT_URL,
            target: { id: settings.targetId, host, label: settings.label || host, hostVersion: '' },
            capabilities: hostAdapter.capabilities(),
        }),
        onRequest: (type, payload) => hostAdapter.handle(type, payload),
        onStatus: (status, detail) => {
            const text = STATUS_TEXT[status] ?? status;
            $status.text(detail ? `${text}（${detail}）` : text);
            $dot.attr('data-status', status).attr('title', text);
        },
    });
    hostAdapter = new Host(client);
    hostAdapter.attachEvents();

    $('#tavern_cellar_enabled').prop('checked', settings.enabled).on('change', function () {
        settings.enabled = this.checked;
        ctx().saveSettingsDebounced();
        settings.enabled ? client.restart() : client.stop();
    });
    const bindText = (selector, key) => {
        $(selector).val(settings[key]).on('change', function () {
            settings[key] = String($(this).val()).trim();
            ctx().saveSettingsDebounced();
            if (settings.enabled) client.restart();
        });
    };
    bindText('#tavern_cellar_url', 'url');
    bindText('#tavern_cellar_label', 'label');
    $('#tavern_cellar_target_id').text(settings.targetId);
    $('#tavern_cellar_reconnect').on('click', () => {
        if (!settings.enabled) {
            settings.enabled = true;
            $('#tavern_cellar_enabled').prop('checked', true);
            ctx().saveSettingsDebounced();
        }
        client.restart();
    });

    if (settings.enabled) client.start();
    else client.stop();

    // Retry right away when the user comes back to the tavern (e.g. after starting `cellar serve`).
    const retrySoon = () => { if (settings.enabled && document.visibilityState === 'visible') client.retryNow(); };
    window.addEventListener('focus', retrySoon);
    document.addEventListener('visibilitychange', retrySoon);

    // Exposed for diagnostics from the devtools console.
    globalThis.TavernCellarLink = { client, host: hostAdapter, settings };
}
