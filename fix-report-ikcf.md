# zhino-status v1.0.0 → v1.0.1

发布版 v1.0.0 在一部分酒馆助手环境里会整段失败，或者按钮挂上又被拆掉。v1.0.1 已推到 `main` 并打了附注标签 `v1.0.1`（commit `2c57be79a5256b2a0fc2036db37d7bf887660944`）。

新的加载行：

```javascript
import 'https://testingcf.jsdelivr.net/gh/braze-taffo/zhino-status@v1.0.1/dist/index.js';
```

主镜像同样可用，内容与上面逐字节相同：

```javascript
import 'https://cdn.jsdelivr.net/gh/braze-taffo/zhino-status@v1.0.1/dist/index.js';
```

## 什么坏了

用户侧现象是脚本「废的，用不了」。文件本身能下到：两个镜像上的 `v1.0.0/dist/index.js` 都是 HTTP 200、`content-type: application/javascript; charset=utf-8`、82562 字节，开头是源码注释，不是 HTML 错误页。etag `W/"14282-dWD5El3clK4p/Km1zTq6PkYz7hs"`，`x-jsd-version: 1.0.0`。

在本机 SillyTavern 1.19.0（`127.0.0.1:8000`）+ 酒馆助手 4.11.3 的正常路径上，v1.0.0 的 CDN 地址也能挂上按钮，修仙 / 赛博 / `<status>` 三个场景通过，和 zhino v5.2.9 不打架，控制台没有 zns 报错。所以不是「CDN 回了网页」也不是「健康的 ST 一律挂不上」。

会死的是 iframe 里的这几条路径。用发布的 v1.0.0 文件复现了第一条：

- 父页把 `tavern_events` 做成读取属性就抛错的对象时，模块被拒绝：`Error: tavern_events exploded`，栈在 `dist/index.js:1745` 的 `bindEvents`，由 `boot`（1807）和 `start`（888）调用。按钮已经插进父页，但 `loadFab()` 还没跑，停在 `(0, 0)`。`ZNS` 没有可用版本。Tellev 把模块 `import()` 拒绝和未处理的 rejection 记成扩展失败（`host.js` 的 `__tellevScriptFailed`）。

## 根因

1. **事件表在 try 外面读。** v1.0.0 的 `bindEvents` 先 `pickGlobal('tavern_events')`，再直接读 `MESSAGE_RECEIVED` 等字段，而且这发生在 `loadFab()` 之前。字段 getter 一抛，整次 `import` 失败，按钮留在原点。酒馆助手 4.x 的 `predefine.js` 把 `TavernHelper._bind._eventOn` 绑到 iframe 的 `window`；`event.ts` 里 `_eventOn` 返回 `{stop}` 而不是函数。v1.0.0 只在返回值是函数时才记住解绑，监听会漏。Tellev 的 `eventOn` 同样返回 `{stop}`。

2. **`pagehide` 把界面拆掉，模块不会再执行。** 脚本在隐藏 iframe 里（`Iframe.vue` 的 `v-show="false"`）。v1.0.0 在 iframe 的 `pagehide` / `unload` 上直接 `destroy()`，父页上的 `#zns-root` 被删掉。ES 模块缓存着，不会重跑。iframe 还在时按钮就没了。开启清理保护（`use_cleanup_protector`，默认关；用户脚本只有一行 `import`，不含 `pagehide` 这几个字，所以保护脚本仍会注入）时，`cleanup_protector.js` 还会按 `data-th-iframe-id` 把父页节点摘掉。

3. **预定义脚本依赖父页的 `_`。** `predefine.js` 第一行是 `window._ = window.parent._`，接着 `_(window)`。SillyTavern 1.19 只把 lodash 放在 `SillyTavern.libs`，测试仓库的 `public/lib.js` 才补了 `window._`。没有这个全局时，预定义脚本抛 `_ is not a function`，`eventOn` / `getVariables` / `tavern_events` 都不会进 iframe。v1.0.0 只查 `window[name]` 和父页同名函数，不查 `TavernHelper`，变量读不到，面板一直是「还没有状态数据」。

4. **刷新的 promise 没有 `.catch`。** `refresh().then(...)` 若拒绝，Tellev 父页的 `unhandledrejection` 会把扩展判死。空聊天时酒馆助手的 `getVariables({type:'message'})` 会抛楼层越界，这条本身被 `readVariables` 吃掉了，但调用方仍要兜住。

5. **宿主视口还是 0 时就把按钮夹到角落。** 隐藏 WebView 的 `innerWidth` 很小，按钮被放在 `(8, 8)` 或 `(0, 0)`，之后的 `resize` 只按当前坐标再夹一次，不会回到右下角。

不依赖 MVU：没有 `Mvu` 时会继续读消息变量、聊天变量和 `<status>`。类名仍是 `zns-`，不碰 `.zhino-root`。

## 改了什么

- `src/index.js` 与 `dist/index.js`（同一份文件，无构建）
  - `start()`：等 `document.body`，优先同源 `window.parent`，失败再挂当前窗口，并重试把界面从 iframe 挪到父页。顶层不抛。
  - `eventNames()` / `bindEvents()`：每个事件名单独 try。`pickFn` 还会找 `TavernHelper` 和 `_bind._eventOn`，并且绑到 iframe 的 `window`（绑到父页会让 `_getIframeName` 抛 `frameElement is null`）。
  - `asUnsubscribe()`：函数和 `{stop}` 都能解绑。
  - 先 `loadFab()` 再绑事件。`refresh()` 的调用都有 `.catch`。
  - `pagehide`：iframe 还连着父页就留住按钮并重新监听；清理保护把节点摘掉就再 `boot()` 一次。iframe 真正卸掉才 `destroy()`。
  - 视口宽或高小于 80 时先摆在 `(8, 8)`，变大后若用户没拖过，再放到右下角。
  - `svgEl` 的 `innerHTML` 失败时改用文本。`ZNS.version` 为 `'1.0.1'`。
- `README.md`：加载行改为 v1.0.1，并写了「加载失败时怎么查」（两个镜像、如何确认下到的是 JS、控制台看 `ZNS.version` 和 `#zns-fab`）。
- `st-test/load-test.mjs`：可用环境变量 `ZNS_IMPORT`、`ZNS_RESULT` 换地址，默认仍是本地 `http://localhost:8787/index.js`。

## 验证

- `node --check` 与 `node src/index.js --zns-self-test` 通过。
- 同源 iframe，带上酒馆助手的 `parent_jquery.js` + `predefine.js`：v1.0.1 按钮在 1440×900 的 `(1368, 760)`，面板读到「筑基中期」，来源「角色卡标签 · 消息变量」。`eventOn` 订了 `message_received`、`message_swiped`、`chat_id_changed`、`message_edited`、`message_deleted`，`stop` 会被调用。手动 `pagehide` 后按钮还在；摘掉 iframe 后按钮和 `ZNS` 都没了。
- 同一套加上 `cleanup_protector.js`：`pagehide` 后旧按钮节点断开，新的 `#zns-fab` 仍在，只有一个 `#zns-root`，面板仍是境界。
- 父页没有 `_`：预定义脚本仍报 `_ is not a function`，v1.0.1 仍从父页 `TavernHelper` 读到境界。没有数据时面板是「还没有状态数据」，按钮在。
- 爆炸的 `tavern_events`：v1.0.1 `import` 成功，按钮在右下角。v1.0.0 CDN 文件 `import` 失败，按钮在 `(0, 0)`。
- 视口 60×60 时按钮在 `(8, 8)`，拉到 1440×900 后到 `(1368, 760)`。
- SillyTavern 实机：本地 v1.0.1、CDN v1.0.0、CDN v1.0.1 都通过三个数据场景，zhino 悬浮按钮同时在且不重叠。v1.0.1 CDN 那次有一条 `net::ERR_ABORTED`，请求的是上一轮留下的 v1.0.0 地址，没有 zns 的 pageerror。
- 发布后第一次轮询，两个镜像都是 200、`application/javascript`、`x-jsd-version: 1.0.1`、89904 字节，与本地 `dist/index.js` 以及彼此一致。这次没有镜像延迟。

SillyTavern 和静态文件服务已停。

## 还开放的风险

- 浏览器没下到脚本时（镜像被拦、返回 HTML），模块根本不会执行。换另一条镜像，并直接打开地址确认是 JavaScript。
- 父页跨域时界面只能留在隐藏 iframe 里，聊天页上看不见。
- Tellev 的角色脚本跑在卡片运行时 WebView 里，按钮在「卡片界面」那一层，不在原生聊天控件上。
- 预定义脚本自己的 `_ is not a function` 还在。别的依赖 iframe 全局 `eventOn` 的脚本仍会受影响；本状态栏改为走父页 `TavernHelper`。
- `pagehide` 若同时触发 `unload`（页面或 iframe 真的卸掉），按钮会被拆掉。这是故意的。
- 酒馆启动遮罩的 z-index 到 999999，按钮是 100011，遮罩还在时会被盖住。
