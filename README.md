# TavernCellar

在 SillyTavern / TauriTavern 与 VS Code 等外部编辑器之间同步写卡资料（角色卡、世界书）。

- **Cellar Link**（本仓库根目录）：酒馆内的薄插件，作为第三方扩展安装，只负责连接本地伴侣程序并读写酒馆数据。
- **TavernCellar 伴侣程序**（`companion/`）：本地 Node 程序，命令 `cellar`。把资料取出成可读的 Markdown / JSON 文件放进工作区，保存后同步回酒馆，并检测双向冲突。

> 状态：第 1 阶段（连接 + 取出 / 同步最小闭环）。TauriTavern 2.4.0 实机验证已通过，SillyTavern 实机验证待做，见 [docs/verification-phase1.md](docs/verification-phase1.md)。

## 快速开始

需要 Node.js ≥ 20。

```bash
cd companion
npm install
node src/cli.js init <工作区目录>   # 创建工作区并生成配对令牌
node src/cli.js serve               # 只监听 127.0.0.1:7349
```

在酒馆的扩展设置里打开 **Cellar Link**，填入 `cellar token` 显示的令牌后即可连接。之后：

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
