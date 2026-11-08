# Cellar 协议 v1

实现：`shared/protocol.js`。插件与伴侣程序共用该文件中的常量与校验函数。

## 1. 传输

- 伴侣程序监听 `127.0.0.1:<port>`（默认 `7349`）。
- `GET /link` 升级为 WebSocket：供 Cellar Link 使用。准入条件：Host 为伴侣程序自己的回环地址，且 Origin 存在并属于允许的酒馆来源（见 architecture.md §5）。不满足时返回 HTTP 403。无令牌。
- `/api/*`：HTTP 控制接口，供 CLI 与 Studio 主进程使用，需要 `Authorization: Bearer <内部令牌>`（从本机配置文件读取）。其中：
  - `GET /api/detect`：检测本机酒馆（ST 通过回环端口的 `GET /version` 识别；tt 通过进程与运行配置文件中的 `data_root`）、插件是否安装、当前连接及来源。
  - `POST /api/taverns`：`{ st?: boolean, tt?: boolean }`，设置接受哪类酒馆的连接；关闭时断开现有连接（`4403`）。

## 2. 消息信封（WebSocket，JSON 文本帧）

```jsonc
// 请求
{ "v": 1, "id": "r12", "type": "item.get", "payload": { ... } }
// 成功响应
{ "v": 1, "id": "r12", "type": "response", "ok": true,  "payload": { ... } }
// 失败响应
{ "v": 1, "id": "r12", "type": "response", "ok": false, "error": { "code": "conflict", "message": "...", "details": { ... } } }
// 事件（无 id，不需要响应）
{ "v": 1, "type": "item.changed", "payload": { ... } }
```

双方都可以发送请求；请求 id 由发起方生成，在同一连接内唯一。默认超时 30 秒，超时按 `timeout` 错误处理。

## 3. 握手

连接建立后，插件必须在 5 秒内发送 `hello` 请求，否则伴侣程序关闭连接。

```jsonc
// 插件 → 伴侣程序
{ "type": "hello", "payload": {
    "protocol": 1,
    "target": { "id": "<targetId>", "label": "SillyTavern @ 127.0.0.1:8000", "host": "st", "hostVersion": "1.15.0" },
    "capabilities": { "worldInfoEntryTemplate": { /* 酒馆的 newWorldInfoEntryTemplate */ } }
} }
// 成功响应
{ "ok": true, "payload": { "server": { "name": "TavernCellar", "version": "0.2.2", "protocol": 1 } } }
```

`host` 取值：`st` 或 `tt`（页面为 Tauri 环境——存在 `window.__TAURI_INTERNALS__`、协议为 `tauri:` 或主机为 `tauri.localhost`——时为 `tt`）。伴侣程序关闭了该类酒馆时，握手返回 `tavern_disabled` 并以 `4403` 关闭。旧版插件在 payload 中发送的 `token` 字段被忽略。

## 4. 伴侣程序 → 插件的请求

| type | payload | 响应 payload |
|---|---|---|
| `catalog.list` | `{ kind, query?, offset?=0, limit?=50 }` | `{ total, items: [{ id, name, ... }] }` |
| `item.get` | `{ kind, id }` | `{ kind, id, hash, data }` |
| `item.put` | `{ kind, id, data, baseHash }` | `{ kind, id, hash, data, warnings: [] }` |
| `watch.set` | `{ items: [{ kind, id }] }` | `{ count }` |
| `item.create` | `{ kind, data }` | `{ kind, id, hash, data }` |
| `ping` | `{}` | `{}` |
| `asset.get` | `{ type: 'avatar', id }` | `{ type, id, mime, data }`（`data` 为 base64，原始大小上限 512KB） |
| `prompt.preview` | `{ input? }` | 见下文「提示词预览」 |

- `kind`：`character`（id 为头像文件名，如 `Alice.png`）、`lorebook`（id 为世界书名称）`regex`（id 只能是 `global`，即酒馆的全局正则 `extension_settings.regex`，数据为 `{ scripts }`；`catalog.list` 只返回这一项并带 `count`）或 `preset`（id 为 `<类型>/<名称>`，类型见 `shared/protocol.js` 的 `PRESET_APIS`，数据为预设文件内容；`catalog.list` 读取全部预设文件名，每项带 `apiId`、`selected`，聊天补全预设带提示词条数 `count`）。插件在 `hello.capabilities.kinds` 中声明支持的类型。
- `regex` 的 `item.put` 只接受 `{ scripts: [对象...] }`；写入后插件按 Cellar Link 设置「同步全局正则后」处理酒馆的正则面板：`lock`（默认）锁住面板里的旧列表并提示，刷新页面或正则面板重绘后解除，不发任何酒馆事件；`event` 发出 `MAIN_API_CHANGED` 让正则扩展立即重绘，其他监听该事件的扩展也会当作切换了 API。面板的每一行按下标绑定渲染时的对象，不处理的话在旧行上操作会把旧正则写回。
- `preset` 的 `item.put` 只接受对象；对象中带 `name` 且与 id 中的名称不同时返回 `bad_request`（不支持改名）。插件通过 `/api/presets/save` 写入、`/api/settings/get` 读回，再更新酒馆内存中的预设列表；写入的是当前选中的预设时触发预设下拉框的 `change` 让酒馆重新加载。
- `catalog.list` 只返回摘要，数据来自酒馆前端内存，不读取全文（预设除外：名称取自 `/api/settings/get`，这样不经酒馆界面放进文件夹的预设也能列出）。
- `item.put` 写入前复核：当前哈希 ≠ `baseHash` 时返回 `conflict`，`details.currentHash` 为酒馆当前哈希。
- `item.put` 的响应是写入后从后端复读的结果，可能与提交的数据不同（宿主规范化），差异以 `warnings` 说明。
- `item.create` 在酒馆中新建资料（Studio「发布到酒馆」）：`character`（`data` 为 V3 卡，用酒馆默认头像）、`lorebook`、`preset`（`data.name` 为名称），不支持 `regex`。同名已存在返回 `conflict`。插件在 `hello.capabilities.create` 中声明支持；旧插件不声明，伴侣程序提示更新插件。离线时伴侣程序直接写数据目录。
- `watch.set` 整体替换监视列表。
- `asset.get` 读取角色头像缩略图，`id` 为头像文件名（不允许路径成分）。Cellar Link 通过酒馆自身的 `getThumbnailUrl('avatar', id)` 读取（ST 与 tt 同一条路径）；离线时伴侣程序读取酒馆生成过的 `thumbnails/avatar/<id>`（不早于卡片时），否则在不超过上限时读取卡片 PNG 本身，从不生成或写入缩略图。旧插件对该消息返回 `bad_request`，Studio 显示首字头像。
- `ping` 是心跳：伴侣程序每 15 秒发送一次，10 秒内没有响应就把该酒馆标记为无响应（`/api/status` 中 `targets[].responsive = false`），之后的请求立即失败（`timeout`），不再逐个等待 30 秒；下一次心跳得到响应时自动恢复。原因是浏览器会冻结后台标签页：WebSocket 仍然连着，但页面脚本不运行。插件在已连接期间持有 Web Lock（`tavern-cellar-link`）以避免被冻结。

### 提示词预览（`prompt.preview`，阶段 5）

插件在 `hello.capabilities.preview` 中声明支持的版本（当前 `1`，`PREVIEW_VERSION`）；伴侣程序把它列在 `/api/status` 的 `targets[].preview`（旧插件为 `0`，预览返回 `bad_request`）。

- 插件对酒馆**当前打开的角色聊天**调用酒馆自己的 `Generate('normal', {...}, dryRun = true)`：不请求模型、不写聊天。预览的始终是酒馆里的内容，工作区未同步的修改不注入（Studio 的「同步并预览」= 先走正常同步再预览）。
- `input`（可选，最长 8000 字）作为酒馆的 quiet prompt 加入，参与世界书扫描，不写聊天。
- 触发条目取自 `WORLDINFO_SCAN_DONE`（dryRun 不发 `WORLD_INFO_ACTIVATED`），最终提示词取自 `GENERATE_AFTER_DATA`；聊天补全的分段与 token 取自酒馆 `promptManager` 的消息集合。
- 酒馆正在生成或另一个预览进行中返回 `busy`；没有打开角色聊天或当前是群聊（暂不支持）返回 `no_chat`。超时 120 秒。

```jsonc
{ "api": "openai", "model": "...",
  "chat": { "character": { "name", "avatar" }, "chatId", "messages": 1 },
  "input": "测试输入",
  "prompt": { "messages": [{ "role", "content", "name"?, "tokens" }],
              "sections": [{ "identifier", "name", "start", "count", "tokens" }] }   // 文本补全为 { "text" }
  "tokens": { "total", "context", "response", "approx"? },
  "worldInfo": { "entries": [{ "world", "uid", "comment", "keys", "constant", "position", "depth", "order", "role", "outletName"?, "content", "tokens" }],
                 "overflowed": false },
  "at": "ISO 时间" }
```

## 5. 插件 → 伴侣程序的事件

| type | payload | 触发 |
|---|---|---|
| `item.changed` | `{ kind, id, hash }` | 监视列表中的项触发了 `CHARACTER_EDITED` / `WORLDINFO_UPDATED`；全局正则在 `SETTINGS_UPDATED` 后且列表确实变化时；预设在 `PRESET_CHANGED` / `SETTINGS_UPDATED` 后且内存中的该预设确实变化时 |

## 6. 错误码

| code | 含义 |
|---|---|
| `unauthorized` | 握手不合法（如 target 描述无效）；随后以 `4401` 关闭连接。HTTP 接口中表示内部令牌 / Origin / Host 不合法 |
| `tavern_disabled` | 伴侣程序关闭了该类酒馆的连接；随后以 `4403` 关闭连接 |
| `protocol_mismatch` | 协议版本不兼容；随后以 `4400` 关闭连接 |
| `bad_request` | 参数不合法 |
| `not_found` | 指定的项不存在 |
| `conflict` | 复核失败，酒馆端已被修改 |
| `host_error` | 酒馆 API 返回错误 |
| `timeout` | 请求超时 |
| `no_chat` | 预览时酒馆里没有打开角色聊天（或是群聊）；HTTP 412 |
| `busy` | 预览时酒馆正在生成 / 已有预览在进行；HTTP 409 |
| `not_connected` | （HTTP 接口）目标酒馆当前未连接 |

## 7. WebSocket 关闭码

| 码 | 含义 | 插件的处理 |
|---|---|---|
| `4400` | 协议不兼容 | 停止重连，提示升级 |
| `4401` | 握手被拒绝 | 停止重连 |
| `4403` | 伴侣程序未接受该类酒馆 | 按最长间隔（60 秒）继续重试，重新启用后自动连上 |
| `4408` | 握手超时 | 正常重连 |
| `4409` | 同一 targetId 有新连接，本连接被替换 | 停止重连 |

## 8. 哈希

`hash = sha256_hex(stableStringify(data))`，`stableStringify` 按键名排序、不含空白，`undefined` 值的键被忽略（与 `JSON.stringify` 一致）。浏览器与 Node 都使用 `crypto.subtle`。

- 角色卡的 `data` 是 `JSON.parse(json_data)`，即 PNG 中保存的规范卡片 JSON（去掉 `json_data` 字段）。
- 世界书的 `data` 是 `/api/worldinfo/get` 返回的对象。

## 9. HTTP 控制接口

所有接口为 `POST`，请求体与响应体为 JSON（`GET /api/status` 除外）。

| 路径 | 请求 | 说明 |
|---|---|---|
| `GET /api/status` | — | 已连接目标、工作区各项及其同步状态 |
| `/api/catalog` | `{ target, kind, query?, offset?, limit? }` | 转发 `catalog.list` |
| `/api/checkout` | `{ target, kind, id }` | 取出到工作区并登记 |
| `/api/sync` | `{ path, target?, force? }` | 工作区 → 酒馆 |
| `/api/pull` | `{ path, target?, force? }` | 酒馆 → 工作区 |
| `/api/auto-sync` | `{ path, target?, enabled }` | 切换随时同步 |
| `/api/unbind` | `{ path, target? }` | 解除一个绑定（文件与酒馆内容都保留） |
| `/api/remove` | `{ path, keepFiles? }` | 从工作区移除一项：忘掉全部绑定、同步状态、基准快照与冲突，不动酒馆；默认删除编解码生成的文件，保留用户自己的文件（`keepFiles: true` 则一个文件都不删）；返回 `{ path, result: 'removed', kept }` |
| `GET /api/assets/avatar?target=&id=` | — | 头像图片本身（供 `<img>` 使用）；按酒馆 + 文件名缓存 10 分钟，酒馆报告该角色被修改时失效；带 `ETag` |
| `/api/preview` | `{ target?, input? }` | 转发 `prompt.preview`（只用实时连接，离线为 `not_connected`）；结果加 `target`，并给 `chat.character` 与每个触发条目附上绑定的工作区 `path`（没有绑定为 `null`） |

`target` 可以是 targetId，也可以是唯一前缀；只连接了一个目标时可省略。
