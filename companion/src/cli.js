#!/usr/bin/env node
/** cellar — TavernCellar companion CLI. Run `cellar help` for usage. */
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { configPath, loadConfig, saveConfig } from './config.js';
import { Workspace } from './workspace/workspace.js';
import { startServer, STUDIO_PATH } from './server.js';
import { detectTaverns } from './detect.js';
import { detectTtDataRoot, resolveLocations } from './taverns/locations.js';
import { CHARACTER_PARTS } from './codec/character.js';

const USAGE = `TavernCellar 伴侣程序

用法:
  cellar init [目录]                    创建工作区并设为默认工作区
  cellar studio [--no-open]             启动伴侣程序并在浏览器中打开 Cellar Studio
                                        （已在运行则只打开页面；没有工作区时使用 ~/TavernCellar）
  cellar serve [--workspace 目录] [--port 端口]
                                        启动服务（酒馆中的 Cellar Link 会自动连接）
  cellar detect                         检测本机的 SillyTavern / TauriTavern（按实例）、插件安装、离线可用情况
  cellar use <st|tt|all>                只接受某个酒馆的连接（all = 两个都接受）
  cellar tavern list                    查看已设置的酒馆目录
  cellar tavern add st <安装目录> [--user 用户]
                                        添加 SillyTavern 实例（用户默认 default-user）
  cellar tavern add tt [--data 数据目录] [--install 安装目录]
                                        添加 TauriTavern（不填 --data 则自动识别）
    cellar tavern remove <st:0|tt:0>      移除一个酒馆目录
    cellar tavern offline <st:0|tt:0> <wait|write>
                                          酒馆未运行时：wait = 等酒馆启动再同步（默认），write = 不开酒馆也同步（写入数据目录，先备份）
                                        设置目录后，酒馆未连接时也能浏览/取出/拉取；酒馆未运行时可离线写回（先备份）
  cellar status                         查看已连接的酒馆与工作区各项状态
  cellar catalog <character|lorebook> [搜索词] [--target ID] [--offset N] [--limit N]
                                        浏览酒馆中的资料（只取摘要）
  cellar checkout <character|lorebook> <id> [--target ID] [--with-world] [--keep 部分,部分]
                                        取出到工作区（角色 id 为头像文件名，如 Alice.png）
                                        --with-world 一起取出角色绑定的世界书；--keep 见 cellar layout
  cellar layout <项路径> [--keep 部分,部分]   角色卡哪些部分留在 card.json（不写 --keep = 全部拆出）
                                        部分: ${CHARACTER_PARTS.join(', ')}
  cellar sync <项路径> [--target ID] [--force]    把工作区修改同步到酒馆
  cellar pull <项路径> [--target ID] [--force]    把酒馆中的内容取回工作区
  cellar auto <项路径> <on|off> [--target ID]     切换随时同步

版本记录（工作区是 git 仓库，修改自动进入草稿 @）:
  cellar log [项路径] [--limit N]           版本列表，标出各酒馆已部署的版本
  cellar describe "说明"                  给草稿写说明
  cellar commit "说明"                    记录版本（写说明并结束草稿）
  cellar tag <名称> [版本]                给版本打标签（默认最新版本）
  cellar diff <版本A> [版本B] [项路径]     按字段对比两个版本（版本B 默认最新）
  cellar restore <版本> <项路径>          把一项恢复成某个版本（之后同步到酒馆）
  版本可以写编号前几位、标签名或 HEAD

配置文件: ${configPath()}`;

function parseArgs(argv) {
    const positional = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = argv[i + 1];
            if (next !== undefined && !next.startsWith('--')) { flags[key] = next; i++; } else flags[key] = true;
        } else positional.push(arg);
    }
    return { positional, flags };
}

/** `--keep regex,scripts` -> ['regex', 'scripts']; the companion rejects unknown names. */
function parseParts(value) {
    if (value === true) return [];
    return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

async function api(config, method, path, body) {
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
            method,
            headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new NotRunningError(`无法连接伴侣程序（127.0.0.1:${config.port}）。请先运行 cellar serve`);
    }
    const json = await res.json();
    if (!json.ok) throw new Error(`${json.error?.code}: ${json.error?.message}`);
    return json.result;
}

class NotRunningError extends Error {}

function formatHistory({ versions, deployed }) {
    if (!versions.length) return '（还没有版本）';
    return versions.map(v => {
        const marks = [
            v.draft ? '@ 草稿' : '',
            ...v.tags.map(t => `标签 ${t}`),
            ...deployed.filter(d => d.rev === v.id || d.shownAt === v.id).map(d => `${d.label} 已部署 ${d.path}${d.earlier ? `（较早状态 ${d.rev.slice(0, 8)}）` : ''}`),
        ].filter(Boolean);
        const when = new Date(v.time).toLocaleString();
        return `${v.id.slice(0, 8)}  ${when}  ${v.message}${marks.length ? `  [${marks.join('；')}]` : ''}\n          ${v.items.filter(p => p.includes('/')).join('、') || '（无资料项变化）'}`;
    }).join('\n');
}

function formatDiff({ from, to, items }) {
    const show = s => (s.present ? JSON.stringify(s.value).slice(0, 120) : '（无）');
    const lines = [`${from?.slice(0, 8) ?? '（空）'} -> ${to.slice(0, 8)}`];
    if (!items.length) lines.push('没有差异');
    for (const item of items) {
        lines.push(`\n${item.path}  ${{ added: '新增', removed: '删除', changed: '修改', unreadable: `无法读取：${item.error}` }[item.status]}`);
        for (const s of item.slots) lines.push(s.eolOnly ? `  ${s.label}（只有换行符不同）` : `  ${s.label}\n    - ${show(s.from)}\n    + ${show(s.to)}`);
    }
    return lines.join('\n');
}

const HOST_NAMES = { st: 'SillyTavern', tt: 'TauriTavern' };

function pluginText(plugin) {
    return plugin === true ? '已安装 Cellar Link' : plugin === false ? '未安装 Cellar Link' : '插件状态未知';
}

/** Human-readable summary of detectTaverns() output, one block per instance. */
function formatDetection(d, serverRunning) {
    const lines = [];
    const instance = i => {
        const head = `  [${i.key}] ${i.label}${i.user && i.host === 'st' && i.users.length > 1 ? `（用户 ${i.user}）` : ''}`;
        if (i.error) return [head, `    ${i.installDir || i.dataRoot || ''}  不可用：${i.error}`];
        const state = [
            i.running ? (i.auth ? '运行中（需登录）' : '运行中') : '未运行',
            pluginText(i.plugin),
            i.connected.length ? '已连接' : serverRunning ? (i.running ? '等待连接' : '未连接') : '伴侣程序未运行',
            i.offlineReady ? (i.running ? '离线可读（运行中不可离线写回）' : '离线可用') : '离线不可用：需在该酒馆中启用过一次 Cellar Link',
        ];
        return [head, `    数据 ${i.userDir}${i.port ? `  端口 ${i.port}` : ''}`, `    ${state.join(' · ')}`];
    };
    const others = list => list.map(t => `  已连接：${t.label}（${t.origin ?? ''}）`);

    const st = d.st;
    lines.push(`SillyTavern  ${st.enabled ? '接受连接' : '已关闭（cellar use all 可重新开启）'}`);
    for (const i of st.instances) lines.push(...instance(i));
    for (const u of st.unconfigured) lines.push(`  ${u.url}  ${u.auth ? '需登录' : `v${u.version}`}  未设置目录（cellar tavern add st <安装目录>）`);
    lines.push(...others(st.otherConnections));
    if (!st.instances.length && !st.unconfigured.length && !st.otherConnections.length) lines.push('  未设置目录，也未检测到运行中的 SillyTavern');

    const tt = d.tt;
    lines.push(`TauriTavern  ${tt.enabled ? '接受连接' : '已关闭（cellar use all 可重新开启）'}`);
    for (const i of tt.instances) lines.push(...instance(i));
    lines.push(...others(tt.otherConnections));
    if (!tt.instances.length) {
        lines.push(tt.detectedDataRoot
            ? `  未设置目录；检测到数据目录 ${tt.detectedDataRoot}（cellar tavern add tt 可直接添加）`
            : '  未设置目录，也未检测到 TauriTavern');
    }
    return lines.join('\n');
}

function formatLocations(config, resolved) {
    if (!resolved.length) return '尚未设置酒馆目录。用 cellar tavern add st|tt 添加。';
    return resolved.map(l => `[${l.key}] ${l.host === 'st' ? `SillyTavern ${l.installDir}（用户 ${l.user}）` : `TauriTavern 数据 ${l.dataRoot}${l.installDir ? `，安装 ${l.installDir}` : ''}`}\n    ${l.error ? `不可用：${l.error}` : `数据 ${l.userDir}  ${l.targetId ? `target ${l.targetId}` : '尚未启用过 Cellar Link'}`}\n    酒馆未运行时：${l.offlineSync === 'write' ? '不开酒馆也同步（write）' : '等酒馆启动再同步（wait）'}`).join('\n');
}

/** Applies a locations change through the running server, or directly to the config file. */
async function updateLocations(config, locations) {
    try {
        const result = await api(config, 'POST', '/api/taverns/locations', locations);
        return result.resolved;
    } catch (error) {
        if (!(error instanceof NotRunningError)) throw error;
        config.locations = locations;
        await saveConfig(config);
        return resolveLocations(locations);
    }
}

function print(value) {
    console.log(JSON.stringify(value, null, 2));
}

/** Opens a URL in the default browser (detached; errors are reported, not thrown). */
function openBrowser(url) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try {
        const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => console.log(`请手动在浏览器中打开 ${url}`));
        child.unref();
    } catch {
        console.log(`请手动在浏览器中打开 ${url}`);
    }
}

/** True when a TavernCellar companion already answers on the configured port. */
async function studioRunning(url) {
    try {
        const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

async function main() {
    const [command = 'help', ...rest] = process.argv.slice(2);
    const { positional, flags } = parseArgs(rest);
    const config = await loadConfig();
    const target = typeof flags.target === 'string' ? flags.target : undefined;

    switch (command) {
        case 'init': {
            const dir = resolve(positional[0] ?? config.workspace ?? 'TavernCellar');
            const ws = await Workspace.init(dir);
            config.workspace = ws.root;
            await saveConfig(config);
            console.log(`工作区已就绪: ${ws.root}`);
            return;
        }
        case 'serve': {
            if (flags.port) config.port = Number(flags.port);
            const dir = typeof flags.workspace === 'string' ? resolve(flags.workspace) : config.workspace;
            if (!dir) throw new Error('没有工作区。先运行 cellar init [目录]，或使用 --workspace');
            const ws = await Workspace.init(dir);
            const server = await startServer({ config, workspace: ws, log: msg => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) });
            console.log('在酒馆中启用 Cellar Link 后会自动连接，无需令牌。\n');
            console.log(formatDetection(await detectTaverns({ config }), true));
            const stop = async () => { await server.close(); process.exit(0); };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            return;
        }
        case 'studio': {
            const url = `http://127.0.0.1:${config.port}${STUDIO_PATH}`;
            const open = !flags['no-open'];
            if (await studioRunning(url)) {
                console.log(`伴侣程序已在运行：${url}`);
                if (open) openBrowser(url);
                return;
            }
            let dir = config.workspace;
            if (!dir) {
                dir = join(homedir(), 'TavernCellar');
                console.log(`尚未设置工作区，使用默认目录 ${dir}（可用 cellar init <目录> 更改）`);
            }
            const ws = await Workspace.init(dir);
            if (config.workspace !== ws.root) { config.workspace = ws.root; await saveConfig(config); }
            let server;
            try {
                server = await startServer({ config, workspace: ws, log: msg => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`) });
            } catch (error) {
                if (error.code === 'EADDRINUSE') throw new Error(`端口 ${config.port} 已被其他程序占用。可在 ${configPath()} 中修改 port`);
                throw error;
            }
            console.log(`\nCellar Studio：${url}`);
            console.log('关闭此窗口即停止伴侣程序。\n');
            console.log(formatDetection(await detectTaverns({ config }), true));
            if (open) openBrowser(url);
            const stop = async () => { await server.close(); process.exit(0); };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            return;
        }
        case 'detect': {
            let detection;
            let running = true;
            try {
                detection = await api(config, 'GET', '/api/detect');
            } catch (error) {
                if (!(error instanceof NotRunningError)) throw error;
                running = false;
                detection = await detectTaverns({ config });
            }
            if (flags.json) print(detection);
            else console.log(formatDetection(detection, running));
            return;
        }
        case 'use': {
            const [which] = positional;
            if (!['st', 'tt', 'all'].includes(which)) throw new Error('用法: cellar use <st|tt|all>');
            const taverns = { st: which !== 'tt', tt: which !== 'st' };
            try {
                await api(config, 'POST', '/api/taverns', taverns);
            } catch (error) {
                if (!(error instanceof NotRunningError)) throw error;
                config.taverns = taverns;
                await saveConfig(config);
            }
            console.log(`SillyTavern: ${taverns.st ? '接受连接' : '已关闭'}；TauriTavern: ${taverns.tt ? '接受连接' : '已关闭'}`);
            return;
        }
        case 'status':
            print(await api(config, 'GET', '/api/status'));
            return;
        case 'tavern': {
            const [sub, host, dir] = positional;
            const locations = structuredClone(config.locations);
            if (sub === 'list' || !sub) {
                console.log(formatLocations(config, await resolveLocations(config.locations)));
                return;
            }
            if (sub === 'add' && host === 'st') {
                if (!dir) throw new Error('用法: cellar tavern add st <安装目录> [--user 用户]');
                const entry = { dir: resolve(dir) };
                if (typeof flags.user === 'string') entry.user = flags.user;
                locations.st = locations.st.filter(l => !(l.dir === entry.dir && (l.user ?? 'default-user') === (entry.user ?? 'default-user')));
                locations.st.push(entry);
            } else if (sub === 'add' && host === 'tt') {
                const data = typeof flags.data === 'string' ? resolve(flags.data) : await detectTtDataRoot();
                if (!data) throw new Error('未能自动识别 TauriTavern 数据目录，请用 --data 指定');
                const entry = { install: typeof flags.install === 'string' ? resolve(flags.install) : '', data };
                locations.tt = locations.tt.filter(l => l.data !== entry.data);
                locations.tt.push(entry);
            } else if (sub === 'remove' && /^(st|tt):\d+$/.test(host ?? '')) {
                const [h, index] = host.split(':');
                if (!locations[h][Number(index)]) throw new Error(`没有 ${host}`);
                locations[h].splice(Number(index), 1);
            } else if (sub === 'offline' && /^(st|tt):\d+$/.test(host ?? '') && ['wait', 'write'].includes(dir)) {
                const [h, index] = host.split(':');
                if (!locations[h][Number(index)]) throw new Error(`没有 ${host}`);
                if (dir === 'write') locations[h][Number(index)].offlineSync = 'write';
                else delete locations[h][Number(index)].offlineSync;
                let resolved;
                try {
                    resolved = (await api(config, 'POST', '/api/taverns/offline-sync', { key: host, mode: dir })).resolved;
                } catch (error) {
                    if (!(error instanceof NotRunningError)) throw error;
                    config.locations = locations;
                    await saveConfig(config);
                    resolved = await resolveLocations(locations);
                }
                config.locations = locations;
                console.log(formatLocations(config, resolved));
                return;
            } else {
                throw new Error('用法: cellar tavern list | add st <安装目录> [--user 用户] | add tt [--data 目录] [--install 目录] | remove <st:N|tt:N> | offline <st:N|tt:N> <wait|write>');
            }
            config.locations = locations;
            console.log(formatLocations(config, await updateLocations(config, locations)));
            return;
        }
        case 'catalog': {
            const [kind, query] = positional;
            if (!kind) throw new Error('用法: cellar catalog <character|lorebook> [搜索词]');
            print(await api(config, 'POST', '/api/catalog', { target, kind, query, offset: Number(flags.offset ?? 0), limit: Number(flags.limit ?? 50) }));
            return;
        }
        case 'checkout': {
            const [kind, id] = positional;
            if (!kind || !id) throw new Error('用法: cellar checkout <character|lorebook> <id>');
            print(await api(config, 'POST', '/api/checkout', { target, kind, id, withWorld: Boolean(flags['with-world']), ...(flags.keep !== undefined ? { exclude: parseParts(flags.keep) } : {}) }));
            return;
        }
        case 'layout': {
            const [path] = positional;
            if (!path) throw new Error('用法: cellar layout <项路径> [--keep 部分,部分]');
            print(await api(config, 'POST', '/api/layout', { path: path.replace(/\\/g, '/').replace(/\/$/, ''), exclude: flags.keep === undefined ? [] : parseParts(flags.keep) }));
            return;
        }
        case 'sync':
        case 'pull': {
            const [path] = positional;
            if (!path) throw new Error(`用法: cellar ${command} <项路径>`);
            print(await api(config, 'POST', `/api/${command}`, { path: path.replace(/\\/g, '/').replace(/\/$/, ''), target, force: Boolean(flags.force) }));
            return;
        }
        case 'auto': {
            const [path, mode] = positional;
            if (!path || !['on', 'off'].includes(mode)) throw new Error('用法: cellar auto <项路径> <on|off>');
            print(await api(config, 'POST', '/api/auto-sync', { path: path.replace(/\\/g, '/').replace(/\/$/, ''), target, enabled: mode === 'on' }));
            return;
        }
        case 'log': {
            const path = positional[0]?.replace(/\\/g, '/').replace(/\/$/, '');
            const h = await api(config, 'POST', '/api/history', { path, limit: Number(flags.limit ?? 30) });
            console.log(formatHistory(h));
            return;
        }
        case 'describe':
        case 'commit': {
            const message = positional.join(' ');
            if (command === 'commit' && !message) throw new Error('用法: cellar commit "说明"');
            const r = await api(config, 'POST', `/api/history/${command}`, { message });
            console.log(r.id ? `${command === 'commit' ? '已记录版本' : '草稿说明已更新'} ${r.id.slice(0, 8)}` : '没有修改');
            return;
        }
        case 'tag': {
            const [name, rev] = positional;
            if (!name) throw new Error('用法: cellar tag <名称> [版本]');
            const r = await api(config, 'POST', '/api/history/tag', { name, rev });
            console.log(`标签 ${r.name} -> ${r.id.slice(0, 8)}`);
            return;
        }
        case 'diff': {
            const [from, to, path] = positional;
            if (!from) throw new Error('用法: cellar diff <版本A> [版本B] [项路径]');
            console.log(formatDiff(await api(config, 'POST', '/api/history/diff', { from, to: to || undefined, path: path?.replace(/\\/g, '/').replace(/\/$/, '') })));
            return;
        }
        case 'restore': {
            const [rev, path] = positional;
            if (!rev || !path) throw new Error('用法: cellar restore <版本> <项路径>');
            const r = await api(config, 'POST', '/api/history/restore', { rev, path: path.replace(/\\/g, '/').replace(/\/$/, '') });
            console.log(`${r.path} 已恢复到 ${r.rev.slice(0, 8)}；用 cellar sync ${r.path} 同步到酒馆`);
            return;
        }
        case 'help':
        case '--help':
        case '-h':
            console.log(USAGE);
            return;
        default:
            console.error(`未知命令: ${command}\n`);
            console.log(USAGE);
            process.exitCode = 2;
    }
}

main().catch(error => {
    console.error(`错误: ${error.message}`);
    process.exitCode = 1;
});
