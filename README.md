# 人物状态栏

酒馆助手（SillyTavern / Tavern Helper）用的伴侣脚本。聊天旁边浮一个玻璃面板，按世界观显示人物状态：修仙、都市、末日、西幻、赛博朋克。

它不负责替模型改写变量，只读两处数据：MVU 的 `stat_data`，或 AI 回复末尾的 `<status>` 块。外观靠近 zhino 的夜空玻璃 / 白昼樱花，但类名、id、CSS 变量都用 `zns-` / `ZNS`，不占用 `.zhino-root` 和 `--zn-*`。

不需要构建，没有依赖。`src/index.js` 与 `dist/index.js` 是同一份文件。

## 怎么加载

酒馆助手里新建一条**脚本**（不是正则，也不是样式），内容只留这一行：

```javascript
import 'https://testingcf.jsdelivr.net/gh/braze-taffo/zhino-status@v1.0.1/dist/index.js';
```

`testingcf.jsdelivr.net` 打不开时，换成 jsDelivr 主镜像，版本号不要改：

```javascript
import 'https://cdn.jsdelivr.net/gh/braze-taffo/zhino-status@v1.0.1/dist/index.js';
```

保存后刷新聊天。页面右下角会出现一颗圆按钮，点开就是状态栏。按钮可以拖，位置记在 localStorage 里。没有 MVU、聊天还是空的，按钮也会出现，面板里写「还没有状态数据」。

脚本跑在酒馆助手的 iframe 里，界面会挂到**宿主页面**的 `document.body`。需要 iframe 能访问父页面（酒馆助手默认同源，可以）。父页面还没准备好时会重试；父页面跨域或拒绝挂载时，界面留在 iframe 里，聊天页上就看不见。

本地先看效果：打开 `demo.html`（或 `npx serve` 之后访问）。地址参数：

- `?wv=xiuxian` 也可写成 `dushi`、`moshi`、`xihuan`、`cyber`
- `?theme=light` 白昼樱花
- `?open=1` 直接展开面板
- `?src=status` 不走 MVU，改解析最后一条 AI 消息里的 `<status>`

## 世界观怎么选定

优先级从高到低：

1. **聊天变量** `zns_worldview`（`getVariables({type:'chat'})`）。面板里手动选中某一世界观时，会用 `insertOrAssignVariables({zns_worldview:id},{type:'chat'})` 写进去。接口不存在时只写 localStorage。
2. **角色卡标签**。`SillyTavern.getContext().characters[characterId]` 的 `tags` 或 `data.tags`。认 `zns:xiuxian`，也认 `世界观:修仙`，或直接写预设 id / 中文名（修仙、都市、末日、末世、西幻、赛博、赛博朋克）。
3. **世界书**。角色卡自带世界书，或酒馆助手的 `getCharWorldbookNames` + `getWorldbook`。只看条目的备注、名称、关键词，不扫正文。写法同样是 `zns:moshi` 或 `世界观:末日`。
4. **关键词**。在角色卡的描述、性格、场景、开场白里给五个预设打分（修仙、灵根、金丹、丧尸、义体、西幻……）。
5. **手动**。面板下拉框。选「自动检测」会清掉聊天变量和本地记录，重新按上面的顺序判断。

下拉框旁边的小字是这次的来源，例如 `来源：世界书 · MVU`。

五个预设的 id：`xiuxian`、`dushi`、`moshi`、`xihuan`、`cyber`。每个的世界书提示词和开局变量在 `presets/`。

## 数据从哪来

`ZNS.refresh()` 按这个顺序读，读到非空的 `stat_data` 就停：

1. `Mvu.getMvuData({type:'message', message_id:'latest'}).stat_data`
2. `getVariables({type:'message', message_id:'latest'}).stat_data`
3. `getVariables({type:'chat'}).stat_data`
4. 最后一条 AI 回复里的 `<status>...</status>`。先当 JSON 解析；失败再按缩进 YAML 解析（`key: value`、`- item`、行内 `[a, b]`、`#` 注释）。

接口不存在或抛错会被吃掉，聊天还能继续。

刷新时机：酒馆事件 `MESSAGE_RECEIVED`、`MESSAGE_SWIPED`、`CHAT_CHANGED`、`MESSAGE_EDITED`、`MESSAGE_DELETED`（防抖约 280ms）；若有 `Mvu.events.VARIABLE_UPDATE_ENDED` 也会听。面板开着时另外每 5 秒轻量拉一次，关上就停。

### 多角色

- `stat_data.角色` 或 `stat_data.characters` 的每个子对象是一个角色。
- 或者顶层就是 `{ 林动: { 境界: … }, 苏晚晴: { … } }`：值大多像字段表，就按角色拆。
- `属性` / `背包` 这种分组名不会被当成角色，会摊平进同一个人。
- 以上都不是，就显示一个角色，名字用角色卡的 `name2`，没有则叫「主角」。

面板上方是角色标签。预设里没有的键进「其他」，当文本显示。空字段默认藏起来，页脚可以「显示空字段」。

### 条、数字、标签、列表

字段类型：`bar`、`num`、`text`、`tags`、`list`。预设里的 `key` 就是中文名（HP、MP、RAM 这三个用英文，和预设一致）。

条形图接受：

- 数字 `82`（上限用字段的 `max`，或同级的 `maxKey`，例如 `灵力上限`）
- 字符串 `"82/120"`、`"40%"`
- 数组 `[82, 120]`
- 对象 `{当前: 82, 上限: 120}`（也认 `current` / `max`）
- MVU 叶子 `[82, "战斗消耗后的灵力"]`：第二个是说明字符串时只取第一个

生命、HP、体力、理智、人性这类条，比例低于 25% 时数字和条变红。越高越糟的条在字段上加 `invert: true`：比例 **≥ 75%** 才变红，低的时候保持普通强调色。内置预设里写了 `invert` 的有饥饿、口渴、感染度、赛博精神病、通缉等级。

标签和列表会收成芯片。字符串按逗号、顿号拆开；对象映射会显示成「名字 · 值」。

从 AI 正文兜底时，`<status>` 必须是**完整快照**，不是差量。MVU 的 JSON Patch 才是差量。`presets/<id>.md` 里两种都写了，可直接贴进世界书。

## 自己加预设

在宿主页面的控制台（不是 iframe 的控制台）：

```javascript
ZNS.registerPreset({
  id: 'wuxia',
  name: '武侠',
  theme: {
    accent: '#f87171',
    accent2: '#fdba74',
    accentInk: '#b91c1c',
    accent2Ink: '#c2410c',
    icon: '剑',
    bgGradient: 'linear-gradient(160deg, rgba(248,113,113,0.28), transparent 70%)'
  },
  keywords: ['武侠', '江湖', '内力', '门派'],
  groups: [
    {
      label: '江湖',
      fields: [
        { key: '内力', label: '内力', type: 'bar', max: 100 },
        { key: '中毒', label: '中毒', type: 'bar', max: 100, invert: true },
        { key: '门派', label: '门派', type: 'text' },
        { key: '武功', label: '武功', type: 'list' }
      ]
    }
  ]
});

ZNS.setWorldview('wuxia'); // 写入聊天变量；传 '' 恢复自动检测
ZNS.refresh();
```

`invert: true` 只影响条形图：达到或超过 75% 变红。不写时，字段名像生命、HP、体力、理智、人性才会在低于 25% 变红，其余条不变色。`accentInk` 是白昼主题用的深色，保证字和条在浅底上还看得清。

`ZNS.presets` 是当前预设数组，`registerPreset` 会按 id 覆盖。

主题按钮在夜空、白昼樱花、跟随宿主之间轮换。跟随会看 `.zhino-root` 的 `data-theme`、页面的 `data-theme`，最后才看系统浅色偏好。

玻璃底色写成 `var(--zn-bg-secondary, var(--zn-bg, #141a2e))` 这一类。zhino 若把 `--zn-*` 挂在能继承到的地方，会跟着走；挂在 `.zhino-root` 内部时用自带的夜空 / 樱花回退色。强调色始终来自当前世界观。

## 局限

- 只读。不写 `stat_data`，也不替你检查模型有没有按提示词更新。
- `<status>` 是整包替换显示，不会和旧值合并。漏写的角色这次就不会出现。
- YAML 只覆盖缩进映射、`-` 列表、`key: value` 和行内 `[a, b]`。锚点、多行 `|`、复杂引号不保证。
- `[值, "说明"]` 和「恰好两个短标签」靠说明的长度和标点区分。`["中毒", "轻伤"]` 会保留两项；说明写长一点才会被当成 MVU 叶子。
- 顶层如果混着角色对象和零散字段，可能合成一个「主角」。稳定写法是套一层 `角色:`。
- 手动选择会占用聊天变量 `zns_worldview`，在你点回「自动检测」之前，标签和关键词不会再生效。
- 面板 z-index 很高，盖在酒馆和 zhino 上面。圆按钮和 zhino 的悬浮按钮可能叠在一起，拖开即可。
- 跨域 iframe 读不到父页面时，界面会留在 iframe 里，酒馆聊天页上看不见。
- 5 秒轮询只在面板打开时跑。事件没接上、变量又是静默写入时，关上面板再打开，或点刷新。

## 加载失败时怎么查

v1.0.0 在部分酒馆助手里会整段失败：事件表读一下就抛错，按钮还没摆好，模块就被判死；隐藏 iframe 的 `pagehide` 还会把已经挂上的按钮拆掉，而且模块不会再跑一遍。v1.0.1 把这些包进了 try/catch，按钮会先出现。

1. 浏览器直接打开上面的地址。正常是一段 JavaScript，响应头里 `content-type` 含 `javascript`，状态码 200。如果是 HTML（标题像 jsDelivr 报错页、或者「库不存在」），就是镜像还没同步，或这个域名被拦了。换另一条镜像，等一两分钟再刷新。新 tag 推上去之后，两个镜像不一定同时生效。
2. 酒馆页面按 F12，看主页面控制台，也切到脚本 iframe（名字类似 `TH-script--…`）的控制台。红色的 `Failed to fetch`、`Unexpected token '<'` 是地址没下到脚本。换镜像。
3. 主页面控制台执行 `ZNS.version`，应是 `'1.0.1'`。再执行 `document.querySelector('#zns-fab')`，应是那个圆按钮。`ZNS.refresh()` 会再读一次变量。
4. 有按钮但面板是「还没有状态数据」：MVU 不是必需的。按「数据从哪来」检查最新楼层的 `stat_data`，或 AI 回复里的 `<status>`。点面板上的刷新。
5. 和 zhino 一起用时，两个按钮可能叠在一起，把状态栏按钮拖开。类名是 `zns-`，不会拆 zhino 的节点。
6. 按钮一闪就没：看是不是关了脚本，或 iframe 真的被卸掉。只是隐藏 iframe 不应再把按钮删掉。
