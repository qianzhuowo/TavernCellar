# 工作区格式 v1

实现：`companion/src/codec/`、`companion/src/workspace/`。

## 1. 目录

```
<工作区>/
├─ cellar.json                 工作区清单（进入版本记录）
├─ .git/                       版本记录（伴侣程序第一次打开时创建，见 docs/versioning.md）
├─ .gitattributes              `* -text`：git 不改换行
├─ .gitignore                  默认忽略 .cellar/
├─ .cellar/                    伴侣程序内部状态（不进版本记录）
│   ├─ state.json              每项、每个目标的基准哈希与冲突状态（`version: 2`；从 1 升级时去掉角色基准快照和 card.json 里的酒馆自有字段 `chat`，基准哈希随之更新）
│   ├─ base/<项路径>/<targetId>.json      两边一致时的数据快照（按槽位合并用）
│   ├─ templates/worldinfo-entry.json   酒馆提供的世界书条目模板
│   └─ conflicts/<项路径>/<targetId>.json  冲突时保存的酒馆版本
├─ characters/<名称>/          角色卡
├─ lorebooks/<名称>/           世界书
├─ regex/global/               全局正则（每个酒馆一份，第二个起为 global-2 …）
├─ presets/<类型>-<名称>/      预设（如 presets/openai-Default）
└─ <项目>/<名称>/              放在项目文件夹里的资料项（第 8 节）
```

资料项始终是两段路径 `<顶层文件夹>/<名称>`：顶层文件夹是本类的默认文件夹（上面四个）或一个项目文件夹。一项是什么类型只看 `cellar.json` 中的 `kind`（以及它的 `cellar-item.json`），不看所在文件夹。

`<名称>` 取自头像文件名（去掉 `.png`）或世界书名称，替换 Windows 非法字符；重名时追加 `-2`、`-3`（项目文件夹里先试 `（世界书）` 这样的类型后缀，见第 8 节）。一项移走后留下的旧路径（`formerPaths`）也算已占用，新项不会拿到它——否则两项的历史会混在一起。

**自己的文件可以放在资料项文件夹里。** 伴侣程序只管理下面第 3、4 节列出的文件（角色：`card.json`、`cellar-item.json`、各正文字段 `.md`、`alternate_greetings/NN.md`；世界书：`book.json`、`cellar-item.json`、`entries/*.md`）。从酒馆取回时，它只会删除这些文件中不再需要的那些；`调研.md`、`notes/` 之类的其他文件不会进卡，也不会被删除；「从工作区移除」（`cellar remove`、Studio 检查栏）同样只删这些文件，文件夹里还有别的文件时保留文件夹。注意 `entries/` 下的 `.md` 和 `alternate_greetings/` 下的数字文件名属于卡内容，笔记不要用这些位置。

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

一项可以绑定多个目标：取出时创建绑定，也可以在 Studio 的同步矩阵中绑定到其他酒馆（`POST /api/bind`）。

移动过的项多一个 `"formerPaths": ["characters/Alice", …]`：它以前的路径，最早的在前。版本历史靠它找到移动前记下的版本（`docs/versioning.md` §1）。

把某个版本推送到一个酒馆后，那个绑定多一个 `"pin": "<版本编号>"`，表示该酒馆固定在这个版本；没有 `pin` 就是跟随最新。
规则见 `docs/versioning.md` §3。

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
├─ variables.json              酒馆助手变量
└─ xiaobaix/                   小白X（LittleWhiteBox）
    ├─ tasks/01-开场.json       一个定时任务（data.extensions.xiaobaix-tasks.tasks，不含 commands）
    ├─ tasks/01-开场.txt        它的 commands（脚本）
    ├─ template.json           data.extensions.xiaobaix-template（不含 template）
    ├─ template.html           它的 template
    └─ variables.json          data.extensions.LittleWhiteBox
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
- 酒馆助手与小白X的数据**只在非空时**拆出：空脚本列表、空变量对象、空模板不生成文件，原样留在 `card.json`。小白X 无法识别的形态同样留在 `card.json`；`xiaobaix-tasks` 中 `tasks` 以外的键也留在那里。
- MVU 变量组等其他扩展字段留在 `card.json`。
- **文件提取**：角色的基础文本字段（角色描述、角色设定、创作者的注释等 `.md`）始终各自成文件；下列部分可选提取：`greetings`（开场白：`first_mes.md` 与 `alternate_greetings/`）、`regex`、`xiaobaix`（小白X脚本及变量）、`helper`（酒馆助手脚本及变量）、`character_book`。状态中角色资料项的 `parts` 列出卡中实际有数据的可选部分（`xiaobaix` / `helper`），Studio 只为这些显示勾选项。`cellar.json` 中资料项的 `layout.exclude` 列出**未提取**的部分，它们留在 `card.json` 里；没有 `layout` 的旧资料项等于全部提取。可在取出时指定（`POST /api/checkout` 的 `exclude`，命令行 `checkout --keep`），也可之后修改（`POST /api/layout { path, exclude }`，`cellar layout`）。修改只重排文件，内容哈希不变；若会变则拒绝并恢复原布局。
  - 编辑器只加载提取的部分：`GET /api/item` 返回的 `data` 不含未提取部分，另附 `omitted`（被省略的路径）；`PUT /api/item` 带回 `omitted`，伴侣程序从磁盘上的完整卡按原键位补回这些部分再写入。未提取的内容同步时原样保留。
  - 运行时生效的是 `data.extensions.world` 绑定的世界书（ST 保存角色时从它生成 `character_book` 副本）。Studio 提取「角色世界书」时把绑定的书作为独立世界书资料项一起取出，在角色的「世界书」页编辑。
- **框架识别**：取出结果和状态中的 `frameworks` 列出卡依赖的脚本框架（酒馆助手、MVU、小白X）及依据，用于提示“这张卡需要在酒馆中安装哪些插件”。
- **内嵌世界书**（`data.character_book`）：每个条目拆成 `character_book/[<分组>/]NNNN-<comment>.md`（YAML 头为除 `content` 外的字段，正文为 `content`），编号决定顺序；`character_book/` 下的子文件夹对应条目的 Cellar 分组 `extensions.cellar.group`（规则同第 4 节「分组」）；书的其他字段留在 `card.json`。条目形态无法识别时整本留在 `card.json`。可用 `layout.exclude` 的 `character_book` 保留在 `card.json`。
- **连同绑定世界书取出**：取出角色时传 `withWorld: true`，会把 `data.extensions.world` 指向的世界书一起取出；该书若已从同一酒馆取出则直接引用，不重复取出。关联不单独保存：状态中的 `world: { name, path }` 每次从卡的内容推导，`path` 为 null 表示绑定的书不在工作区。

格式版本：元数据 `codec` 为 5。伴侣程序启动时把旧版本的资料项自动重新排布（`codec: 1` 的正则和脚本还在 `card.json` 里；`codec` 3 及以前的 `layout.exclude` 可含已取消的 `fields`，升级时去掉，基础文本字段重新各自成文件；`codec` 4 的 `scripts` 改为 `helper`、`variables` 去掉，并加入 `xiaobaix`——小白X数据在用户勾选前仍留在 `card.json`）；内容不变，哈希和同步状态不受影响，失败则回滚。文件暂时无法解析（例如正在编辑到一半）的项会跳过，下次启动再试。

## 4. 世界书

```
lorebooks/MyWorld/
├─ cellar-item.json            编解码元数据：条目顺序等（不要手改）
├─ book.json                   除 entries 外的全部字段（如 originalData、extensions）
└─ entries/
    ├─ 0000-城市设定.md
    ├─ 0001-主角.md
    └─ 世界背景/               分组：子文件夹就是条目的 Cellar 分组
        └─ 地理/
            └─ 0003-龙脊山脉.md   extensions.cellar.group = "世界背景/地理"
```

条目文件：

```markdown
---
uid: 0
key:
  - 王都
  - capital
comment: 城市设定
order: 250
# ……只写和条目模板不同的字段（uid、key、comment 总是写出）
---
王都位于大陆中央……
```

规则：
- YAML 头使用 JSON 兼容的写法（`yes`/`no` 不会被当成布尔值）；`---` 结束行之后的全部内容就是 `content` 原文。
- **文件头精简**：取出时把酒馆的条目模板（`newWorldInfoEntryTemplate`）存一份快照到元数据 `template`。和快照相同的字段不写进 YAML 头；写回时按快照补回。快照只在第一次取出时生成，之后不随酒馆升级改变，所以酒馆改了默认值也不会惄悄改变条目内容。
- 从 YAML 头删掉一个字段 = 改回模板值（不是从条目中删除该字段）。条目原本就没有的模板字段记录在元数据 `absent` 中，写回时不会被补上。
- 没有模板快照时（酒馆尚未提供模板），YAML 头包含条目除 `content` 外的全部字段。
- 文件名只是方便浏览：`<uid 四位补零>-<comment 摘要>.md`。条目的身份以 YAML 头中的 `uid` 为准，改文件名不影响内容。
- **新建条目**：新建一个 `.md` 文件，YAML 头可以不写 `uid` 和其它字段。写回时自动分配 `uid`（当前最大值 + 1），缺少的字段用模板快照补齐（没有快照时用酒馆当前的模板）。
- 格式版本：元数据 `codec` 为 2；旧版本的世界书在伴侣程序启动时自动重新生成文件（内容不变）。
- **删除条目**：删除对应文件。
- 条目顺序沿用取出时的顺序，新条目追加在末尾。
- **分组**：条目的 Cellar 分组记在条目字段 `extensions.cellar.group`（路径字符串，`/` 分级），在工作区中表示为 `entries/` 下的子文件夹，文件夹是唯一来源（YAML 头中不再出现该字段，`extensions`/`cellar` 因此变空时也不写出）。把文件移到别的文件夹 = 换组，移回 `entries/` 根下 = 取消分组。同时在文件夹和 YAML 头中写分组会报错，不会擅自取舍。组名不能作为文件夹名时（含 Windows 不允许的字符、首尾空格、`.`/`..`、空段），该条目留在根下，分组照原样写在 YAML 头中。酒馆不认识这个字段，只原样保存（ST 界面编辑、复制、移动条目都会保留它）。

## 5. 全局正则

酒馆设置 `settings.json` 中的 `extension_settings.regex`。资料项 `kind: "regex"`，`id` 固定为 `global`，数据为 `{ scripts: [...] }`（酒馆里还没有这个键时为 `{}`）。

```
regex/global/
├─ cellar-item.json                 编解码元数据（不要手改）
├─ 001-<scriptName>.json            一条正则，除 replaceString 外的全部字段
└─ 001-<scriptName>.replace.txt     它的 replaceString
```

- 规则与角色卡里的正则相同（第 3 节）：**编号决定顺序**，名称只为辨认；删掉一对文件即删除该条，新建一对即新增。
- `scripts` 不是对象列表时整份原样记在 `cellar-item.json`，不拆文件，Studio 也不提供编辑。
- 按槽位合并：每条正则按 `id` 一个槽位，顺序单独一个槽位（与角色正则相同），两边改了不同的正则会自动合并。
- 写入（Cellar Link）：复核 `baseHash` → 赋值 `extension_settings.regex` → 酒馆自身的 `saveSettingsDebounced()` → 等 `SETTINGS_UPDATED` → 通过 `/api/settings/get` 读回 `settings.json` 复核。只改这一个键，与正则扩展自己保存全局正则的路径相同。
- 写入（离线）：只替换 `settings.json` 中的 `extension_settings.regex`，保留文件原有的缩进（ST 4 空格、tt 2 空格）、换行和其他键，先备份再原子写入。
- 键顺序：拆出的 `replaceString` 不在对象末尾时，`cellar-item.json` 的 `textPos` 记下它原来的位置，写回时放回原处（角色正则、预设提示词同理）。

## 6. 预设

酒馆数据目录中 `<预设文件夹>/<名称>.json` 的内容。资料项 `kind: "preset"`，`id` 为 `<类型>/<名称>`，类型与文件夹：

| 类型 | 文件夹 | Studio 名称 |
|---|---|---|
| `openai` | `OpenAI Settings` | 聊天补全 |
| `textgenerationwebui` | `TextGen Settings` | 文本补全 |
| `kobold` | `KoboldAI Settings` | KoboldAI |
| `novel` | `NovelAI Settings` | NovelAI |
| `instruct` / `context` / `sysprompt` / `reasoning` | 同名文件夹 | 指令模板 / 上下文模板 / 系统提示词 / 推理格式 |

聊天补全预设拆开，其他类型是扁平的参数文件，整份放在 `preset.json`：

```
presets/openai-<名称>/
├─ cellar-item.json                 编解码元数据（类型、原始顺序等，不要手改）
├─ preset.json                      除下面两组之外的全部参数（含 prompt_order）
├─ prompts/001-<name>.json          一条提示词，除 content 外的字段
├─ prompts/001-<name>.md            它的 content（标记类提示词没有）
├─ regex/01-<scriptName>.json       预设正则（extensions.regex_scripts），与角色正则相同
└─ regex/01-<scriptName>.replace.txt
```

- 提示词在 `prompts` 中的顺序就是文件编号；实际发送顺序由 `preset.json` 里的 `prompt_order` 决定（全局为 `character_id: 100001`）。
- 按槽位合并：提示词按 `identifier`、`prompt_order` 按 `character_id`、预设正则按 `id`，其余参数每个顶层键一个槽位。
- 写入（Cellar Link）：复核 `baseHash` → 酒馆的 `/api/presets/save`（不经过预设管理器的保存函数，避免它弹窗或转换格式）→ `/api/settings/get` 读回复核 → 更新酒馆内存中的预设列表。写入的是酒馆当前选中的预设时，酒馆会重新加载它，界面上未保存的修改会丢失。
- 写入（离线）：直接写预设文件，保留原有缩进（ST 4 空格，tt 2 或 4 空格）、换行、BOM 与结尾换行；备份在 `preset-<类型>`。ST 自带的少数 NovelAI 默认预设是手排的（数组写在一行），离线写入后按标准缩进展开，值不变——ST 自己保存时也会这样。
- 资料库列出数据目录中的全部预设文件，标出酒馆当前使用的那个。
- 不支持改名、新建、删除（在酒馆里做）。

## 7. 无损往返

对任意卡片、世界书、全局正则或预设数据 `x`：`encode(decode(x))` 与 `x` 深度相等。这是测试中的硬性要求（`test/codec-*.test.mjs`）。

### 预设工坊收藏 `workshop/prompts.json`

不属于任何资料项的工作区文件，随工作区一起进入版本历史。内容为 `{ version: 1, prompts: [{ id, title, from, savedAt, enabled, prompt }] }`，`prompt` 是收藏时预设中那条提示词的完整对象。读写：`POST /api/workshop/collection` 返回 `{ collection, hash }`；`PUT /api/workshop/collection { collection, hash }` 在文件已被别处修改时拒绝（`conflict`）。

## 8. 项目文件夹、移动、改名与导入

一张卡和它的世界书可以放进同一个项目文件夹，不必分在 `characters/` 和 `lorebooks/` 两处：

```
诡异复苏/
├─ 诡异复苏/              角色卡
├─ 诡异复苏（世界书）/      它的世界书（与卡重名，所以加了类型后缀）
└─ 设定笔记.md              不属于任何项的文件也可以放这里（不是资料项，不同步）
```

- **仅限工作区内**。工作区外的文件夹不能作为项目：版本历史、文件监视、撤回、备份都以工作区根目录为界。外面的文件夹用「导入」复制进来。
- **项目名**：一段合法的文件夹名（规则同 `<名称>`），不能以 `.` 开头，不能是 `workshop`，也不能是别的类型的默认文件夹（把角色卡放进 `lorebooks/` 会报错）。填本类的默认文件夹名或不填 = 默认文件夹。已有的项目文件夹沿用它原来的大小写。
- **命名**：同一条规则用于取出、新建、移动和导入：先试 `<项目>/<名称>`；被占用时在项目文件夹里试 `<名称>（角色卡 | 世界书 | 预设 | 正则）`，再不行追加 `-2`、`-3`。未绑定酒馆的项，将来发布时的名称去掉这个后缀（`诡异复苏（世界书）` 发布后叫 `诡异复苏`）。
- **取出 / 新建到项目**：`POST /api/checkout`、`POST /api/create` 的可选参数 `folder`（CLI `--folder <项目>`）。带出的世界书（`withWorld`、`world`）放进同一个文件夹；已经在工作区里的世界书不动。
- **移动**：`POST /api/move { path, folder }`（CLI `cellar move <项路径> [项目]`，不写项目 = 移回默认文件夹）返回 `{ path, from, result: "moved" | "unchanged" }`。整个文件夹改名（自己的笔记文件一起走），清单路径、同步状态、基准快照、冲突保存的酒馆版本、撤回记录、部署/来源/标签引用都跟着走，旧路径记入 `formerPaths`。移动要么整个完成、要么什么都不改：先迁版本引用（失败即拒绝），再移文件夹（失败则把引用迁回）。有未解决的冲突也可以移动，冲突随项一起走。绑定的酒馆条目不变（移动不是改名）。一个项目文件夹的最后一项移走后，空文件夹被删除。
- **改名**（`POST /api/rename`，见 architecture.md §3「改名」）：酒馆里改名后，绑定的 id 换成新的头像文件名 / 世界书名。文件夹名按上面的命名规则等于旧名称（`<名称>` 或 `<名称>（<类型>）`）时，在同一个顶层文件夹里按同一规则换成新名称，和移动一样跟走一切（旧路径记入 `formerPaths`）；带 `-2` 后缀或用户自己起的文件夹名不动。
- **导入**：`POST /api/import { source, folder }`（CLI `cellar import <源文件夹> [--folder 项目]`）把磁盘上任意位置的 Cellar 格式文件夹**复制**进工作区（不链接）。`source` 自己含 `cellar-item.json` 时是一项，否则它的直接子文件夹各是一项；`source` 不能在工作区里，也不能包含工作区。项目名默认取源文件夹的名字。每项先按它的 `kind` 编码一遍，失败的不登记、在结果里报告；其余按上面的命名规则复制（跳过 `.git` 等忽略的文件），登记为未绑定的项，然后可以像新建的项一样发布。返回 `{ folder, items: [{ source, path, kind } | { source, error }] }`。
