/** Companion configuration: ~/.tavern-cellar/config.json (override the directory with CELLAR_HOME). */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_PORT } from '../../shared/protocol.js';

export function cellarHome() {
    return process.env.CELLAR_HOME || join(homedir(), '.tavern-cellar');
}

export function configPath() {
    return join(cellarHome(), 'config.json');
}

/**
 * Loads the config, creating defaults on first use.
 * `token` is an internal secret for the control API (CLI / Studio read it from this file); users never handle it.
 * @returns {Promise<{port:number, token:string, workspace:string|null, allowOrigins:string[], taverns:{st:boolean, tt:boolean}, stPorts:number[], locations:{st:Array<{dir:string, user?:string}>, tt:Array<{install:string, data:string}>}}>}
 */
export async function loadConfig() {
    let config = {};
    try {
        config = JSON.parse((await readFile(configPath(), 'utf8')).replace(/^\uFEFF/, '')); // Notepad may add a BOM
    } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Cannot read ${configPath()}: ${error.message}`);
    }
    let changed = false;
    if (!Number.isInteger(config.port)) { config.port = DEFAULT_PORT; changed = true; }
    if (typeof config.token !== 'string' || config.token.length < 16) { config.token = randomBytes(16).toString('hex'); changed = true; }
    if (config.workspace === undefined) { config.workspace = null; changed = true; }
    if (!Array.isArray(config.allowOrigins)) { config.allowOrigins = []; changed = true; }
    if (!config.taverns || typeof config.taverns !== 'object') { config.taverns = { st: true, tt: true }; changed = true; }
    for (const host of ['st', 'tt']) {
        if (typeof config.taverns[host] !== 'boolean') { config.taverns[host] = true; changed = true; }
    }
    if (!Array.isArray(config.stPorts)) { config.stPorts = [8000]; changed = true; }
    if (!config.locations || typeof config.locations !== 'object') { config.locations = { st: [], tt: [] }; changed = true; }
    for (const host of ['st', 'tt']) {
        if (!Array.isArray(config.locations[host])) { config.locations[host] = []; changed = true; }
    }
    // Older configs had a single ST folder used only to read its port.
    if ('stDir' in config) {
        if (typeof config.stDir === 'string' && config.stDir && !config.locations.st.some(l => l.dir === config.stDir)) {
            config.locations.st.push({ dir: config.stDir });
        }
        delete config.stDir;
        changed = true;
    }
    if (changed) await saveConfig(config);
    return config;
}

export async function saveConfig(config) {
    await mkdir(cellarHome(), { recursive: true });
    await writeFile(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}
