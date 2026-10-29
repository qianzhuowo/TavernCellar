/** Watches the workspace and reports which item folder changed (debounced per item). */
import { watch } from 'node:fs';
import { isIgnoredName } from './workspace/workspace.js';

const DEBOUNCE_MS = 400;

/**
 * @param {import('./workspace/workspace.js').Workspace} workspace
 * @param {(itemPath: string) => void} onItemChanged
 * @returns {() => void} stop
 */
export function watchWorkspace(workspace, onItemChanged, log = () => {}) {
    const timers = new Map();
    let watcher;
    try {
        watcher = watch(workspace.root, { recursive: true }, (_event, filename) => {
            if (!filename) return;
            const parts = String(filename).split(/[\\/]/);
            if (parts.some(isIgnoredName)) return;
            if (parts.length < 2) return;
            const itemPath = `${parts[0]}/${parts[1]}`;
            if (!workspace.getItem(itemPath)) return;
            clearTimeout(timers.get(itemPath));
            timers.set(itemPath, setTimeout(() => {
                timers.delete(itemPath);
                Promise.resolve(onItemChanged(itemPath)).catch(error => log(`watch handler failed for ${itemPath}: ${error.message}`));
            }, DEBOUNCE_MS));
        });
    } catch (error) {
        log(`file watching unavailable: ${error.message}`);
        return () => {};
    }
    watcher.on('error', error => log(`file watcher error: ${error.message}`));
    return () => {
        for (const timer of timers.values()) clearTimeout(timer);
        watcher.close();
    };
}
