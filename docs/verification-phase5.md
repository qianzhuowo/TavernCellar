# 阶段 5 验证记录（提示词预览）

日期：2026-11-04。只用测试角色 `TavernCellar_Test` 与测试世界书 `TavernCellar_Test_WI`；临时给「银松镇」加的关键字 `雾港` 测试后已删除并同步回去（ST 的 `TavernCellar_Test_WI.json` 中不再含 `雾港`）。

## 自动测试

`companion`：130/130 通过。新增 `preview.test.mjs`：

- 预览转发到实时连接，结果附 `target`，角色与触发条目附工作区 `path`（未绑定为 `null`）；`input` 原样转交插件。
- 旧插件（`hello.capabilities` 没有 `preview`）返回 `bad_request`「不支持提示词预览」；插件的 `no_chat` / `busy` 映射为 HTTP 412 / 409。
- 未连接时 `not_connected`。

修复：连接关闭后 `LinkConnection.request` 立即以 `not_connected` 失败，不再等 30 秒超时（测试进程退出慢 30 秒的原因）。

## 实机：SillyTavern 1.15.0（聊天补全）

临时 Edge（CDP 9335），全新工作区 `.tmp/p5-ws`，取出测试角色（连同绑定的测试世界书）。

| 步骤 | 结果 |
|---|---|
| `cellar preview` | 31 个分段（预设提示词、Persona、Char Description、World Info (before)、Chat History…），共 7388 token / 上下文 2,000,000（回复预留 30,000）；触发 1 条：常驻「以太与施法」，带工作区路径 |
| `--input '灰鸦的人来了'` | 另触发「灰鸦佣兵团」；聊天文件哈希不变，`chat.length` 仍为 1 |
| 工作区给「银松镇」加关键字 `雾港` → `cellar sync` → `--input '我们去雾港'` | 触发「银松镇」，并经递归触发两条「龙脊山脉」（共 4 条） |
| Studio 预览页（工作区恢复原关键字后） | 横幅「工作区有 1 项修改还没同步」，主按钮为「同步 1 项并预览」；点击后先同步（状态回到 `in-sync`）再预览 |
| 去掉关键字后 `--input '我们去雾港'` | 只剩常驻条目 |
| 点击预览页的「银松镇」 | 打开世界书编辑器并选中该条目；上次触发的 4 条显示 ✨，底栏「上次预览触发 4 条」 |

## 实机：TauriTavern 2.4.0（聊天补全）

只把 Cellar Link 文件复制到 `<tt 数据目录>\extensions\third-party\TavernCellar`，以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9336` 启动 `tauritavern.exe`。`/api/status` 中 tt 的 `preview` 为 1。

| 步骤 | 结果 |
|---|---|
| `cellar preview --target <tt> --input '灰鸦的人到了银松'` | 2055 token / 上下文 2,000,000（回复预留 40,000）；触发 5 条（以太与施法、灰鸦佣兵团、银松镇、两条龙脊山脉）；tt 的这本书没有绑定工作区，条目不带路径 |
| 聊天 | `chat.length` 仍为 1 |

## Studio

- 活动栏、标签页、快速打开都有「预览」。截图 `docs/studio/preview-dark.png`（只含测试数据：提示词搜索「以太」后只剩 World Info 分段）。
- 修正：分段行的占比条与 token 数靠右对齐；用量条在占比很小时仍可见。
