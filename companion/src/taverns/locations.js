/**
 * Tavern locations on disk, used for detection and offline access.
 *
 * config.locations = {
 *   st: [{ dir: 'E:\\SillyTavern', user?: 'default-user' }],   // install dir; data from config.yaml `dataRoot`
 *   tt: [{ install: 'E:\\TauriTavern', data: 'E:\\tt-data' }],  // data dir is user-defined in tt; auto-detected from its runtime file
 * }
 * A resolved location carries the user data folder (characters/, worlds/, settings.json) and the
 * Cellar Link targetId stored in that tavern's settings, so offline access binds to the same target as the live link.
 */
import { execFile } from 'node:child_process';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import yaml from 'js-yaml';

export const PLUGIN_DIR = 'TavernCellar';
const DEFAULT_USER = 'default-user';
const SETTINGS_KEY = 'tavernCellar';
const PROBE_TIMEOUT_MS = 1500;

async function exists(path) {
    try { await access(path); return true; } catch { return false; }
}

async function isDir(path) {
    try { return (await stat(path)).isDirectory(); } catch { return false; }
}

// ---- SillyTavern ------------------------------------------------------------

/** Reads the parts of config.yaml that decide where data lives. Missing keys use SillyTavern's defaults. */
export async function readStConfig(dir) {
    let parsed = {};
    try {
        parsed = yaml.load(await readFile(join(dir, 'config.yaml'), 'utf8')) ?? {};
    } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`config.yaml: ${error.message}`);
    }
    const dataRootSetting = typeof parsed.dataRoot === 'string' && parsed.dataRoot ? parsed.dataRoot : './data';
    return {
        dataRoot: isAbsolute(dataRootSetting) ? dataRootSetting : resolvePath(dir, dataRootSetting),
        port: Number.isInteger(parsed.port) ? parsed.port : 8000,
        userAccounts: parsed.enableUserAccounts === true,
    };
}

/** User handles are the data-root folders that look like user folders (internal ones start with `_`). */
async function listStUsers(dataRoot) {
    let names = [];
    try { names = await readdir(dataRoot, { withFileTypes: true }); } catch { return []; }
    const users = [];
    for (const entry of names) {
        if (!entry.isDirectory() || entry.name.startsWith('_')) continue;
        if (await isDir(join(dataRoot, entry.name, 'characters'))) users.push(entry.name);
    }
    return users.sort((a, b) => (a === DEFAULT_USER ? -1 : b === DEFAULT_USER ? 1 : a.localeCompare(b)));
}

// ---- TauriTavern ------------------------------------------------------------

function ttRuntimeFile() {
    const base = platform() === 'win32' ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
        : platform() === 'darwin' ? join(homedir(), 'Library', 'Application Support')
            : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
    return join(base, 'com.tauritavern.client', 'tauritavern-runtime.json');
}

/** tt records its (user-chosen) data folder in a runtime file; this is the "auto-detect" for the data dir. */
export async function detectTtDataRoot() {
    try {
        const runtime = JSON.parse(await readFile(ttRuntimeFile(), 'utf8'));
        return typeof runtime.data_root === 'string' && runtime.data_root ? runtime.data_root : null;
    } catch {
        return null;
    }
}

/** Executable paths of running tt processes; null when they cannot be read (treated as "maybe running"). */
function ttProcessPaths() {
    return new Promise(resolve => {
        if (platform() !== 'win32') {
            execFile('pgrep', ['-i', '-x', 'tauritavern'], { timeout: 5000 }, (error, stdout) => {
                resolve(error ? [] : String(stdout).trim() ? null : []);
            });
            return;
        }
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='tauritavern.exe'\" | ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } else { '?' } }"],
        { windowsHide: true, timeout: 10000 }, (error, stdout) => {
            if (error) return resolve(null);
            const lines = String(stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
            resolve(lines.includes('?') ? null : lines);
        });
    });
}

// ---- shared -----------------------------------------------------------------

const settingsCache = new Map(); // path -> { mtimeMs, value }

/** Cellar Link settings saved in the tavern (targetId, label); null when the plugin never ran there. */
async function readLinkSettings(userDir) {
    const file = join(userDir, 'settings.json');
    let info;
    try { info = await stat(file); } catch { return null; }
    const cached = settingsCache.get(file);
    if (cached && cached.mtimeMs === info.mtimeMs) return cached.value;
    let value = null;
    try {
        const s = JSON.parse(await readFile(file, 'utf8'))?.extension_settings?.[SETTINGS_KEY];
        if (s && typeof s.targetId === 'string' && s.targetId) value = { targetId: s.targetId, label: typeof s.label === 'string' ? s.label : '' };
    } catch { /* unreadable settings: treat as never ran */ }
    settingsCache.set(file, { mtimeMs: info.mtimeMs, value });
    return value;
}

async function probeHttp(port) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        const res = await fetch(`http://127.0.0.1:${port}/version`, { signal: controller.signal, redirect: 'manual' });
        return res;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * @typedef {object} TavernLocation
 * @property {string} key        'st:0', 'tt:0' (index in config.locations)
 * @property {'st'|'tt'} host
 * @property {string} installDir
 * @property {string|null} dataRoot
 * @property {string|null} userDir   folder with characters/ and worlds/
 * @property {string} user          ST user handle ('default-user' for tt)
 * @property {string[]} users       ST user handles found in the data root
 * @property {number|null} port     ST port from config.yaml
 * @property {boolean|null} plugin  Cellar Link installed
 * @property {string|null} targetId Cellar Link target id saved in this tavern
 * @property {string} label
 * @property {string|null} error    why the location is unusable
 */

/** @returns {Promise<TavernLocation>} */
async function resolveSt(entry, index) {
    const loc = { key: `st:${index}`, host: 'st', installDir: entry.dir, dataRoot: null, userDir: null, user: entry.user || DEFAULT_USER, users: [], port: null, plugin: null, targetId: null, label: '', error: null };
    if (!entry.dir || !await isDir(entry.dir)) return { ...loc, error: '安装目录不存在' };
    if (!await exists(join(entry.dir, 'server.js'))) return { ...loc, error: '不是 SillyTavern 安装目录（缺少 server.js）' };
    let cfg;
    try { cfg = await readStConfig(entry.dir); } catch (error) { return { ...loc, error: error.message }; }
    loc.dataRoot = cfg.dataRoot;
    loc.port = cfg.port;
    loc.users = await listStUsers(cfg.dataRoot);
    if (!loc.users.includes(loc.user)) return { ...loc, error: `数据目录中没有用户 ${loc.user}` };
    loc.userDir = join(cfg.dataRoot, loc.user);
    loc.plugin = await exists(join(entry.dir, 'public', 'scripts', 'extensions', 'third-party', PLUGIN_DIR, 'manifest.json'))
        || await exists(join(loc.userDir, 'extensions', PLUGIN_DIR, 'manifest.json'));
    const link = await readLinkSettings(loc.userDir);
    loc.targetId = link?.targetId ?? null;
    loc.label = link?.label || (loc.users.length > 1 ? `SillyTavern (${loc.user})` : 'SillyTavern');
    return loc;
}

/** @returns {Promise<TavernLocation>} */
async function resolveTt(entry, index) {
    const loc = { key: `tt:${index}`, host: 'tt', installDir: entry.install || '', dataRoot: entry.data || null, userDir: null, user: DEFAULT_USER, users: [DEFAULT_USER], port: null, plugin: null, targetId: null, label: '', error: null };
    if (!loc.dataRoot) return { ...loc, error: '未设置数据目录' };
    if (!await isDir(join(loc.dataRoot, DEFAULT_USER, 'characters'))) return { ...loc, error: '数据目录中没有 default-user/characters' };
    loc.userDir = join(loc.dataRoot, DEFAULT_USER);
    loc.plugin = await exists(join(loc.dataRoot, 'extensions', 'third-party', PLUGIN_DIR, 'manifest.json'))
        || await exists(join(loc.userDir, 'extensions', PLUGIN_DIR, 'manifest.json'));
    const link = await readLinkSettings(loc.userDir);
    loc.targetId = link?.targetId ?? null;
    loc.label = link?.label || 'TauriTavern';
    return loc;
}

/** @returns {Promise<TavernLocation[]>} */
export async function resolveLocations(locations) {
    return Promise.all([
        ...(locations?.st ?? []).map(resolveSt),
        ...(locations?.tt ?? []).map(resolveTt),
    ]);
}

/**
 * Whether the tavern of a location is (or may be) running. Offline writes require a definite "no".
 * ST: anything answering HTTP on its port counts, including 401 from basic auth.
 * tt: a tauritavern process whose executable lies in the install dir; any tt process counts when the install dir is unknown
 *     or process paths cannot be read.
 * @returns {Promise<boolean>}
 */
export async function isTavernRunning(loc) {
    if (loc.host === 'st') return Boolean(loc.port && await probeHttp(loc.port));
    const paths = await ttProcessPaths();
    if (paths === null) return true;
    if (!paths.length) return false;
    if (!loc.installDir) return true;
    const dir = resolvePath(loc.installDir).toLowerCase();
    return paths.some(p => resolvePath(p).toLowerCase().startsWith(dir));
}

/** SillyTavern answering on a port: version info, or `auth: true` when basic auth hides it. */
export async function probeSillyTavern(port) {
    const res = await probeHttp(port);
    if (!res) return null;
    if (res.status === 401) return { port, url: `http://127.0.0.1:${port}`, version: '', auth: true };
    if (!res.ok) return null;
    let info;
    try { info = await res.json(); } catch { return null; }
    const agent = typeof info?.agent === 'string' ? info.agent : '';
    if (!agent.startsWith('SillyTavern')) return null;
    return { port, url: `http://127.0.0.1:${port}`, version: String(info.pkgVersion ?? agent.split(':')[1] ?? ''), auth: false };
}
