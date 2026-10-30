/* Fictional sample data for the Cellar Studio prototype. */
(function () {
  const taverns = [
    { id: 'st', short: 'ST', name: '我的 SillyTavern', type: 'SillyTavern', version: '1.15.0', connected: true, origin: 'http://127.0.0.1:8000' },
    { id: 'tt', short: 'tt', name: 'TauriTavern', type: 'TauriTavern', version: '2.4.0', connected: false, origin: 'http://tauri.localhost', lastSeen: '昨天 22:41' }
  ];

  /* status: synced | local | remote | conflict | unbound | closed. Offline taverns still have a REAL status
     (computed from their data folder); the offline marker is added at render time (Detect.badge). */
  const items = [
    { id: 'eirin', kind: 'character', name: '艾琳·霜语', path: 'characters/艾琳·霜语/', hue: 205,
      status: { st: 'conflict', tt: 'synced' }, auto: { st: false, tt: true },
      modified: '2 分钟前', size: '18.4 KB' },
    { id: 'frost', kind: 'lorebook', name: '霜语大陆设定', path: 'worlds/霜语大陆设定/', hue: 30,
      status: { st: 'local', tt: 'local' }, auto: { st: false, tt: false },
      modified: '刚刚', size: '64.0 KB',
      warning: { text: '酒馆保留了已删除的字段', paths: ['entries.12.extensions.cssStyle', 'entries.27.automationId'] } },
    { id: 'moheng', kind: 'character', name: '墨衡', path: 'characters/墨衡/', hue: 150,
      status: { st: 'remote', tt: 'remote' }, auto: { st: true, tt: false },
      modified: '昨天 19:02', size: '9.7 KB' }
  ];

  const eirin = {
    name: '艾琳·霜语', fav: true,
    tags: ['奇幻', '冰系法师', '冷淡', '长篇'],
    avatar: { text: '艾', hue: 205 },
    description:
      '{{char}} 是霜语大陆北境"白塔"最年轻的冰系首席法师，二十四岁，银白长发总是用一根旧木簪随意挽起。她说话简短、语气平淡，习惯先观察再开口，很少直视别人的眼睛——并非傲慢，而是多年独自研究让她不太懂得如何与人相处。\n\n' +
      '她在三年前的"长夜之冬"中失去了导师，从此独自守护白塔的藏书库。她对知识近乎偏执，会为一本残缺的古籍熬上三个通宵，却常常忘记吃饭。\n\n' +
      '外表冷淡，内心其实细腻而敏感。若有人真心关心她，她会别扭地用"顺手"做的小事回报，比如在对方窗台上留一朵不会融化的冰花。',
    first_mes:
      '*白塔顶层的藏书库里只有壁炉偶尔噼啪作响。{{char}} 坐在堆满古籍的长桌后，头也不抬地翻过一页。*\n\n' +
      '"……门没锁，不代表可以随便进来。"\n\n' +
      '*她终于抬起眼，淡蓝色的瞳孔里映着跳动的火光，打量了 {{user}} 片刻。*\n\n' +
      '"算了。既然来了，就把门关上——冷风会吹乱书页。你找我有什么事？"',
    alternate_greetings: [
      '*雪下得很大。{{user}} 在山道上几乎迷路时，一盏蓝色的冰灯忽然在前方亮起。*\n\n"跟着灯走。别回头，暴风雪里有东西在听。"',
      '*集市上，{{char}} 正和书商为一本残卷讨价还价，声音依旧平淡，却寸步不让。*\n\n"三枚银币，最多。你知道这本书缺了七页。"*她余光瞥到 {{user}}，*"……你也对古籍感兴趣？"',
      '*深夜，白塔的警钟响了三声。{{char}} 披着外袍冲下楼梯，与 {{user}} 撞了个正着。*\n\n"别站着发愣，北门的结界破了。会用剑吗？会就跟上。"'
    ],
    system_prompt: '{{original}}\n\n写作时保持克制的叙述节奏，以环境与动作描写传达 {{char}} 的情绪，避免直接说明她的内心。',
    post_history_instructions: '保持 {{char}} 简短、平淡的说话方式；每次回复不超过四段。',
    personality: '冷静、寡言、对知识执着；不擅长表达关心，但非常可靠。',
    scenario: '北境白塔，长夜之冬过去三年后的初雪季。{{user}} 是前来白塔求助的旅人。',
    mes_example:
      '<START>\n{{user}}: 你一直一个人住在这里吗？\n{{char}}: "藏书不会吵闹。"*她把茶杯推过去，*"……喝吧，暖手。"\n<START>\n{{user}}: 谢谢你救了我。\n{{char}}: "顺路而已。"*耳尖却微微泛红。*',
    depth_prompt: { prompt: '[{{char}} 最近在追查导师失踪前留下的笔记]', depth: 4, role: 'system' },
    creator: '雪杉', character_version: '1.3.0',
    creator_notes: '推荐搭配世界书「霜语大陆设定」使用。慢热向，前期请耐心。',
    talkativeness: 0.4,
    world: '霜语大陆设定',
    extras: [
      ['extensions.regex_scripts', '2 条正则脚本'],
      ['extensions.chub', '{ "full_path": "…", "id": 0 }'],
      ['extensions.tavern_helper', '{ "scripts": […] }'],
      ['spec / spec_version', 'chara_card_v3 / 3.0']
    ]
  };

  const moheng = {
    name: '墨衡', fav: false, tags: ['古风', '谋士', '腹黑'], avatar: { text: '墨', hue: 150 },
    description: '{{char}} 是南岭书院的年轻山长，表面温和儒雅，实则心思缜密、步步为营。他擅长棋道与筹算，总能在闲谈间把人引入自己的局中。',
    first_mes: '*竹影摇曳，{{char}} 执一枚白子，迟迟未落。*\n\n"来得正好。这局棋，我一个人下了三日——你来替黑子走一步如何？"',
    alternate_greetings: ['*书院钟声刚过，{{char}} 合上卷宗，抬眼一笑。*\n\n"你迟到了一刻钟。说吧，这次又惹了什么麻烦？"'],
    system_prompt: '', post_history_instructions: '', personality: '温和、缜密、腹黑。',
    scenario: '南岭书院，春试前夕。', mes_example: '', depth_prompt: { prompt: '', depth: 4, role: 'system' },
    creator: '雪杉', character_version: '0.9.2', creator_notes: '', talkativeness: 0.6, world: '', extras: []
  };

  /* ---------------- Lorebook entries (generated) ---------------- */
  const seeds = [
    ['霜语大陆 · 总览', ['霜语大陆', '大陆'], 'const'],
    ['北境白塔', ['白塔', '白塔法师'], 'key'],
    ['长夜之冬', ['长夜之冬', '长夜'], 'key'],
    ['冰系魔法体系', ['冰系', '冰魔法', '/霜(术|咒)/'], 'key'],
    ['艾琳的导师 · 赛隆', ['赛隆', '导师'], 'key'],
    ['南岭书院', ['南岭', '书院'], 'key'],
    ['银松镇', ['银松镇'], 'key'],
    ['灰烬王庭', ['灰烬王庭', '王庭'], 'key'],
    ['霜狼部落', ['霜狼', '部落'], 'key'],
    ['星辉教会', ['教会', '星辉'], 'vec'],
    ['货币与物价', ['银币', '金币', '铜板'], 'key'],
    ['北门结界', ['结界', '北门'], 'key'],
    ['藏书库禁区', ['禁区', '禁书'], 'key'],
    ['冰灯', ['冰灯'], 'key'],
    ['旅人公会', ['公会', '委托'], 'key'],
    ['暴风雪中的低语', ['低语', '暴风雪'], 'vec'],
    ['四季与历法', ['历法', '季节', '初雪季'], 'const'],
    ['魔力潮汐', ['魔力潮汐', '潮汐'], 'key'],
    ['古代遗迹 · 沉钟', ['沉钟', '遗迹'], 'key'],
    ['雾海航线', ['雾海', '航线'], 'key'],
    ['商人 · 卡洛', ['卡洛'], 'key'],
    ['骑士团 · 晨铁', ['晨铁', '骑士团'], 'key'],
    ['禁忌：时间魔法', ['时间魔法', '/回溯|时停/'], 'key'],
    ['饮食习惯', ['食物', '料理', '炖菜'], 'key'],
    ['北境方言', ['方言', '口音'], 'vec'],
    ['冰花', ['冰花'], 'key'],
    ['古籍《霜纪》', ['霜纪', '古籍'], 'key'],
    ['寒铁矿脉', ['寒铁', '矿脉'], 'key'],
    ['写作风格指引', [], 'const'],
    ['战斗描写规则', ['战斗', '交战'], 'key'],
    ['世界状态：初雪季', [], 'const'],
    ['王庭密探', ['密探', '暗哨'], 'key'],
    ['白塔规章', ['规章', '塔规'], 'key'],
    ['霜狼族长 · 阿尔妲', ['阿尔妲', '族长'], 'key'],
    ['失落的第七页', ['第七页', '残页'], 'vec'],
    ['医疗与草药', ['草药', '治疗'], 'key'],
    ['地名对照表', ['地名'], 'key'],
    ['宗教节日 · 守灯夜', ['守灯夜', '节日'], 'key'],
    ['旧版设定（停用）', ['旧设定'], 'key'],
    ['Outlet：天气', ['天气'], 'key']
  ];
  const positions = [0, 1, 4, 0, 1, 4, 2, 3, 5, 6, 0, 4, 1, 0];
  const groups = ['', '', '势力', '', '地点', '', '人物', '', ''];
  const entries = seeds.map((s, i) => {
    const uid = i;
    let position = s[2] === 'const' ? (i % 2 ? 1 : 0) : positions[i % positions.length];
    if (s[0].startsWith('Outlet')) position = 7;
    return {
      uid, comment: s[0], key: s[1], keysecondary: i % 7 === 3 ? ['北境', '冬季'] : [],
      selectiveLogic: i % 11 === 5 ? 3 : 0,
      content: s[0] + '：' + (i === 0
        ? '霜语大陆是一片常年寒冷的大陆，北境终年积雪，南岭四季分明。大陆由灰烬王庭名义统治，但北境白塔与霜狼部落保持着事实上的自治。\n\n三年前的"长夜之冬"持续了整整一百天，许多村镇因此消失，至今仍有人相信那场寒冬并非天灾。'
        : '这里记录「' + s[0] + '」的设定要点。' + '与之相关的人物、地点与历史事件会在对话中按关键词触发插入，以帮助模型保持世界观一致。'.repeat(1 + (i % 3))),
      constant: s[2] === 'const', vectorized: s[2] === 'vec',
      disable: i === 38 || i === 21 || i === 33,
      position, depth: position === 4 ? [4, 2, 6, 0][i % 4] : 4, role: i % 3,
      order: 100 + ((i * 37) % 9) * 10 - (s[2] === 'const' ? 50 : 0),
      probability: i % 9 === 4 ? 60 : (i % 13 === 7 ? 35 : 100), useProbability: true,
      outletName: position === 7 ? 'weather' : '',
      group: groups[i % groups.length], groupOverride: false, groupWeight: 100, useGroupScoring: null,
      excludeRecursion: i % 10 === 2, preventRecursion: i % 8 === 1, delayUntilRecursion: 0,
      sticky: i === 2 ? 3 : null, cooldown: null, delay: null,
      scanDepth: i === 3 ? 6 : null, caseSensitive: null, matchWholeWords: i === 7 ? true : null,
      matchCharacterDescription: false, matchCharacterPersonality: false, matchScenario: i === 30,
      matchPersonaDescription: false, matchCharacterDepthPrompt: false, matchCreatorNotes: false,
      characterFilter: { isExclude: false, names: [], tags: [] },
      triggers: [], ignoreBudget: false, automationId: '', addMemo: true, selective: true,
      modified: i === 4 || i === 11 || i === 26
    };
  });

  const book = {
    name: '霜语大陆设定', entries,
    settings: { description: '霜语大陆的地理、势力、人物与历史。', extensions: { 'cellar.sortHint': 'order' } }
  };

  /* ---------------- Catalog (per tavern) ---------------- */
  const names = ['艾琳·霜语', '墨衡', '赤璃', '洛萨', '白芷', '夜阑', '苏眠', '加尔文', '小满', '奥莉薇', '沈青崖', '泽菲尔',
    '花间', '雷恩', '月见', '柏舟', '缇娜', '玄烛', '安塞尔', '阿梨', '霁川', '露西安', '无名旅店老板', '星图测绘员'];
  const tagPool = ['奇幻', '古风', '现代', '科幻', '日常', '冒险', '悬疑', '治愈', '群像', '工具卡', '恋爱', '战斗'];
  const chats = ['10 分钟前', '1 小时前', '今天 09:12', '昨天', '2 天前', '3 天前', '上周', '2 周前', '1 个月前', '从未'];
  const catalogChars = names.map((n, i) => ({
    id: 'c' + i, name: n, hue: (i * 47 + 20) % 360, initial: n[0],
    tags: [tagPool[i % 12], tagPool[(i * 5 + 3) % 12]].filter((v, k, a) => a.indexOf(v) === k),
    lastChat: chats[i % chats.length], inWorkspace: i === 0 ? 'eirin' : i === 1 ? 'moheng' : null,
    blurb: n + ' 的角色描述摘要……这是一段只读预览，展示卡片描述的前几行。'
  }));
  const catalogBooks = [
    ['霜语大陆设定', 40, 'frost'], ['南岭书院人物志', 23], ['通用：天气与时间', 8], ['赛博城 · 霓虹区', 56],
    ['日常小镇', 17], ['战斗规则（通用）', 12], ['星图测绘员 · 航线', 31], ['旧版设定备份', 64]
  ].map((b, i) => ({ id: 'b' + i, name: b[0], count: b[1], inWorkspace: b[2] || null, updated: chats[(i + 2) % chats.length] }));

  /* ---------------- Conflict detail (艾琳·霜语 × ST) ---------------- */
  const conflict = {
    item: 'eirin', tavern: 'st',
    fields: [
      { path: 'data.description', label: '角色描述', long: true,
        base: '外表冷淡，内心其实细腻而敏感。若有人真心关心她，她会别扭地用小事回报。',
        ws: '外表冷淡，内心其实细腻而敏感。若有人真心关心她，她会别扭地用"顺手"做的小事回报，比如在对方窗台上留一朵不会融化的冰花。',
        tv: '外表冷淡，内心其实细腻而敏感。若有人真心待她好，她会别扭地用小事回报，比如替对方修好一把旧伞。' },
      { path: 'data.alternate_greetings[1]', label: '其他开场 · 第 2 条', long: true,
        base: '"三枚银币。你知道这本书缺了七页。"',
        ws: '"三枚银币，最多。你知道这本书缺了七页。"',
        tv: '"两枚银币。你知道这本书缺了整整七页。"' },
      { path: 'data.tags', label: '嵌入的标签', base: '奇幻, 冰系法师, 冷淡', ws: '奇幻, 冰系法师, 冷淡, 长篇', tv: '奇幻, 冰系法师, 傲娇' },
      { path: 'data.extensions.talkativeness', label: '发言频率', base: '0.5', ws: '0.4', tv: '0.5 (未变)', onlyWs: true },
      { path: 'data.character_version', label: '角色版本', base: '1.2.0', ws: '1.3.0', tv: '1.2.1' }
    ],
    book: {
      added: [{ uid: 41, comment: '冰原上的旧营地', side: 'tv' }, { uid: 42, comment: '守灯人', side: 'ws' }],
      removed: [{ uid: 38, comment: '旧版设定（停用）', side: 'tv' }],
      modified: [
        { uid: 4, comment: '艾琳的导师 · 赛隆', fields: [
          { label: '内容', long: true, ws: '赛隆在长夜之冬的第九十九天离开白塔，留下一本加密笔记。', tv: '赛隆在长夜之冬的最后一天离开白塔，只留下一封信。' },
          { label: '顺序', ws: '120', tv: '100' }] },
        { uid: 11, comment: '北门结界', fields: [{ label: '主要关键字', ws: '结界, 北门, 封印', tv: '结界, 北门' }] }
      ]
    }
  };

  /* Local taverns: detected by the companion and/or located on disk by the user.
     Links are admitted by browser Origin (no pairing). With a valid folder the companion can read the
     tavern directly while it is not running (library / checkout / pull); writing back offline happens
     only while that tavern is NOT running, after backing up the original file in the workspace.
     offlineReady = folder valid + Cellar Link has run once there (identifies the same tavern).
     An entry's id equals its sync-target id in `taverns` when it has one; entries without `dir` have only
     connected via Cellar Link so far (compact row with 「设置目录…」). `found` = counts read from the folder.
   whenOff (酒馆未运行时): 'wait' = 只改工作区，酒馆启动后再同步 · 'write' = 直接写入数据目录（先备份）. */
  const locations = {
    st: { accept: true, instances: [
      { id: 'st', name: '我的 SillyTavern', dir: 'D:\\SillyTavern', user: 'default-user', users: ['default-user', 'alice'],
        dataDir: 'D:\\SillyTavern\\data\\default-user', port: 8000, version: '1.15.0', origin: 'http://127.0.0.1:8000',
        running: true, plugin: true, connected: true, offlineReady: true, whenOff: 'wait', found: { books: 8, chars: 186 } },
      { id: 'st-test', name: 'SillyTavern（测试）', dir: 'E:\\ST-test', user: 'default-user', users: ['default-user'],
        dataDir: 'E:\\ST-test\\data\\default-user', port: 8001, version: '1.14.2',
        running: false, plugin: false, connected: false, offlineReady: false, whenOff: 'wait' },
      { id: 'st-8002', name: 'SillyTavern（:8002）', origin: 'http://127.0.0.1:8002', port: 8002, version: '1.15.0',
        running: false, plugin: true, connected: false, lastSeen: '3 天前' }
    ] },
    tt: { accept: true, id: 'tt', install: 'D:\\TauriTavern', dataDir: 'D:\\TauriTavern\\data', version: '2.4.0',
      origin: 'http://tauri.localhost', running: false, plugin: true, connected: false, offlineReady: true, whenOff: 'write', found: { books: 5, chars: 64 } }
  };

  window.DATA = {
    workspace: { name: '雪杉的写卡工作区', path: '%USERPROFILE%\\Documents\\TavernCellar' },
    port: 7349, taverns, locations, items, chars: { eirin, moheng }, book, catalogChars, catalogBooks, conflict
  };
})();
