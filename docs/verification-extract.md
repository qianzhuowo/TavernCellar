# 文件提取 / 角色世界书与角色正则页 / 编辑页铺满 验证记录

日期：2026-11-06。只用测试角色 `TavernCellar_Test` 与测试世界书 `TavernCellar_Test_WI`；测试时加的角色正则「Cellar测试正则」已删除并同步回去（tt 中该卡 `extensions.regex_scripts` 恢复为 `[]`，开场白 3 条、内嵌条目 5 条不变）。

## 自动测试

`companion`：133/133 通过（`node --test test/*.test.mjs`）。`layout.test.mjs` 新增与改动：

- 可选部分为 `greetings`、`regex`、`scripts`、`variables`、`character_book`；`setLayout` 拒绝已退役的 `fields`。
- `omitParts` / `restoreParts`：未提取部分从编辑数据中去掉，写回时按原键位补回，往返深度相等。
- 编辑数据读写（`readItemData` 附 `omitted`，`writeItemData` 带回 `omitted`）保留未提取部分。
- 启动迁移：`layout.exclude` 含 `fields` 的旧项升级到 codec 4，去掉 `fields`，内容哈希不变。

Studio：`vite build` 通过。

## 实机：TauriTavern 2.4.0

隔离配置（`CELLAR_HOME=.tmp/x-home`）、全新工作区 `.tmp/x-ws`，`tauritavern.exe` 以 `--remote-debugging-port=9336` 启动；Studio 在 headless Edge 中操作。

| 步骤 | 结果 |
|---|---|
| 资料库抽屉「文件提取」勾选 开场白 + 角色正则 + 角色世界书 → 取出到工作区 | `layout.exclude: [scripts, variables]`；基础字段各自 `.md`；`first_mes.md`、`alternate_greetings/`、`character_book/` 生成；绑定的 `TavernCellar_Test_WI` 自动取出为独立世界书（截图 `docs/studio/extract-drawer-dark.png`） |
| 侧栏 | 角色下出现「世界书 · TavernCellar_Test_WI」「角色正则」两行；角色编辑器顶部分段为「角色 / 世界书 / 角色正则 / 文件」 |
| 点侧栏「世界书 · …」 | 打开角色的「世界书」页：顶部主要知识书选择，下方嵌入世界书编辑器（5 个条目），占满编辑区（截图 `docs/studio/card-world-dark.png`） |
| 「角色正则」页新建一条，填名称与长表达式 | 写入 `regex/01-*.json`；「查找」框自动换行、随内容增高；列表 + 详情占满宽度 |
| 检查栏「同步」 | 1 秒内「已同步」；tt 内存与磁盘中的卡都含这条正则，开场白 / 内嵌条目不变 |
| 删除该正则并同步 | tt 中 `regex_scripts` 回到 `[]` |
| 全局正则、预设（提示词 / 预设正则 / 参数）页，1600 与 1100 宽 | 去掉 860px 限宽，列表 + 详情占满宽高；参数网格铺满，长参数名换行不再压到相邻格 |

## 实机：SillyTavern 1.15.0（headless Edge）

ST 以环境变量 `SILLYTAVERN_BROWSERLAUNCH_ENABLED=false` 启动，不改 `config.yaml`；Cellar Link 即本仓库（ST 的 third-party 目录）。伴侣程序用隔离配置与全新工作区 `.tmp/x-st-ws`；ST 与 Studio 都在 headless Edge 中操作。

| 步骤 | 结果 |
|---|---|
| 抽屉勾选 开场白 + 角色正则 + 角色世界书 → 取出 | 角色与绑定的 `TavernCellar_Test_WI` 一起取出；侧栏子项与「角色 / 世界书 / 角色正则 / 文件」页签出现 |
| 角色正则页新建一条 → 同步 | 「已同步」；ST 内存与磁盘中的卡都含这条正则，开场白 3 条、内嵌条目 5 条不变 |
| 世界书页（嵌入的世界书编辑器）给「银松镇」追加标记 → 同步这本书 | ST 的 `TavernCellar_Test_WI.json` 含标记 |
| 去掉标记、删除正则并分别同步 | ST 中标记消失，`regex_scripts` 回到 `[]` |

测试注意：用 `http://用户:密码@127.0.0.1:8000/` 直接打开 ST 会让前端报 `Cannot access 'SlashCommandParser' before initialization`（含凭据的文档地址与 `location.origin` 解析出的模块地址不同，同一模块被加载两次）。做法：先用带凭据的地址打开 `/favicon.ico` 完成 Basic 认证，再导航到不带凭据的 `http://127.0.0.1:8000/`。

## 安装版

`desktop` 重新打包后静默安装到原目录，`workspace` 保留；启动后提供新版 Studio，工作区中两张角色自动升级到 codec 4。注意：electron-builder 的安装包优先使用注册表里记录的安装位置，路径含空格时 `/D=` 会被截断；从 VS Code 终端启动应用前要清除 `ELECTRON_RUN_AS_NODE`。

## 实机中发现并修复

- **Cellar Link 写角色后报 `characterPayload is not defined`**（`src/link/host.js`，041662c 重命名为 `canonicalCharacter` 时漏改一处）。角色卡其实已经写进酒馆，但同步结果报错，基线不更新，状态停在「本地有修改」。改为 `canonicalCharacter(data, id)` 后同步正常。已装到 tt 数据目录的插件需要更新这个文件。
- `RegexList`：角色卡数据不是响应式对象，新建的第一条正则不显示（缓存的计算属性拿到同一个数组引用）。现在列表、当前项都读取编辑计数。
