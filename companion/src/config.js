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
 * Loads the config, creating it (with a fresh pairing token) on first use.
 * @returns {Promise<{port:number, token:string, workspace:string|null, allowOrigins:string[]}>}
 */
export async function loadConfig() {
    let config = {};
    try {
        config = JSON.parse(await readFile(configPath(), 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Cannot read ${configPath()}: ${error.message}`);
    }
    let changed = false;
    if (!Number.isInteger(config.port)) { config.port = DEFAULT_PORT; changed = true; }
    if (typeof config.token !== 'string' || config.token.length < 16) { config.token = randomBytes(16).toString('hex'); changed = true; }
    if (config.workspace === undefined) { config.workspace = null; changed = true; }
    if (!Array.isArray(config.allowOrigins)) { config.allowOrigins = []; changed = true; }
    if (changed) await saveConfig(config);
    return config;
}

export async function saveConfig(config) {
    await mkdir(cellarHome(), { recursive: true });
    await writeFile(configPath(), JSON.stringify(config, null, 2) + '\n', 'utf8');
}
