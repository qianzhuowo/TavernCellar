/**
 * Detects taverns on this machine: configured locations (config.locations), plus SillyTavern answering on
 * configured ports, plus TauriTavern found through its runtime file. Each instance is reported separately.
 */
import { detectTtDataRoot, isTavernRunning, probeSillyTavern, resolveLocations } from './taverns/locations.js';

/**
 * @param {{config: object, connected?: Array<{host:string,label:string,id:string,origin?:string}>, offline?: Array<{id:string}>}} options
 */
export async function detectTaverns({ config, connected = [], offline = [] }) {
    const locations = await resolveLocations(config.locations);
    const offlineIds = new Set(offline.map(t => t.id));
    const connectionsOf = id => connected.filter(t => t.id === id).map(t => ({ id: t.id, label: t.label, origin: t.origin }));

    const instances = await Promise.all(locations.map(async loc => {
        const running = loc.error ? null : await isTavernRunning(loc);
        const probe = loc.host === 'st' && loc.port ? await probeSillyTavern(loc.port) : null;
        return {
            key: loc.key,
            host: loc.host,
            label: loc.label,
            installDir: loc.installDir,
            dataRoot: loc.dataRoot,
            userDir: loc.userDir,
            user: loc.user,
            users: loc.users,
            port: loc.port,
            version: probe?.version ?? '',
            auth: probe?.auth ?? false,
            running,
            plugin: loc.plugin,
            targetId: loc.targetId,
            error: loc.error,
            // offline access needs a valid folder and the target id the plugin saved in that tavern
            offlineReady: !loc.error && Boolean(loc.targetId),
            offlineActive: Boolean(loc.targetId && offlineIds.has(loc.targetId)),
            connected: loc.targetId ? connectionsOf(loc.targetId) : [],
        };
    }));

    // SillyTavern answering on a port that no configured location claims.
    const claimedPorts = new Set(instances.filter(i => i.host === 'st' && i.port).map(i => i.port));
    const extraPorts = (config.stPorts?.length ? config.stPorts : [8000]).filter(p => !claimedPorts.has(p));
    const unconfiguredSt = (await Promise.all(extraPorts.map(probeSillyTavern))).filter(Boolean);

    const knownIds = new Set(instances.map(i => i.targetId).filter(Boolean));
    const otherConnections = host => connected.filter(t => t.host === host && !knownIds.has(t.id)).map(t => ({ id: t.id, label: t.label, origin: t.origin }));

    const ttDataRoot = await detectTtDataRoot();
    return {
        st: {
            enabled: config.taverns.st,
            instances: instances.filter(i => i.host === 'st'),
            unconfigured: unconfiguredSt,
            otherConnections: otherConnections('st'),
        },
        tt: {
            enabled: config.taverns.tt,
            instances: instances.filter(i => i.host === 'tt'),
            detectedDataRoot: ttDataRoot,
            otherConnections: otherConnections('tt'),
        },
    };
}
