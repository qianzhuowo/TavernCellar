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
                │ ws://127.0.0.1:<port>/link   （Origin + Host 校验，无令牌）
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
- 工作区有本地修改（W ≠ B）：按槽位三方合并（见下节）。

### 按槽位合并（`codec/slots.js`）
每次两边达成一致（取出、同步、拉取、合并后），除基准哈希 B 外还把该版本数据存为 `.cellar/base/<项路径>/<targetId>.json`。
- **槽位**：角色的每个字段、每条其他开场（按位置）、每条正则、每个酒馆助手脚本（按 `id`）、变量整体、每个内嵌书条目（按 `id`）、其他扩展字段；世界书的每项书设置、每个条目（按 uid）。按 id 排列的列表另有一个 `$order` 槽位。
- 只有一边改的槽位取那一边；两边改成同样的值不算冲突；两边改得不同（含一边删、一边改）是冲突。`$order` 两边都变时，增删合并、单边重排取重排一边，只有两边重排得不同才冲突。
- 无冲突：合并结果写入工作区，B ← 酒馆当前版本；手动同步、或开了随时同步的项，把合并结果以新的 `baseHash` 写回。写回时酒馆又变了则重新合并，最多重试 2 次。
- 有冲突：冲突槽位保留工作区的值，其余槽位照常合并进工作区；酒馆版本存到 `.cellar/conflicts/`，状态 `conflict.slots` 列出冲突槽位，整项不写回酒馆。用户在文件里改好后再同步会重新比对；`--force` 仍可整项取一边。`POST /api/conflict {path, target?}` 返回每个冲突槽位的名称及工作区、酒馆、基准三方的值。
- 没有基准快照的旧绑定（本功能之前同步的）：整项记为一个冲突（槽位 `*`）；下一次达成一致后即有快照。

### 自动同步
绑定上 `autoSync: true` 时，文件监视发现 W ≠ B 且没有冲突，就自动执行一次同步。可写的连接是实时连接，或处于「不开酒馆也同步」（`write`）的离线链接。第 2 阶段会把同步模式并入版本管理。

### 离线访问（按酒馆数据目录）
配置 `locations` 设置了酒馆目录、且该酒馆启用过一次 Cellar Link（其设置里保存了 `targetId`）时，伴侣程序为它建立离线链接 `OfflineLink`，接口与实时连接相同：
- 实时连接优先；酒馆未连接时，浏览、取出、拉取、同步都改为直接读写数据目录。读出的数据与插件报告的一致，哈希可以互通。
- 写入仅在酒馆未运行时进行（运行中的酒馆会用内存里的副本覆盖文件，返回 `tavern_running`）。每次写入都复核基准哈希，先备份到工作区 `.cellar/backups/`（每项保留 5 份），再以临时文件 + 改名写入，最后复读。
- `cellar use` / 「接受连接」关闭某类酒馆时，它的实时连接和离线访问一并关闭。
- **酒馆未运行时**：每个酒馆位置有 `offlineSync`，由用户选择（`cellar tavern offline <st:N|tt:N> <wait|write>`、`POST /api/taverns/offline-sync`、Studio 设置与向导）：
  - `wait`（默认，不写入配置）：等酒馆启动再同步。离线时照常编辑工作区，不写酒馆文件；手动同步返回 `waiting_for_tavern`（HTTP 423），状态标 `waiting: true`。Cellar Link 连上后，伴侣程序把开了随时同步、W ≠ B 且无冲突的项推送过去；酒馆在此期间也改过时，按基准哈希拒绝并记为冲突，不会覆盖。
  - `write`：不开酒馆也同步。离线时手动同步和随时同步都直接写数据目录（规则同上，先备份）。从 `wait` 切到 `write` 时，积压的随时同步项立即写入。
  - 两种方式都可离线浏览、取出、拉取。离线绑定在状态里带 `offlineSync`。
- `GET /api/status` 对离线绑定直接读取酒馆当前哈希 T，给出真实状态并标 `offline: true`：`in-sync`、`local-changes`（W ≠ B）、`tavern-changes`（T ≠ B）、`both-changed`（W、T 都变且不同；同步会被拒绝并记为冲突）、`conflict`、`invalid`。

## 4. 目标（酒馆实例）

- 每个酒馆实例由插件生成并持久保存一个 `targetId`（存放在该酒馆自己的扩展设置里），因此 ST 与 tt 天然是不同的目标。
- 同一 `targetId` 出现第二条连接（例如同一酒馆开了两个标签页）时，新连接生效，旧连接以 `4409` 关闭，旧标签页停止自动重连。

## 5. 安全

- 只监听 `127.0.0.1`。
- **插件连接不使用令牌，靠来源准入**：浏览器发起 WebSocket 时必定携带真实的 Origin 头，网页无法伪造。伴侣程序只接受来自 `http(s)://localhost|127.0.0.1|[::1]:*`、`http(s)://tauri.localhost`、`tauri://localhost` 以及配置 `allowOrigins` 中额外列出的来源；没有 Origin 的连接（非浏览器）一律拒绝。互联网网页因此无法连接。
- 校验 Host 头必须是 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，防止 DNS 重绑定（外部域名解析到 127.0.0.1）。
- 剩余风险：本机其他网页服务提供的页面同样是回环来源，也能连接。本机程序本就能直接读写用户文件，令牌对此并无额外保护。对策：`cellar status` / `cellar detect` 列出每个已连接酒馆的来源；`cellar use st|tt|all`（配置 `taverns`）可关闭某类酒馆的连接，被关闭的连接以 `4403` 断开。
- HTTP 控制接口（CLI、Studio 主进程）要求 `Authorization: Bearer <内部令牌>`、拒绝任何带 Origin 的请求、校验 Host，且不提供 CORS。内部令牌存在 `~/.tavern-cellar/config.json`，由客户端自动读取，用户不需要接触。
- 伴侣程序只读写工作区目录内的文件；协议中不存在执行命令或访问任意路径的操作。

## 6. 依赖

- 插件：无第三方依赖，只使用酒馆前端已有的能力。
- 伴侣程序：Node ≥ 20；`ws`（WebSocket 服务）、`js-yaml`（世界书条目的 YAML 头）。第 2 阶段加入 `isomorphic-git`。
