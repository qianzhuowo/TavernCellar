# TavernCellar

在 SillyTavern / TauriTavern 与 VS Code 等外部编辑器之间同步写卡资料（角色卡、世界书）。

- **Cellar Link**（本仓库根目录）：酒馆内的薄插件，作为第三方扩展安装，只负责连接本地伴侣程序并读写酒馆数据。
- **TavernCellar 伴侣程序**（`companion/`）：本地 Node 程序，命令 `cellar`。把资料取出成可读的 Markdown / JSON 文件放进工作区，保存后同步回酒馆，并检测双向冲突。

> 状态：第 1 阶段（连接 + 取出 / 同步最小闭环）。TauriTavern 2.4.0 实机验证已通过，SillyTavern 实机验证待做，见 [docs/verification-phase1.md](docs/verification-phase1.md)。

## 快速开始

需要 Node.js ≥ 20。

**Windows：双击 `Start Cellar Studio.bat`。** 首次运行会自动安装依赖，然后启动伴侣程序并在浏览器中打开 Cellar Studio（`http://127.0.0.1:7349/studio/`）。关闭那个命令行窗口即停止伴侣程序；已在运行时再双击只会重新打开页面。没有设置工作区时使用 `用户目录\TavernCellar`。

> 目前 Studio 页面还是可点击的界面原型（示例数据）。同步功能已可通过下面的命令使用，伴侣程序本身是真实运行的。

命令行：

```bash
cd companion
npm install
node src/cli.js init <工作区目录>   # 创建工作区
node src/cli.js serve               # 只监听 127.0.0.1:7349，启动时显示检测到的酒馆
node src/cli.js studio              # 同上，并在浏览器中打开 Studio
```

酒馆里装好 **Cellar Link** 插件后会自动连接伴侣程序，不需要令牌。`cellar detect` 查看本机的 SillyTavern / TauriTavern 及插件安装情况；`cellar use st|tt|all` 选择接受哪个酒馆的连接。之后：

```bash
node src/cli.js catalog character      # 列出角色（只取摘要）
node src/cli.js checkout character <头像文件名>
node src/cli.js sync <工作区内路径>     # 手动同步；cellar auto <路径> on 开启保存即同步
node src/cli.js pull <工作区内路径>     # 从酒馆拉取
```

完整命令见 `node src/cli.js --help`。

## 文档

- [开发路线](docs/ROADMAP.md)
- [架构](docs/architecture.md) · [连接协议](docs/protocol.md) · [工作区格式](docs/workspace-format.md) · [版本管理](docs/versioning.md)

## 许可证

[GNU AGPL v3.0](LICENSE)
