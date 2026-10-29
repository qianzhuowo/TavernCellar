# Cellar 协议 v1

实现：`shared/protocol.js`。插件与伴侣程序共用该文件中的常量与校验函数。

## 1. 传输

- 伴侣程序监听 `127.0.0.1:<port>`（默认 `7349`）。
- `GET /link` 升级为 WebSocket：供 Cellar Link 使用。
- `/api/*`：HTTP 控制接口，供 CLI 与以后的编辑器使用，需要 `Authorization: Bearer <令牌>`。

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
    "token": "<配对令牌>",
    "target": { "id": "<targetId>", "label": "SillyTavern @ 127.0.0.1:8000", "host": "st", "hostVersion": "1.15.0" },
    "capabilities": { "worldInfoEntryTemplate": { /* 酒馆的 newWorldInfoEntryTemplate */ } }
} }
// 成功响应
{ "ok": true, "payload": { "server": { "name": "TavernCellar", "version": "0.1.0", "protocol": 1 } } }
```

`host` 取值：`st` 或 `tt`（存在 `window.__TAURITAVERN__` 时为 `tt`）。

## 4. 伴侣程序 → 插件的请求

| type | payload | 响应 payload |
|---|---|---|
| `catalog.list` | `{ kind, query?, offset?=0, limit?=50 }` | `{ total, items: [{ id, name, ... }] }` |
| `item.get` | `{ kind, id }` | `{ kind, id, hash, data }` |
| `item.put` | `{ kind, id, data, baseHash }` | `{ kind, id, hash, data, warnings: [] }` |
| `watch.set` | `{ items: [{ kind, id }] }` | `{ count }` |
| `ping` | `{}` | `{ now }` |

- `kind`：`character`（id 为头像文件名，如 `Alice.png`）或 `lorebook`（id 为世界书名称）。
- `catalog.list` 只返回摘要，数据来自酒馆前端内存，不读取全文。
- `item.put` 写入前复核：当前哈希 ≠ `baseHash` 时返回 `conflict`，`details.currentHash` 为酒馆当前哈希。
- `item.put` 的响应是写入后从后端复读的结果，可能与提交的数据不同（宿主规范化），差异以 `warnings` 说明。
- `watch.set` 整体替换监视列表。

## 5. 插件 → 伴侣程序的事件

| type | payload | 触发 |
|---|---|---|
| `item.changed` | `{ kind, id, hash }` | 监视列表中的项触发了 `CHARACTER_EDITED` / `WORLDINFO_UPDATED` |

## 6. 错误码

| code | 含义 |
|---|---|
| `unauthorized` | 令牌错误；随后以 `4401` 关闭连接 |
| `protocol_mismatch` | 协议版本不兼容；随后以 `4400` 关闭连接 |
| `bad_request` | 参数不合法 |
| `not_found` | 指定的项不存在 |
| `conflict` | 复核失败，酒馆端已被修改 |
| `host_error` | 酒馆 API 返回错误 |
| `timeout` | 请求超时 |
| `not_connected` | （HTTP 接口）目标酒馆当前未连接 |

## 7. WebSocket 关闭码

| 码 | 含义 | 插件的处理 |
|---|---|---|
| `4400` | 协议不兼容 | 停止重连，提示升级 |
| `4401` | 令牌错误 | 停止重连，提示检查令牌 |
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

`target` 可以是 targetId，也可以是唯一前缀；只连接了一个目标时可省略。
