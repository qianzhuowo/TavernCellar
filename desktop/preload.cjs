// Preload (sandboxed, CommonJS): exposes only the three native helpers Studio may use.
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
});
