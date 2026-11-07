// Preload (sandboxed, CommonJS): exposes only the native helpers Studio may use, and the app update.
// Everything else goes through the companion's HTTP API, exactly as in the browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cellarDesktop', {
    platform: process.platform,
    /** @returns {Promise<string|null>} absolute folder path, or null when cancelled */
    pickDirectory: () => ipcRenderer.invoke('cellar:pick-directory'),
    /** @param {string} absPath */
    showInFolder: absPath => ipcRenderer.invoke('cellar:show-in-folder', String(absPath)),
    /** Opens a file or folder with the system default app. @param {string} absPath */
    openInEditor: absPath => ipcRenderer.invoke('cellar:open-in-editor', String(absPath)),
    /** Published releases newer than this app, with their notes. */
    checkUpdate: () => ipcRenderer.invoke('cellar:update-check'),
    /** Downloads the newest release (installed app only). @returns {Promise<{version?: string, error?: string}>} */
    downloadUpdate: () => ipcRenderer.invoke('cellar:update-download'),
    /** Closes the app, installs the downloaded update and starts it again. */
    installUpdate: () => ipcRenderer.invoke('cellar:update-install'),
    /** @param {(p: {percent: number, transferred: number, total: number}) => void} cb @returns {() => void} unsubscribe */
    onUpdateProgress: cb => {
        const listener = (_event, p) => cb(p);
        ipcRenderer.on('cellar:update-progress', listener);
        return () => ipcRenderer.removeListener('cellar:update-progress', listener);
    },
});
