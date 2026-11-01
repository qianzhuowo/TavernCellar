# 阶段 4 验证记录（全局正则）

日期：2026-11-01。只新增并删除名为 `TavernCellar_Test` 的测试正则；测试前备份了两边的 `settings.json`。

## 自动测试

`companion`：116/116 通过。新增：

- `codec-regex.test.mjs`：无损往返（CRLF、空替换、未知字段）、文件布局与归属、空列表 / 缺键 / 非列表原样保留、改编号调整顺序、按 id 合并与同一条冲突。
- `regex-sync.test.mjs`：取出 → 改文件 → 酒馆同时停用另一条 → 取回合并 → 同步；资料库只列出 `global`。
- `offline.test.mjs`：离线同步只替换 `extension_settings.regex`，缩进与其他键逐字节不变，有备份。

## 实机：SillyTavern 1.15.0（120 条全局正则）

| 步骤 | 结果 |
|---|---|
| 取出 | `regex/global/` 241 个文件，往返无差异，状态「已同步」 |
| 新增测试正则并同步 | 内存与 `settings.json` 都是 121 条；`settings.json` 只有 `extension_settings.regex` 变化（另有插件自身设置） |
| 锁定模式 | 正则面板旧列表变灰锁定，上方提示「全局正则已由 TavernCellar 更新……」 |
| 酒馆里停用测试正则 | 伴侣程序收到变化；取回后工作区 `disabled: true` |
| 自动刷新模式下删除测试正则并同步 | 面板立即重绘为 120 行，未锁定；`MAIN_API_CHANGED` 触发 1 次，无弹窗 |

恢复后 120 条正则内容与备份一致；每条 `replaceString` 键的位置移到了末尾（见 `workspace-format.md` §5）。

## 实机：TauriTavern 2.4.0（原本没有全局正则）

| 步骤 | 结果 |
|---|---|
| 取出 | `regex/global-2/`，只有 `cellar-item.json` |
| 新增测试正则并同步（锁定模式） | 内存 1 条、磁盘 1 条，面板锁定提示出现 |
| 自动刷新模式下增、删 | 面板随之 1 行 / 0 行，锁定解除（修复：列表为空时重绘不触发 DOM 变化，改为事件处理完后直接解锁） |

结束时 tt 的 `extension_settings.regex` 为 `[]`，其他设置与备份一致（插件设置新增 `regexRefresh`）。

## Studio

- 侧栏「正则」组显示「全局正则 · 酒馆名」；资料库类型切换出现「正则」，列出条数。
- 正则编辑器：左侧按执行顺序列表（停用项划线、开关），右侧字段与 ST 正则编辑器一致，「试一试」本地预览替换结果。截图：`.tmp/p4-regex.png`、`.tmp/p4-library.png`（未放进 docs）。

## 未验证

- 离线写 ST/tt 的 `settings.json` 只做了自动测试，未在实机离线状态下操作。
- 桌面版未重新打包。
