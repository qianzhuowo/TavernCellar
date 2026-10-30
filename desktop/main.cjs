/**
 * Cellar Studio desktop shell (Electron main process).
 * Runs the companion in-process (startServer) and shows the Studio UI it serves at /studio/.
 * The UI talks to the companion over HTTP + SSE only; IPC is limited to three native helpers (see preload.cjs).
 * See docs/studio-design.md §2.
 */
// CommonJS on purpose: Electron 33's ESM main crashes on named imports from 'electron'.
// The companion is ESM and is loaded with import() in loadCompanion().
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const { appendFile, mkdir } = require('node:fs/promises');
const { homedir } = require('node:os');
const { isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const here = __dirname;
let STUDIO_PATH, startServer, cellarHome, loadConfig, saveConfig, Workspace;
async function loadCompanion() {
    const load = rel => import(pathToFileURL(join(here, '..', rel)).href);
    ({ STUDIO_PATH, startServer } = await load('companion/src/server.js'));
    ({ cellarHome, loadConfig, saveConfig } = await load('companion/src/config.js'));
    ({ Workspace } = await load('companion/src/workspace/workspace.js'));
}
const ICON = join(here, 'assets', 'icon.png');

/** @type {BrowserWindow|null} */ let win = null;
/** @type {Tray|null} */ let tray = null;
let server = null;
let studioUrl = '';
let quitting = false;
let trayHintShown = false;

const logFile = () => join(cellarHome(), 'studio.log');
function log(line) {
    const text = `[${new Date().toISOString()}] ${line}\n`;
    mkdir(cellarHome(), { recursive: true }).then(() => appendFile(logFile(), text)).catch(() => {});
}

/** True when a companion (e.g. `cellar serve`) already serves Studio on this port. */
async function companionAnswers(url) {
    try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

async function startCompanion() {
    const config = await loadConfig();
    studioUrl = `http://127.0.0.1:${config.port}${STUDIO_PATH}`;
    if (await companionAnswers(studioUrl)) {
        log(`a companion already runs on port ${config.port}; using it`);
        return;
    }
    const dir = config.workspace ?? join(homedir(), 'TavernCellar');
    const workspace = await Workspace.init(dir);
    if (!config.workspace) {
        config.workspace = workspace.root;
        await saveConfig(config);
    }
    try {
        server = await startServer({ config, workspace, log });
    } catch (error) {
        if (error.code === 'EADDRINUSE') {
            dialog.showErrorBox('Cellar Studio', `端口 ${config.port} 被其他程序占用，无法启动伴侣程序。\n请关闭占用该端口的程序，或在 ${join(cellarHome(), 'config.json')} 中修改 port。`);
        } else {
            dialog.showErrorBox('Cellar Studio', `伴侣程序启动失败：${error.message}`);
        }
        throw error;
    }
}

/** Only the Studio page served by our companion may call the native helpers. */
function fromStudio(event) {
    return typeof event.senderFrame?.url === 'string' && event.senderFrame.url.startsWith(studioUrl);
}

function registerIpc() {
    ipcMain.handle('cellar:pick-directory', async event => {
        if (!fromStudio(event)) return null;
        const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
        return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle('cellar:show-in-folder', (event, path) => {
        if (!fromStudio(event) || typeof path !== 'string' || !isAbsolute(path)) return false;
        shell.showItemInFolder(path);
        return true;
    });
    ipcMain.handle('cellar:open-in-editor', async (event, path) => {
        if (!fromStudio(event) || typeof path !== 'string' || !isAbsolute(path)) return false;
        return (await shell.openPath(path)) === '';
    });
}

function showWindow() {
    if (!win) return createWindow();
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
}

function createWindow() {
    win = new BrowserWindow({
        width: 1440, height: 900, minWidth: 1024, minHeight: 640,
        title: 'Cellar Studio', icon: ICON, backgroundColor: '#17140f', show: false, autoHideMenuBar: true,
        webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const allowed = url => url.startsWith(studioUrl);
    win.webContents.on('will-navigate', (event, url) => {
        if (allowed(url)) return;
        event.preventDefault();
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    win.webContents.on('before-input-event', (event, input) => {
        if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
            win.webContents.toggleDevTools();
        }
        if (input.type === 'keyDown' && (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r'))) {
            win.webContents.reload();
        }
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
        log(`load failed (${code} ${desc}) ${url}; retrying`);
        setTimeout(() => win?.loadURL(studioUrl), 1500);
    });
    win.once('ready-to-show', () => win.show());
    // Closing the window keeps the companion running in the tray, so taverns stay in sync.
    win.on('close', event => {
        if (quitting) return;
        event.preventDefault();
        win.hide();
        if (!trayHintShown && tray) {
            trayHintShown = true;
            tray.displayBalloon?.({ title: 'Cellar Studio', content: 'Cellar Studio 仍在托盘中运行，酒馆会继续同步。右键托盘图标可以退出。', iconType: 'info' });
        }
    });
    win.on('closed', () => { win = null; });
    win.loadURL(studioUrl);
}

function createTray() {
    const image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
    tray = new Tray(image);
    tray.setToolTip('Cellar Studio');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: '打开 Cellar Studio', click: showWindow },
        { label: '在浏览器中打开', click: () => shell.openExternal(studioUrl) },
        { type: 'separator' },
        { label: '退出', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('double-click', showWindow);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', showWindow);
    app.on('before-quit', () => { quitting = true; });
    app.on('will-quit', event => {
        if (!server) return;
        event.preventDefault();
        const s = server;
        server = null;
        s.close().catch(() => {}).finally(() => app.quit());
    });
    app.on('window-all-closed', () => { /* stay in the tray */ });
    app.whenReady().then(async () => {
        Menu.setApplicationMenu(null);
        try {
            await loadCompanion();
            await startCompanion();
        } catch (error) {
            log(`startup failed: ${error.stack ?? error.message}`);
            app.exit(1);
            return;
        }
        registerIpc();
        createTray();
        createWindow();
    });
}
