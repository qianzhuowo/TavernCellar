# 架构

> 总体方向见 [ROADMAP.md](ROADMAP.md)。本文描述第 1 阶段落地的结构与数据流，后续阶段在此基础上扩展。

## 1. 进程与组件

```
┌──────────── 酒馆页面（ST 浏览器标签 / tt WebView）────────────┐
│ Cellar Link（index.js → src/link/*）                          │
│   connection.js  WebSocket 客户端、请求/响应、断线重连        │
│   host.js        宿主适配：目录、读取、写入、刷新、事件        │
│   main.js        设置面板、生命周期                           │
└───────────────┬──────────────────────────────────────────────┘
                │ ws://127.0.0.1:<port>/link   （配对令牌 + Origin 校验）
┌───────────────▼──────────── 伴侣程序（Node，companion/）───────┐
│ server.js     HTTP + WS 服务；/link 给插件，/api/* 给 CLI 与以后的编辑器 │
│ targets.js    已连接的酒馆（目标）注册表，按 targetId 管理       │
│ sync.js       取出 / 同步 / 拉取 / 冲突判定 / 自动同步           │
│ watch.js      监视工作区文件变化                                │
│ workspace/    cellar.json、状态文件、条目模板                   │
│ codec/        角色卡、世界书 ⇄ 工作区文件                       │
│ cli.js        cellar 命令                                      │
└───────────────┬──────────────────────────────────────────────┘
                │ 读写
          工作区目录（酒馆数据目录之外）
```

`shared/` 中的协议常量与哈希函数是纯 ESM、无依赖，插件（浏览器）和伴侣程序（Node）共用同一份代码。

## 2. 单一写入路径

| 数据 | 读取 | 写入 | 写入后刷新 |
|---|---|---|---|
| 角色卡 | `POST /api/characters/get`，取 `json_data` 解析为规范卡片 JSON | `POST /api/characters/merge-attributes`（`{...卡片, avatar}`） | `getOneCharacter(avatar)`；若该角色正在编辑中，再调用 `selectCharacterById(id, {switchMenu:false})` 重新填充表单 |
| 世界书 | `loadWorldInfo(name)`（与前端缓存一致） | `saveWorldInfo(name, data, true)`（同时更新前端缓存并立即写入） | `reloadWorldInfoEditor(name)` |

- 这些函数都来自 `SillyTavern.getContext()`。ST 与 tt 共用同一份前端代码，所以插件里没有按宿主分支的写入逻辑。
- **写入前复核**：插件先读取当前内容并计算哈希，与 `baseHash` 不一致就返回 `conflict`，不写入。
- **写入后复读**：插件写完后重新从后端读取一次，把结果数据和哈希返回。宿主可能对数据做规范化（例如 `merge-attributes` 会把 `avatar` 写进卡片，且无法删除对象中的键），伴侣程序以复读结果为准，把差异拉回工作区。

### 已知限制（第 1 阶段）

- `merge-attributes` 对对象做深度合并：数组整体替换，但**无法删除对象中的键**。删除了 `card.json` 里某个嵌套对象键时，复读结果仍会带着它，伴侣程序会把它拉回工作区并给出提示。
- 角色正在酒馆编辑器里打开、并且用户刚在酒馆里输入（自动保存的防抖尚未触发）时同步，酒馆里这次未保存的输入可能被覆盖。
- 酒馆端对角色的修改只有通过编辑表单保存（会触发 `CHARACTER_EDITED`）时才会被即时感知；其它扩展经 `merge-attributes` 做的修改不会触发事件，会在下一次同步前的复核中以冲突形式暴露。

## 3. 数据流

### 取出
CLI → `POST /api/checkout` → 伴侣程序向插件发 `item.get` → 解码为文件写入工作区 → 在 `cellar.json` 登记该项及其绑定 → 记录基准哈希 → 通过 `watch.set` 告知插件监视该项。

### 同步（工作区 → 酒馆）
工作区文件编码为数据，计算哈希 W；与基准 B 比较。W ≠ B 时发送 `item.put {data, baseHash: B}`。插件复核、写入、复读，返回结果哈希 R；B ← R，结果与 W 不同则把结果解码回工作区。

### 拉取（酒馆 → 工作区）
插件收到 `CHARACTER_EDITED` / `WORLDINFO_UPDATED` 且该项在监视列表中时，发送 `item.changed {hash}`。伴侣程序：
- hash = B：自己刚写入引起的回声，忽略；
- 工作区无本地修改（W = B）：自动拉取并解码到工作区，B ← hash；
- 工作区有本地修改（W ≠ B）：标记冲突，把酒馆版本保存到 `.cellar/conflicts/`，不改动工作区文件。

### 自动同步
绑定上 `autoSync: true` 时，文件监视发现 W ≠ B 且没有冲突，就自动执行一次同步。第 2 阶段会把同步模式并入版本管理。

## 4. 目标（酒馆实例）

- 每个酒馆实例由插件生成并持久保存一个 `targetId`（存放在该酒馆自己的扩展设置里），因此 ST 与 tt 天然是不同的目标。
- 同一 `targetId` 出现第二条连接（例如同一酒馆开了两个标签页）时，新连接生效，旧连接以 `4409` 关闭，旧标签页停止自动重连。

## 5. 安全

- 只监听 `127.0.0.1`。
- 插件连接必须在握手中提供配对令牌；令牌由伴侣程序首次启动时生成，保存在用户目录 `~/.tavern-cellar/config.json`。
- 校验 WebSocket 的 Origin：允许 `http(s)://localhost|127.0.0.1|[::1]:*`、`http(s)://tauri.localhost`、`tauri://localhost`，以及配置中额外列出的来源。
- HTTP 控制接口要求 `Authorization: Bearer <令牌>`，并且不提供 CORS 响应头，浏览器网页无法跨域调用。
- 伴侣程序只读写工作区目录内的文件；协议中不存在执行命令或访问任意路径的操作。

## 6. 依赖

- 插件：无第三方依赖，只使用酒馆前端已有的能力。
- 伴侣程序：Node ≥ 20；`ws`（WebSocket 服务）、`js-yaml`（世界书条目的 YAML 头）。第 2 阶段加入 `isomorphic-git`。
