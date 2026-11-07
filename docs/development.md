# 开发与发布流程

面向维护者。本机路径、本机说明、一键打包更新脚本与私密检查清单只放在被 `.gitignore` 的 `*.local.*` 规则忽略的文件里（分别在 `docs/`、`scripts/` 与仓库根目录），不提交。

## 1. 仓库结构

| 目录 | 内容 |
|---|---|
| 根目录（`manifest.json`、`index.js`、`src/`） | Cellar Link：酒馆插件，作为第三方扩展安装 |
| `companion/` | 伴侣程序（Node ≥ 20），监听 `127.0.0.1:7349`，命令 `cellar` |
| `studio/` | Cellar Studio 前端（Vue + Vite），构建到 `studio/dist/`，由伴侣程序提供 |
| `desktop/` | Electron 外壳，打包安装版与便携版 |
| `shared/` | 插件与伴侣程序共用的协议定义 |
| `scripts/preflight.mjs` | 打包、推送、发布前的检查 |

## 2. 本地开发

```powershell
cd companion; npm install; npm test        # 伴侣程序测试（node --test）
cd studio; npm install; npm run build      # 构建 Studio
node companion/src/cli.js studio           # 启动伴侣程序并打开 Studio
```

- 测试时用隔离的配置目录，不碰日常使用的工作区：`$env:CELLAR_HOME="$PWD\.tmp\<名字>-home"; node companion/src/cli.js serve`。`.tmp/` 已被忽略。
- 实机测试只使用测试数据（角色 `TavernCellar_Test`、世界书 `TavernCellar_Test_WI`，新建的测试项用 `TavernCellar_` 前缀），测完从酒馆与工作区删除。
- 新文件使用 LF 换行（`.gitattributes`：`* text=auto eol=lf`）。

## 3. 打包与本机安装更新

每次打包、覆盖更新已安装版本、把调试版本交给用户之前，先跑第 4 节的检查。

手动流程：

1. `node scripts/preflight.mjs`
2. `cd companion; npm test`
3. `cd studio; npm run build`
4. `cd desktop; npm run dist`，产物在 `desktop/release/`（`win-unpacked/`、`CellarStudio-Setup-<版本>.exe`、`CellarStudio-Portable-<版本>.exe`）
5. 关闭已安装的 Cellar Studio，把 `desktop/release/win-unpacked` 覆盖到安装目录，**不要删除其中的 `workspace/`**（用户工作区）
6. 启动已安装程序，确认加载的是新界面。从 VS Code 终端启动时先清除继承的 `ELECTRON_RUN_AS_NODE`，否则 Electron 会以 Node 模式立即退出。

本机可以用测试脚本（`scripts/` 下的本机打包脚本，不提交）一次完成以上步骤：

```powershell
node scripts/pack-install.local.mjs              # 检查 → 测试 → 构建 → 打包 → 覆盖安装（保留 workspace）→ 复制安装包 → 启动
node scripts/pack-install.local.mjs --tt         # 另外把插件复制到 TauriTavern 的插件目录
node scripts/pack-install.local.mjs --skip-build # 只用已有的 desktop/release/win-unpacked 更新安装
```

## 4. 打包、推送、发布前的必备检查

依次完成：

1. **更新 `.gitignore` 相关文件**：构建产物（`studio/dist/`、`desktop/.stage/`、`desktop/release/`、安装包）、依赖（各处 `node_modules/`）、无关测试文件与测试结果（`.tmp/`、截图、日志、浏览器配置、隔离的 `CELLAR_HOME` 与测试工作区、基准副本）都不能上传。本轮新出现的产物类型要补进规则。
2. **扫描泄露**：对全部已跟踪文件和未忽略的候选文本文件，扫描已知的实机账号、服务器地址、现场路径 / 容器名、真实角色卡名与酒馆实例 id、令牌。
3. **核对忽略与引用完整性**：没有已跟踪文件被忽略规则命中；文档链接与代码相对导入指向的文件都会被推送（指向宿主酒馆源码的引用除外）。

以上由 `node scripts/preflight.mjs` 完成，有问题时以非零码退出：

- 私密字面量（服务器地址、真实卡名、本机目录名等）只写在仓库根目录的 `preflight.local.json`（不提交），格式见脚本头注释。SillyTavern 的 basicAuth 密码与伴侣程序令牌由脚本在本机读取后比对，不会打印出来。
- 脚本列出的“可能泄露”需要逐条人工确认：真实的加入 `literals`，无害且反复出现的加入 `allow`。
- 脚本会列出 `git add -A` 将要加入的未跟踪文件，逐个确认它们应该提交。

## 5. 发布新版本

1. 修改 `desktop/package.json` 的 `version`（例如 `0.2.0`）。
2. 写面向用户的更新说明 `docs/release-notes/v<版本>.md`（见下文）。
3. 跑第 4 节的检查，提交并推送 `main`。
4. 打标签并推送：`git tag v<版本>; git push origin v<版本>`。标签必须与 `version` 一致，否则工作流失败。
5. `.github/workflows/release.yml` 在 Windows 上运行伴侣程序测试、构建 Studio、打包，然后创建 GitHub Release：正文是 `docs/release-notes/v<版本>.md`，后面附上自动生成的变更列表；附件是安装版、便携版以及自动更新要用的 `latest.yml` 与 `.blockmap`。
6. 在 GitHub 上确认 Release 已发布（不是 draft / prerelease，Studio 的「检查更新」只看正式 Release），再用已安装的旧版本试一次「检查更新」。

### 更新说明怎么写

更新说明会显示在 Studio 的「检查更新」里，读者是普通用户，不是开发者：

- 用大白话写**用户能感觉到的变化**：新增了什么、哪里更好用了、修好了哪个问题。不写函数名、文件名、重构细节。
- 每条一句话，以动词开头；重要的放前面。
- 需要用户动手的事单独列出（例如“酒馆里的 Cellar Link 也请更新到最新版”）。
- 没有就省略那一节，不要写“无”。

模板：

```markdown
## 新功能
- 设置里可以「压缩历史」，并在历史超过 50 MB 时自动清理。

## 改进
- 关掉最后一个标签后停在空白的工作区页面，不再跳到资料库。

## 修复
- 修复移除项目后点「工作区」按钮没有反应的问题。

## 升级须知
- 酒馆里的 Cellar Link 请在「扩展 → 管理扩展」中更新到最新版。
```
