# 工作区格式 v1

实现：`companion/src/codec/`、`companion/src/workspace/`。

## 1. 目录

```
<工作区>/
├─ cellar.json                 工作区清单（提交进版本库）
├─ .gitignore                  默认忽略 .cellar/
├─ .cellar/                    伴侣程序内部状态（不提交）
│   ├─ state.json              每项、每个目标的基准哈希与冲突状态
│   ├─ templates/worldinfo-entry.json   酒馆提供的世界书条目模板
│   └─ conflicts/<项路径>/<targetId>.json  冲突时保存的酒馆版本
├─ characters/<名称>/          角色卡
└─ lorebooks/<名称>/           世界书
```

`<名称>` 取自头像文件名（去掉 `.png`）或世界书名称，替换 Windows 非法字符；重名时追加 `-2`、`-3`。

**自己的文件可以放在资料项文件夹里。** 伴侣程序只管理下面第 3、4 节列出的文件（角色：`card.json`、`cellar-item.json`、各正文字段 `.md`、`alternate_greetings/NN.md`；世界书：`book.json`、`cellar-item.json`、`entries/*.md`）。从酒馆取回时，它只会删除这些文件中不再需要的那些；`调研.md`、`notes/` 之类的其他文件不会进卡，也不会被删除。注意 `entries/` 下的 `.md` 和 `alternate_greetings/` 下的数字文件名属于卡内容，笔记不要用这些位置。

## 2. cellar.json

```jsonc
{
  "version": 1,
  "targets": {
    "<targetId>": { "host": "st", "label": "SillyTavern @ 127.0.0.1:8000" }
  },
  "items": [
    {
      "path": "characters/Alice",
      "kind": "character",
      "bindings": {
        "<targetId>": { "id": "Alice.png", "autoSync": false }
      }
    }
  ]
}
```

一项可以绑定多个目标（第 1 阶段由取出操作创建绑定，多目标绑定命令放到第 2 阶段）。

## 3. 角色卡

```
characters/Alice/
├─ cellar-item.json            编解码元数据（不要手改）
├─ card.json                   卡片中未拆出的全部字段（含未识别字段、character_book）
├─ description.md              data.description
├─ personality.md              data.personality
├─ scenario.md                 data.scenario
├─ first_mes.md                data.first_mes
├─ mes_example.md              data.mes_example
├─ system_prompt.md            data.system_prompt
├─ post_history_instructions.md data.post_history_instructions
├─ creator_notes.md            data.creator_notes
├─ depth_prompt.md             data.extensions.depth_prompt.prompt（角色备注）
└─ alternate_greetings/
│   ├─ 01.md                   data.alternate_greetings[0]
│   └─ 02.md
├─ regex/                      data.extensions.regex_scripts（角色正则）
│   ├─ 01-美化界面.json        一条正则（不含 replaceString）
│   └─ 01-美化界面.replace.txt 它的 replaceString
├─ scripts/                    酒馆助手脚本
│   ├─ 01-MVU.json             一个脚本（不含 content）
│   └─ 01-MVU.js               它的 content
└─ variables.json              酒馆助手变量
```

规则：
- `.md` 文件的内容就是字段原文，不加标题、不加结尾换行。
- 原卡中不存在的字段不生成文件；删除某个 `.md` 等于从卡片中删除该字段；新建一个对应文件等于新增该字段。
- 备用开场白按文件名中的数字排序；空数组记录在元数据中，以便与“没有该字段”区分。
- V1 顶层镜像字段（`description`、`personality`、`scenario`、`first_mes`、`mes_example`，以及 `creatorcomment` ↔ `data.creator_notes`）：取出时若与 `data.*` 相同，就从 `card.json` 中省略并记录在元数据里，写回时自动与 `data.*` 保持一致；若不同则原样保留在 `card.json` 中。
- 换行：原值不含 `\r` 时，写回前把编辑器产生的 `\r\n` 规范为 `\n`；原值含 `\r` 时原样保留。
- 正则与脚本：文件名 `NN-名称`，**编号决定顺序**，名称只是方便辨认（取自 scriptName / name）。改编号即调整顺序；删掉一对文件即删除该条；复制一对并改编号即新增。`.json` 里仍可修改其他参数（禁用、作用范围等）。
- 酒馆助手有三种存储形态：对象 `tavern_helper: { scripts, variables }`、键值对数组 `tavern_helper: [["scripts", …], ["variables", …]]`、旧版 `TavernHelper_scripts: […]`。取出时记录形态（元数据 `helper`），写回时按原形态还原；`tavern_helper` 中的其他键留在 `card.json`。
- 无法识别的形态（例如数组中有非对象元素、脚本 content 不是字符串）整段原样留在 `card.json`，不拆分。
- 小白X（`xiaobaix-*`）、MVU 变量组等其他扩展字段暂留在 `card.json`。

格式版本：元数据 `codec` 为 2。伴侣程序启动时，把旧版本（`codec: 1`，正则和脚本还在 `card.json` 里）的资料项自动重新拆分；内容不变，哈希和同步状态不受影响。文件暂时无法解析（例如正在编辑到一半）的项会跳过，下次启动再试。

## 4. 世界书

```
lorebooks/MyWorld/
├─ cellar-item.json            编解码元数据：条目顺序等（不要手改）
├─ book.json                   除 entries 外的全部字段（如 originalData、extensions）
└─ entries/
    ├─ 0000-城市设定.md
    └─ 0001-主角.md
```

条目文件：

```markdown
---
uid: 0
key:
  - 王都
  - capital
comment: 城市设定
constant: false
order: 100
position: 0
# ……条目除 content 外的全部字段
---
王都位于大陆中央……
```

规则：
- YAML 头使用 JSON 兼容的写法（`yes`/`no` 不会被当成布尔值），包含条目除 `content` 外的全部字段；`---` 结束行之后的全部内容就是 `content` 原文。
- 文件名只是方便浏览：`<uid 四位补零>-<comment 摘要>.md`。条目的身份以 YAML 头中的 `uid` 为准，改文件名不影响内容。
- **新建条目**：新建一个 `.md` 文件，YAML 头可以不写 `uid` 和其它字段。写回时自动分配 `uid`（当前最大值 + 1），缺少的字段用酒馆提供的条目模板（`newWorldInfoEntryTemplate`）补齐。
- **删除条目**：删除对应文件。
- 条目顺序沿用取出时的顺序，新条目追加在末尾。

## 5. 无损往返

对任意卡片或世界书数据 `x`：`encode(decode(x))` 与 `x` 深度相等。这是测试中的硬性要求（`test/codec-*.test.mjs`）。
