# TavernCellar 开发路线

> 本文是 TavernCellar 的总体开发路线与各组件的预期形态，用于后续开发时对照查阅。
> 细节设计分别见 `docs/architecture.md`、`docs/protocol.md`、`docs/workspace-format.md`、`docs/versioning.md`（第 1 阶段产出）。
> 本文记录的是**方向与约束**；某一阶段真正落地后，以对应的设计文档和验证记录为准，并回到这里更新状态。

- 仓库：<https://github.com/qianzhuowo/TavernCellar>（公开，AGPL-3.0）
- 目标宿主：SillyTavern（下称 ST，源码基线 1.15.0）与 TauriTavern（下称 tt，源码基线 2.4.0）
- 最后更新：2026-10-29

---

## 1. 定位

TavernCellar（酒窖）是给 ST / tt 写卡用的**本地工作区 + 同步桥梁**：

- 把角色卡、世界书（以后还有正则、预设）从酒馆**取出**到本地工作区，拆成适合人读写的文本文件；
- 可以在任意编辑器（VS Code、记事本……）或 TavernCellar 自带的专业编辑器里修改；
- 修改带有类似 JJ 的版本记录，由用户决定**随时同步**还是**手动同步**回指定的酒馆；
- 同一份工作区可以同时对应多个酒馆（例如一个 ST + 一个 tt）。

不做的事：不替代酒馆本身的聊天功能；不做云同步；不改酒馆源码。

---

## 2. 组件

| 组件 | 名称 | 形态 | 职责 |
|---|---|---|---|
| 酒馆内插件 | **Cellar Link** | ST/tt 第三方前端插件（本仓库根目录） | 唯一负责写入酒馆的一方：调用酒馆自身的 `/api/*`、刷新前端状态、监听酒馆内编辑事件、以后负责 dryRun 提示词预览 |
| 伴侣程序 | **TavernCellar**（命令 `cellar`） | Node 本地程序（`companion/`） | WebSocket 服务、工作区管理、卡片 ⇄ 文件的拆分与合并、文件监视、版本管理、冲突比较；酒馆未运行时可离线读写数据文件 |
| 专业编辑器 | **Cellar Studio** | Electron 桌面应用（同一套网页界面也可在浏览器中打开） | 可视化编辑角色、世界书条目、正则、预设；版本历史与差异对比；同步控制面板 |
| VS Code 扩展 | **TavernCellar for VS Code**（可选） | VS Code 扩展（后期） | 在 VS Code 里提供资料树、同步按钮、差异对比、冲突合并 |
| MCP 服务 | （可选） | 伴侣程序附带的 MCP Server（后期） | 让 tt 内置 Agent、VS Code 中的 AI 等通过工具协助写卡 |

关系图：

```
VS Code / 记事本 / Cellar Studio / AI（MCP）
                 │ 编辑
                 ▼
     工作区（git 仓库，位于酒馆数据目录之外）
                 │ 文件监视、拆分合并、版本记录
                 ▼
      伴侣程序 TavernCellar ──WebSocket(127.0.0.1)──► Cellar Link（运行在 ST / tt 页面内）
                                                     ├ 写入：酒馆自身的 /api/*（ST、tt 同一套代码）
                                                     ├ 刷新：getOneCharacter / reloadWorldInfoEditor …
                                                     └ 回传：CHARACTER_EDITED / WORLDINFO_UPDATED …
```

---

## 3. 核心原则（各阶段都必须遵守）

1. **只有 Cellar Link 写酒馆。** 酒馆运行时，伴侣程序绝不直接改酒馆的数据文件。
2. **一条写入路径。** 所有写入都经过酒馆自身的 API，ST 与 tt 共用同一套代码，不为某一个宿主写平行实现。
3. **按需加载。** 目录只取摘要；只有用户取出的项才读全文、才被监视。
4. **绝不静默覆盖。** 每次写入都带 `baseHash`；酒馆端或工作区端任一侧发生了意外变化，就作为冲突交给用户处理。
5. **无损往返。** `导出(导入(x))` 必须与 `x` 深度相等；未识别字段原样保留。
6. **字段定义以酒馆源码为准。** 例如世界书条目以 `newWorldInfoEntryDefinition` 为准，不凭记忆硬编码。
7. **安全默认。** WebSocket 只监听 127.0.0.1，只接受本机酒馆页面的来源（Origin + Host 校验，无需令牌）；不提供执行命令、读写任意路径的能力。
8. **不依赖 ST 服务端插件。** tt 的后端是 Rust，跑不了 Node 服务端插件；两边共同支持的只有前端插件。

---

## 4. 源码事实依据（做出上述设计的原因）

| 事实 | 出处 | 影响 |
|---|---|---|
| 前端在内存里持有角色、世界书，保存时整份覆盖写入 | ST `public/scripts/world-info.js:884` 的 `worldInfoCache`；`src/endpoints/characters.js` 中的 `/edit`；`src/endpoints/worldinfo.js` 中的 `/edit` | 外部改了文件，前端不刷新就会被自动保存覆盖 → 必须由页面内的插件负责刷新 |
| ST 后端角色缓存键为"路径 + mtime" | ST `src/endpoints/characters.js:166` 的 `getCacheKey` | ST 后端能感知外部修改 |
| tt 后端角色缓存键只有文件名，30 分钟过期，不检查 mtime | tt `tt-adapter-storage-userdata/.../file_character_repository/cache.rs`，`mod.rs:94` | 在 tt 运行时直接改 PNG 不可靠 → 必须走 tt 自己模拟的 `/api/characters/edit` |
| tt 没有对外 HTTP 接口，其 MCP 只做客户端 | tt `docs/CurrentState/MCP.md`；`src/tauri/main/routes/*` 在 WebView 内拦截 | 外部进程写不了 tt → 桥梁必须是页面内的插件 |
| tt 的 `csp` 为 `null` | tt `src-tauri/crates/tauritavern/tauri.conf.json` | 插件理论上能连 `ws://127.0.0.1`（待实机确认） |
| tt 模拟了 `characters/get|edit|merge-attributes`、`worldinfo/get|edit`、`presets/save` | tt `src/tauri/main/routes/character-routes.js`、`worldinfo-routes.js`、`settings-routes.js` | 同一套 API 调用在 ST、tt 上都能用 |
| 角色卡数据存在 PNG 的 `chara`（v2）/`ccv3`（v3）文本块中，base64 编码的 JSON；读取时 `ccv3` 优先，写入时两块都写（`ccv3` 只是把同一 JSON 的 `spec` 改为 `chara_card_v3`） | ST `src/character-card-parser.js:15-46` | 离线模式下需要解析 PNG，写回时与酒馆保持同样的双块写法；在线模式下由酒馆 API 返回已解码的 JSON |
| 正则分全局 / 角色 / 预设三种来源 | ST `public/scripts/extensions/regex/engine.js:113-152` | 编辑器必须按来源分开显示，各自走对应的写入方式 |
| 提供提示词组装事件与 dryRun 方式的生成 | ST `public/scripts/events.js`（`CHAT_COMPLETION_PROMPT_READY` 等）、`public/script.js:4062` | 编辑后的测试预览只能由页面内插件完成 |

---

## 5. 开发阶段

状态标记：⬜ 未开始　🟨 进行中　✅ 已完成

### 阶段 1：骨架 + 连接 + 取出/同步最小闭环 🟨

- 仓库骨架：插件（根目录）、`shared/`、`companion/`、`docs/`、`test/`。
- 协议 v1：握手（最初用配对令牌，2026-10-29 改为按来源准入）、`catalog.list`、`item.get`、`item.put`（带 `baseHash`）、`watch.set`、`item.changed`。
- 角色卡与世界书的工作区格式与无损往返编解码。
- 伴侣程序：WS 服务、取出、文件监视、手动同步、命令行。
- Cellar Link：宿主识别（ST/tt）、写入、前端刷新、事件回传、设置面板（地址与自动连接）。
- 实机验证：ST 与 tt 各跑一遍完整闭环，只使用临时测试数据。
- **验收**：在两个宿主上，外部修改文件 → 同步 → 酒馆前端显示新内容；酒馆内修改 → 工作区收到变更；两边都改过时报告冲突而不覆盖。

### 阶段 2：JJ 式版本管理 ⬜

- `VcsBackend` 接口；内置 isomorphic-git，检测到系统 git 时切换使用。
- 保存即记入草稿变更 `@`；写说明 / 打版本标签 / 开始新草稿。
- 每个目标、每一项各有一个已部署指针（`refs/cellar/deployed/<target>/<item>`）。
- 同步模式按"目标 × 资料项"设置：**随时同步** / **手动同步**。
- 支持把某个历史版本同步到酒馆（相当于回滚）。
- 酒馆端改动作为外部变更记录；冲突以标记状态保存，不阻塞操作。
- **验收**：随时同步与手动同步两种模式各自符合预期；已部署指针准确反映各酒馆当前的版本；冲突可见且可解决。

### 阶段 3 前置：拆卡升级与按字段同步 ⬜（排在 Studio S1 之后、编辑器 S2/S3 之前）

借鉴自 tt-card-bridge（2026-10-30 调研）。该项目没有许可证，**只借鉴思路，不复制代码**。各项都必须保持我们的无损往返要求（`encode(decode(x))` 深度相等）。

- ✅ 取回时不再删除用户放在资料项文件夹里的文件（编码器声明自己拥有的文件）。
- ✅ 取出时如果往返有差异，列出具体字段。
- **正则 / 脚本 / 变量拆成单独文件**：角色正则拆成 `regex/NN-名.json` + 替换文本文件，酒馆助手脚本拆成 `scripts/NN-名.json` + `.js`，变量单独一个文件；兼容酒馆助手的几种存储形态。顺序和原始形态记在 meta 里。
- **选择性拆出 + 框架识别提示**：每项可选择拆出哪些部分，没选的留在 `card.json`；切换拆分设置不改变内容哈希。识别 MVU / 小白X / 酒馆助手并提示依赖。
- **条目文件头精简**：和取出时的条目模板相同的字段不写进文件头；模板快照存在资料项里，避免酒馆升级改默认值时内容漂移。
- **角色连同绑定世界书一起取出**：可选把 `extensions.world` 指向的世界书一起取出并编组；内嵌 `character_book` 也拆成条目文件。同一本书被多张卡绑定时引用而不复制。
- **按字段比对与冲突**：基线除了整项哈希，再存一致时的数据快照，按槽位（字段、开场白、条目、正则项……）三方比对。只改了一边的槽位自动合并，冲突只锁住冲突的槽位。合并在伴侣程序里完成，仍然用 `baseHash` 复核后整份写入；槽位划分和编解码器用同一份定义。为 Studio 的冲突处理界面（S4）提供数据。
- **验收**：上述格式变化全部有往返测试；旧格式工作区能自动升级；两边改不同字段时自动合并、改同一字段时只报该字段冲突；ST 与 tt 实机各跑一遍。

### 阶段 3：Cellar Studio 编辑器第一版 🟨（设计中；先于阶段 2 实施）

- 设计与原型：`docs/studio-design.md`、`studio/prototype/`。
- Electron 桌面应用，主进程内运行伴侣程序；界面也可在浏览器中打开（只监听 127.0.0.1）。
- 资料目录（分页、搜索、缩略图懒加载）与"已取出"清单。
- 角色卡表单编辑；世界书条目列表（虚拟列表）、新建/删除/复制条目、调整参数。
- 版本历史、差异对比、同步面板（每个目标显示落后几处修改、一键同步）。
- ✅ 冲突处理页（S4）：按槽位列出两边都改了的地方，逐项选择工作区 / 酒馆 / 手动合并后应用并同步；旧绑定的整项冲突列出两边差异供整项选择。
- 角色卡编辑器（S2）内可下拉绑定主要知识书，并一起取出。
- 世界书条目分组（S3）：组记在条目 `extensions.cellar.group`，工作区中为 `entries/组名/` 子文件夹；同组同插入位置，可整组改位置 / 顺序 / 显示顺序；排序方式与 ST 一致并可按组显示（见 studio-design §4.4）。
- **验收**：不打开任何外部编辑器，也能完成取出 → 编辑 → 记录版本 → 同步。

### 未来：多级分类 ⬜（不急，排在阶段 4 之后）

- 在条目分组的基础上支持二级乃至多级分类，并推广到全部资料：世界书条目、角色卡、世界书本身、预设（及其提示词条目）、正则。
- 约定沿用条目分组：分类是路径字符串（`世界背景/地理/北境`），工作区中对应多级子文件夹，文件夹是唯一来源。
- 待定：资料项级分类（角色卡、整本世界书）存在哪里——只存工作区（`characters/分类/角色/`）还是也写进卡片 / 书以便随酒馆同步；与 ST 的标签、文件夹式标签如何对应；正则和预设条目在酒馆中的顺序有实际效果，分类不能改变它。
- Studio：侧栏工作区树与资料库按分类显示，可拖动归类。

### 阶段 4：正则与预设 ⬜

- 正则三种来源（全局 / 角色 / 预设）分开取出、编辑、同步；全局正则只通过修改内存中的 `extension_settings` 后调用酒馆自身的保存函数来写入，绝不整份写回 `settings.json`。
- 预设：提示词条目、顺序、参数；条目级对比与编辑。
- 跨预设、跨酒馆的条目对比。

### 阶段 5：编辑测试（提示词预览） ⬜

- Cellar Link 调用 dryRun 方式的生成，或监听提示词组装事件，把最终提示词回传。
- 编辑器展示：哪些世界书条目被触发、插入位置、token 数。
- 改完条目后可一键重新预览。

### 阶段 6：周边集成（可选） ⬜

- VS Code 扩展。
- MCP 服务（只开放受控的工具，默认关闭写入权限）。
- 打包发布（伴侣程序的独立可执行文件或安装包）、插件与伴侣程序分开发布。

---

## 6. 伴侣程序预期

- **运行方式**：命令行 `cellar serve [--workspace <dir>] [--port 7349]`；以后可选做托盘程序。
- **配置**：工作区里的 `cellar.json` 保存同步目标与对应关系；伴侣程序自己的配置（端口、接受哪些酒馆、内部控制令牌）存放在用户目录下，不进工作区仓库。
- **工作区**：位于酒馆数据目录之外，默认 `文档/TavernCellar`，本身是一个 git 仓库（也可以和 jj 共用）。
- **在线模式**（酒馆已连接）：所有读写都经过 Cellar Link。
- **离线模式**（酒馆未运行）：直接读写用户指定的单个数据文件（PNG 角色卡、世界书 JSON），只处理被点名的那一项，不扫描整个数据目录。离线写入前必须确认对应酒馆确实没在运行。
- **性能**：只监视已取出的项；目录分页；大世界书分批处理。
- **安全**：只监听 127.0.0.1；按 Origin + Host 准入本机酒馆；工作区路径以外的文件一律不读写。

## 7. Cellar Studio 编辑器预期

- 形态：**Electron 桌面应用**（主进程内运行伴侣程序）；同一套网页界面也可由 `cellar serve` 在浏览器中打开，以后可由 VS Code 扩展以 Webview 方式嵌入。详细设计见 `docs/studio-design.md`。
- 与"在酒馆里编辑"的体验对齐：字段名称、参数含义、默认值与酒馆一致（以源码定义为准）。
- 世界书：新建/删除/复制条目、批量修改参数、按关键字或注释搜索、拖动排序。
- 角色：各字段表单、备用开场白管理、绑定的世界书跳转。
- 正则 / 预设（阶段 4）：条目级差异对比，跨预设、跨酒馆对比。
- 版本：历史时间线、任意两个版本对比、写说明与打标签、按目标同步。
- 预览（阶段 5）：一键 dryRun，查看最终提示词与触发情况。
- 编辑器与外部编辑器操作的是同一份工作区文件，两边改动互相可见。

## 8. VS Code 扩展预期（可选）

- 侧边栏资料树：同步目标 → 已取出项 → 文件。
- 状态栏：连接状态、当前草稿的修改数、各目标落后几处修改。
- 命令：取出、同步、写说明 / 打标签、切换同步模式。
- 差异与冲突：使用 VS Code 自带的差异编辑器与合并编辑器。
- 只作为伴侣程序的客户端（通过同一协议连接），不重复实现同步逻辑。

## 9. 数据类型覆盖计划

| 数据 | ST 存储位置 | 读取 | 写入 | 前端刷新 | 阶段 |
|---|---|---|---|---|---|
| 角色卡 | `characters/*.png` | `/api/characters/get` | `/api/characters/edit` 或 `merge-attributes`（阶段 1 定） | `getOneCharacter` + 表单刷新 | 1 |
| 世界书 | `worlds/*.json` | `/api/worldinfo/get` | `/api/worldinfo/edit` | 清除 `worldInfoCache` + `reloadWorldInfoEditor` | 1 |
| 全局正则 | `settings.json` → `extension_settings.regex` | 前端内存 | 修改内存后调用酒馆的保存函数 | 正则界面重新渲染 | 4 |
| 角色正则 | 角色卡 `data.extensions.regex_scripts` | 同角色卡 | `writeExtensionField` | 同上 | 4 |
| 预设正则 | 预设 extensions → `regex_scripts` | presetManager | `writePresetExtensionField` | 同上 | 4 |
| 预设 | `OpenAI Settings/*.json` 等 | 前端 presetManager | `/api/presets/save` 或 presetManager | 预设界面刷新 | 4 |

（tt 的数据目录布局与 ST 相同，即 `<data_root>/default-user/...`。）

---

## 10. 测试与验证策略

- **单元测试**：`node --test`，覆盖协议校验、哈希、编解码往返；只用合成数据与 ST 自带的默认卡。
- **ST 实机**：临时浏览器配置 + `--remote-debugging-port`，通过 CDP 在页面内执行验证脚本。
- **tt 实机**：只把插件文件复制到 `<tt 数据目录>\extensions\third-party\TavernCellar`；确认 tt 完全退出后（tt 单实例运行），设置 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<端口>` 再启动 `tauritavern.exe`，通过 CDP 验证。
- **测试数据**：实机验证只使用 `TavernCellar_Test` 角色与 `TavernCellar_Test_WI` 世界书，不改动用户已有数据（只读取出除外）。这两项目前保留供后续验证，由用户决定何时删除。
- 每个阶段的验证结果记录在 `docs/verification-phase<N>.md`，并注明哪些没有验证。

## 11. 风险与待定事项

| 项 | 状态 | 说明 / 备选 |
|---|---|---|
| tt WebView 能否连 `ws://127.0.0.1` | 已验证可连（阶段 1，tt 2.4.0） | 备选方案（本机 HTTP 长轮询）不再需要 |
| 角色写入用 `edit` 还是 `merge-attributes` | 已定：`merge-attributes`（tt 已验证，ST 待验证） | 数组整体替换；删除字段无法同步，宿主保留的字段会回写工作区 |
| 刷新当前打开的角色时与酒馆自动保存互相覆盖 | tt 已验证：编辑器打开时同步，表单随之刷新（ST 待验证） | 见 `docs/verification-phase1.md` |
| 插件目录在 ST 的 public 下，`companion/node_modules` 会被当作静态文件提供 | 已知 | 阶段 6 把插件与伴侣程序分开发布 |
| 多用户 ST（非 default-user） | 待定 | 在线模式下由酒馆的登录状态天然隔离；离线模式需要用户指定目录 |
| 酒馆升级后字段变化 | 持续关注 | 字段以源码定义为准；未识别字段原样保留 |

## 12. 决策记录

| 日期 | 决策 |
|---|---|
| 2026-10-28 | 采用"酒馆内插件 + 本地伴侣程序 + 后期编辑器"的架构；不直接改运行中的酒馆数据文件 |
| 2026-10-28 | 另起新仓库，不并入 st-toolbox；不依赖 ST 服务端插件（tt 不支持） |
| 2026-10-28 | 命名：项目/伴侣程序 TavernCellar，插件 Cellar Link，编辑器 Cellar Studio；界面文案使用"同步 / 取出"等常规说法 |
| 2026-10-28 | 版本管理：工作区为 git 仓库，内置 isomorphic-git，检测到系统 git 时切换使用；交互模型参照 JJ |
| 2026-10-28 | 仓库公开：<https://github.com/qianzhuowo/TavernCellar> |
| 2026-10-29 | 许可证：AGPL-3.0-only |
| 2026-10-29 | Cellar Studio 做成 Electron 桌面应用；界面经伴侣程序 HTTP 接口通信（与浏览器 / VS Code 形态同一通路） |
| 2026-10-29 | Studio 先于阶段 2（版本管理）实施；前端用 Vue 3 + Vite |
| 2026-10-29 | 去掉配对令牌：Cellar Link 自动连接，伴侣程序按 Origin + Host 准入；新增本机酒馆检测与 `cellar use st\|tt\|all` |
| 2026-10-30 | 借鉴 tt-card-bridge（无许可证，只借鉴思路）：新增「阶段 3 前置：拆卡升级与按字段同步」，排在 Studio S1 之后、编辑器之前；取回不再删除用户文件 |
