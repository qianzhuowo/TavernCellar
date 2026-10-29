#!/usr/bin/env node
/** cellar — TavernCellar companion CLI. Run `cellar help` for usage. */
import { resolve } from 'node:path';
import { configPath, loadConfig, saveConfig } from './config.js';
import { Workspace } from './workspace/workspace.js';
import { startServer } from './server.js';

const USAGE = `TavernCellar 伴侣程序

用法:
  cellar init [目录]                    创建工作区并设为默认工作区
  cellar serve [--workspace 目录] [--port 端口]
                                        启动服务（酒馆插件连接到这里）
  cellar token                          显示配对令牌（粘贴到 Cellar Link 设置中）
  cellar status                         查看已连接的酒馆与工作区各项状态
  cellar catalog <character|lorebook> [搜索词] [--target ID] [--offset N] [--limit N]
                                        浏览酒馆中的资料（只取摘要）
  cellar checkout <character|lorebook> <id> [--target ID]
                                        取出到工作区（角色 id 为头像文件名，如 Alice.png）
  cellar sync <项路径> [--target ID] [--force]    把工作区修改同步到酒馆
  cellar pull <项路径> [--target ID] [--force]    把酒馆中的内容取回工作区
  cellar auto <项路径> <on|off> [--target ID]     切换随时同步

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

async function api(config, method, path, body) {
    let res;
    try {
        res = await fetch(`http://127.0.0.1:${config.port}${path}`, {
            method,
            headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new Error(`无法连接伴侣程序（127.0.0.1:${config.port}）。请先运行 cellar serve`);
    }
    const json = await res.json();
    if (!json.ok) throw new Error(`${json.error?.code}: ${json.error?.message}`);
    return json.result;
}

function print(value) {
    console.log(JSON.stringify(value, null, 2));
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
            console.log(`配对令牌: ${config.token}`);
            const stop = async () => { await server.close(); process.exit(0); };
            process.on('SIGINT', stop);
            process.on('SIGTERM', stop);
            return;
        }
        case 'token':
            console.log(config.token);
            return;
        case 'status':
            print(await api(config, 'GET', '/api/status'));
            return;
        case 'catalog': {
            const [kind, query] = positional;
            if (!kind) throw new Error('用法: cellar catalog <character|lorebook> [搜索词]');
            print(await api(config, 'POST', '/api/catalog', { target, kind, query, offset: Number(flags.offset ?? 0), limit: Number(flags.limit ?? 50) }));
            return;
        }
        case 'checkout': {
            const [kind, id] = positional;
            if (!kind || !id) throw new Error('用法: cellar checkout <character|lorebook> <id>');
            print(await api(config, 'POST', '/api/checkout', { target, kind, id }));
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
