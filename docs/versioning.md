# 版本管理设计（第 2 阶段，尚未实现）

本文是第 2 阶段的设计草案。第 1 阶段只使用 `.cellar/state.json` 中的基准哈希判断同步状态；第 2 阶段用本文的模型取代它。

## 1. 存储

- 工作区本身就是一个 git 仓库（`cellar init` 创建）。会用 jj 的用户可以执行 `jj git init --colocate`，与本工具共用。
- 后端接口 `VcsBackend`：

```ts
interface VcsBackend {
  snapshot(message?: string): Promise<Rev>;      // 把工作区当前状态记入草稿变更
  describe(message: string): Promise<Rev>;       // 给草稿写说明
  newChange(): Promise<Rev>;                     // 结束当前草稿，开始一个新的空草稿
  tag(name: string, rev: Rev): Promise<void>;    // 版本标签，如 v1.2
  log(path?: string, limit?: number): Promise<Change[]>;
  readTree(rev: Rev, path: string): Promise<Map<string, string>>;  // 读取某版本中某项的全部文件
  setRef(name: string, rev: Rev): Promise<void>; // 已部署指针
  getRef(name: string): Promise<Rev | null>;
}
```

- 默认实现基于 `isomorphic-git`（纯 JS，用户无需安装 git）。启动时执行 `git --version`，成功则切换为调用系统 git 的实现。两种实现使用同一个仓库格式，可以随时互换。
- 工作区 `.gitattributes` 写入 `* -text`，避免 git 在 Windows 上自动改动换行。

## 2. JJ 式交互模型

| 概念 | 实现 |
|---|---|
| 草稿变更 `@` | 一个特殊分支 `cellar/wip` 上的提交。每次文件保存（去抖后）用 amend 的方式更新这个提交，所以历史中不会出现大量零碎提交 |
| 写说明 | 修改 `@` 的提交说明 |
| 开始新草稿 | 以当前 `@` 为父提交，创建一个新的空提交作为新的 `@` |
| 版本标签 | git tag |
| 已部署指针 | `refs/cellar/deployed/<targetId>/<项路径>`，指向该项最后一次同步到该目标的版本 |
| 外部变更 | 酒馆端的修改被拉取时，自动在 `@` 之前插入一个说明为“来自 <目标>”的提交 |
| 冲突 | 两边都改过时，`@` 中保存工作区版本，同时在 `.cellar/conflicts/` 中保存酒馆版本，状态标记为冲突；用户选择保留哪一边或手动合并后解除 |

## 3. 同步模式（按“目标 × 资料项”设置）

- **随时同步**：保存 → 更新 `@` → 立即推送到该目标 → 已部署指针指向 `@`。
- **手动同步**：保存 → 更新 `@`。界面显示“该目标落后 N 处修改”（已部署指针到 `@` 之间的差异）；用户点“同步”才推送。
- **同步历史版本**：把某个历史版本的文件编码后推送到酒馆，已部署指针指向该版本（相当于回滚，工作区文件不变）。

## 4. 与第 1 阶段的衔接

- 第 1 阶段的基准哈希 = 已部署指针所指版本中该项的编码哈希。升级时为每个绑定创建一个初始提交与已部署指针。
- 第 1 阶段 `.cellar/state.json` 中的冲突记录原样迁移。
