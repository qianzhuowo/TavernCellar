/**
 * Cellar Studio desktop shell (Electron main process).
 * Runs the companion in-process (startServer) and shows the Studio UI it serves at /studio/.
 * The UI talks to the companion over HTTP + SSE only; IPC is limited to a few native helpers and the app update
 * (see preload.cjs).
 * See docs/studio-design.md §2.
 */
// CommonJS on purpose: Electron 33's ESM main crashes on named imports from 'electron'.
// The companion is ESM and is loaded with import() in loadCompanion().
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const { appendFile, mkdir } = require('node:fs/promises');
const { dirname, isAbsolute, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const here = __dirname;
/**
 * Default workspace of the desktop app: a `workspace` folder next to the executable (the folder holding the portable
 * exe, or the install folder). The installer keeps that folder on uninstall / upgrade (assets/installer.nsh).
 * Running from source (not packaged) keeps the command line default, Documents/TavernCellar.
 */
function desktopDefaultWorkspace() {
    if (!app.isPackaged) return null;
    const base = process.env.PORTABLE_EXECUTABLE_DIR || dirname(process.execPath);
    return join(base, 'workspace');
}
let STUDIO_PATH, startServer, cellarHome, defaultWorkspaceDir, loadConfig, saveConfig, Workspace;
async function loadCompanion() {
    const fallback = desktopDefaultWorkspace();
    if (fallback && !process.env.CELLAR_DEFAULT_WORKSPACE) process.env.CELLAR_DEFAULT_WORKSPACE = fallback;
    const load = rel => import(pathToFileURL(join(here, '..', rel)).href);
    ({ STUDIO_PATH, startServer } = await load('companion/src/server.js'));
    ({ cellarHome, defaultWorkspaceDir, loadConfig, saveConfig } = await load('companion/src/config.js'));
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
    const dir = config.workspace ?? defaultWorkspaceDir();
    let workspace;
    try {
        workspace = await Workspace.init(dir);
    } catch (error) {
        dialog.showErrorBox('Cellar Studio', `无法使用工作区 ${dir}：${error.message}\n可以在 ${join(cellarHome(), 'config.json')} 中把 workspace 改为可写的文件夹。`);
        throw error;
    }
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

// ---- updates: published GitHub releases only (docs/studio-design.md §4.6) -------------------------------------
// The check reads the repository's releases (drafts and pre-releases excluded) so every newer version's notes can
// be shown. Installing goes through electron-updater (latest.yml attached by the release workflow); it only applies
// to the installed app: the portable exe and a source checkout can only be pointed to the download page.
const UPDATE_REPO = 'qianzhuowo/TavernCellar';
const RELEASES_PAGE = `https://github.com/${UPDATE_REPO}/releases`;
/** @type {any} electron-updater's autoUpdater, loaded on first download */
let updater = null;
let downloaded = '';

/** 'installer' | 'portable' | 'source' */
function updateMode() {
    if (!app.isPackaged) return 'source';
    return process.env.PORTABLE_EXECUTABLE_DIR ? 'portable' : 'installer';
}

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;
function compareVersions(a, b) {
    const x = VERSION_RE.exec(a)?.slice(1).map(Number) ?? [0, 0, 0];
    const y = VERSION_RE.exec(b)?.slice(1).map(Number) ?? [0, 0, 0];
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
}

async function checkUpdate() {
    const current = app.getVersion();
    const mode = updateMode();
    let res;
    try {
        res = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases?per_page=30`, {
            headers: { Accept: 'application/vnd.github+json', 'User-Agent': `CellarStudio/${current}` },
            signal: AbortSignal.timeout(15000),
        });
    } catch (error) {
        return { error: `无法连接 GitHub：${error.cause?.code ?? error.message}`, current, mode, page: RELEASES_PAGE };
    }
    if (!res.ok) {
        const limited = res.status === 403 || res.status === 429;
        return { error: limited ? 'GitHub 暂时限制了查询次数，请稍后再试' : `GitHub 返回 ${res.status}`, current, mode, page: RELEASES_PAGE };
    }
    const releases = (await res.json())
        .filter(r => !r.draft && !r.prerelease && VERSION_RE.test(r.tag_name))
        .map(r => ({
            version: r.tag_name.replace(/^v/, ''), name: r.name || r.tag_name, notes: r.body || '', date: r.published_at, url: r.html_url,
            installable: (r.assets ?? []).some(a => a.name === 'latest.yml'),
        }))
        .sort((a, b) => compareVersions(b.version, a.version));
    const newer = releases.filter(r => compareVersions(r.version, current) > 0);
    log(`update check: current ${current}, latest ${releases[0]?.version ?? 'none'}`);
    return {
        current, mode, page: RELEASES_PAGE, latest: releases[0] ?? null, newer,
        canInstall: mode === 'installer' && Boolean(newer[0]?.installable),
        downloaded: downloaded && newer[0] && downloaded === newer[0].version ? downloaded : '',
    };
}

function getUpdater() {
    if (updater) return updater;
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;
    updater.logger = { info: m => log(`updater: ${m}`), warn: m => log(`updater: ${m}`), error: m => log(`updater: ${m}`), debug: () => {} };
    updater.on('download-progress', p => {
        win?.webContents.send('cellar:update-progress', { percent: p.percent, transferred: p.transferred, total: p.total });
    });
    return updater;
}

async function downloadUpdate() {
    if (updateMode() !== 'installer') return { error: '只有安装版可以自动更新；请在下载页获取新版本' };
    try {
        const u = getUpdater();
        const result = await u.checkForUpdates();
        const version = result?.updateInfo?.version;
        if (!version || compareVersions(version, app.getVersion()) <= 0) return { error: '没有可以安装的新版本' };
        await u.downloadUpdate();
        downloaded = version;
        return { version };
    } catch (error) {
        log(`update download failed: ${error.stack ?? error.message}`);
        return { error: `下载更新失败：${String(error.message).split('\n')[0]}` };
    }
}

/** Stops the companion first (so the workspace and the port are released), then runs the installer and restarts. */
async function installUpdate() {
    if (!downloaded || !updater) throw new Error('更新还没有下载完成');
    log(`installing update ${downloaded}`);
    quitting = true;
    const s = server;
    server = null;
    if (s) await Promise.race([s.close().catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))]);
    tray?.destroy();
    tray = null;
    // silent: the installer reuses the folder of the installed app (and keeps its workspace); then starts it again
    setImmediate(() => updater.quitAndInstall(true, true));
}

function registerIpc() {
    ipcMain.handle('cellar:update-check', async event => {
        if (!fromStudio(event)) return null;
        return checkUpdate();
    });
    ipcMain.handle('cellar:update-download', async event => {
        if (!fromStudio(event)) return null;
        return downloadUpdate();
    });
    ipcMain.handle('cellar:update-install', async event => {
        if (!fromStudio(event)) return false;
        await installUpdate();
        return true;
    });
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
    /** Links Studio may hand to the OS: web pages, and VS Code's own "open this path" URL (no command is run here). */
    const external = url => /^https?:\/\//.test(url) || /^vscode:\/\/file\/[A-Za-z]:\//.test(url);
    win.webContents.on('will-navigate', (event, url) => {
        if (allowed(url)) return;
        event.preventDefault();
        if (external(url)) shell.openExternal(url);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (external(url)) shell.openExternal(url);
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
    // Close the companion, then exit. app.quit() called again from here is ignored by Electron while this quit
    // is still being processed, which left a windowless process holding the single-instance lock with the port
    // closed: the next launch then showed its window in that process and stayed blank (ERR_CONNECTION_REFUSED).
    app.on('will-quit', event => {
        if (!server) return;
        event.preventDefault();
        const s = server;
        server = null;
        const timeout = new Promise(resolve => setTimeout(resolve, 3000));
        Promise.race([s.close().catch(() => {}), timeout]).finally(() => {
            tray?.destroy();
            app.exit(0);
        });
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
