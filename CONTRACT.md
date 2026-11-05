# dsh-omni-browser — 模块契约（开发中，所有队友以本文件为准）

DSH 插件：用 CDP 驱动**真 Chrome**，既能操控页面，也能把一个页面的**全部状态**抓成一个自包含证据包。
已定案（不要改）：包名 `dsh-omni-browser`，插件 id `omni-browser`，工具前缀 `omni_`，零第三方依赖（只允许 Node 22 内置模块），ESM。

## 目录与归属（只改自己名下的文件）

| 文件 | Owner | 说明 |
|---|---|---|
| `lib/cdp.js` | Lead | 已完成：Chrome 生命周期 + CDP 传输 + 页面原语 |
| `lib/util.js` | Lead | 已完成：路径/文件/JSON/截断等小工具 |
| `index.js` | Lead | 工具注册（16 个 omni_*） |
| `lib/harvest.js` | Lead | 站点批量采集 |
| `lib/snapshot.js`,`lib/actions.js` | mod-page | 页面模型 + 页面操作 |
| `lib/collect.js`,`lib/storage.js`,`lib/capture.js` | mod-capture | 网络/Console 采集、存储抓取、证据包编排 |
| `lib/shots.js`,`lib/pdf.js`,`lib/perf.js`,`lib/downloads.js` | mod-media | 截图/PDF/录屏/性能/下载 |
| `test/server.mjs` | Lead | 本地 fixture HTTP 服务器（测试用，避免依赖外网） |

## 公共测试方式（每人自己跑，不要互相等）

```js
import { BrowserSession } from '../lib/cdp.js';
const session = new BrowserSession({ port: 0, headless: true, userDataDir: `D:/Temp/omni-<你的名字>-${Date.now()}` });
await session.ensure();
const page = await session.page();
await page.goto('http://127.0.0.1:<port>/');   // 用 test/server.mjs
...
await session.stop();
```
`port: 0` 用随机端口 + `DevToolsActivePort` 自动发现，多人并行测试不会抢端口。**测试必须 finally `await session.stop()`**（会把 Chrome 一起关掉）。
fixture 服务器（Lead 提供）：`import { startServer } from './server.mjs'; const srv = await startServer(); srv.url; srv.close()`。

测试脚本命名 `test/<模块名>.test.mjs`，直接 `node test/xxx.test.mjs`。跑别人的模块前先跑 `node test/smoke.mjs` 确认浏览器环境正常。

## lib/cdp.js 对外 API（已实测通过，勿改签名）

```js
import { BrowserSession, PageHandle, startBrowser, findBrowserExecutable, CdpError } from './cdp.js';

const session = new BrowserSession({ port: 0|9222, headless: true, userDataDir, chromePath, timeout, onPage(page) });
await session.ensure();               // 启动/复用 Chrome + attach + sync targets，幂等
await session.status();               // {endpoint, connected, launchedByPlugin, chromePid, profileDir, browser, protocolVersion, userAgent, activePage, pages[]}
await session.page(target?)           // target: targetId 前缀 | URL 子串；省略=活动页；没有页会新建
await session.newPage(url)            // 新标签并返回已 attach 的 PageHandle
await session.closePage(target)
await session.activatePage(target)
await session.listPages()             // [{targetId, attached, url, title, type}]
await session.stop();                 // 只关闭自己启动的 Chrome
const page = ...;
page.targetId / page.sessionId / page.currentUrl()
await page.send(method, params, {timeout})          // 单次 CDP 调用（页面会话）
await page.enableDomains({page:true, runtime:true, network:true, log:true, dom:true, accessibility:true, performance:true})
await page.evaluate(expr, {awaitPromise, returnByValue, timeout})  // 在页面主世界求值，返回 JS 值
await page.goto(url, {waitUntil:'load'|'domcontentloaded'|'networkidle'|'none', timeout, settle})
await page.waitNetworkIdle(idleMs, timeout)
await page.title() / await page.url() / await page.frames() / await page.layoutMetrics()
await page.reload({ignoreCache}) / goBack() / goForward()
page.on(method, fn) → unsubscribe         // 订阅本页 CDP 事件（method 传 '*' 收全部）
await page.waitEvent(method, {timeout, predicate})
```

**需要 cdp.js 增加/修改能力时：给 Lead 发消息，不要自己改 `lib/cdp.js`。**

## 各模块必须导出的函数（index.js / capture.js 会按这个签名 import）

### lib/snapshot.js（mod-page）
```js
pageModel(page, {mode='snapshot', selector, maxChars=20000, maxItems=300, includeAx=false, frameId})
  → {url, title, meta, text, outline:[{level,text}], links[], forms[], tables?, images?, ax?, counts, capturedAt}
getText(page, {selector, maxChars, includeHidden})
getHtml(page, {selector, outer=true, maxChars})
getAxTree(page, {maxNodes=4000}) → {nodes:[{nodeId, role, name, value, description, backendDOMNodeId, childIds}]}
getLinks(page, {maxItems=500}) → [{text, href, rel, title}]
getForms(page) → [{action, method, fields:[{name,type,value,placeholder,required,label}]}]
getMeta(page) → {title, description, canonical, og:{}, twitter:{}, jsonLd:[], lang, charset, viewport, favicon}
getOutline(page, {maxItems=300}) → [{level, text}]
getResources(page) → [{url, type, mimeType, size}]（Page.getResourceTree 扁平化）
axRef(backendDOMNodeId) → 'ax:<id>'；parseRef('ax:123') → 123
```
ref 约定：AX 节点的 ref 一律 `ax:<backendDOMNodeId>`，动作模块用 `DOM.resolveNode({backendNodeId})` 解析。

### lib/actions.js（mod-page）
```js
resolveTarget(page, target, {timeout=5000})
  target: 'css selector' | {selector} | {text} | {ref:'ax:123'} | {x,y}
  → {ok, kind, backendNodeId?, rect:{x,y,width,height}, visible, description}
click(page, target, {button='left', clickCount=1, modifiers=[], timeout})
type(page, target, text, {clear=true, delayMs=0, submit=false, timeout})
press(page, key, {modifiers=[], timeout})            // key: 'Enter'|'Tab'|'Escape'|'ArrowDown'|'a'…
scroll(page, {dy=600, dx=0, target, toTop, toBottom, behavior='instant'})
hover(page, target, opts) / focus(page, target, opts)
selectOption(page, target, valueOrLabel, opts)
setChecked(page, target, checked, opts)
uploadFiles(page, target, files[], opts)
drag(page, from, to, opts)
waitFor(page, {ms, selector, text, urlIncludes, networkIdle, functionText, timeout=15000})
```
点击必须用真实输入事件（`Input.dispatchMouseEvent`，坐标取元素中心，先 scrollIntoView），不要用 `el.click()` 冒充。

### lib/collect.js（mod-capture）
```js
attachCollectors(page, {maxEntries=3000, maxBodyBytes=5*1024*1024}) → {network, console, detach()}
network.entries                          // 快照数组
await network.list({filter, method, status, type, limit})
await network.getBody(requestId) → {text?, base64?, size, truncated, reason?}
await network.har() → HAR 1.2 {log:{version, creator, pages, entries:[…]}}
network.stats() → {requests, responses, failures, bytes, byType:{}}
network.export(dir) → {path}
console.entries / await console.list({level, limit}) / console.clear() / await console.export(dir)
```
条目字段（network）：`{requestId, url, method, status, statusText, mimeType, resourceType, startedAt, durationMs, requestHeaders, responseHeaders, postData, responseBody?, sizes:{encoded,decoded}, fromCache, failed, errorText, initiator}`。
HAR 的 `content.text` 用 base64 或文本，`timings` ≥ 真实可得项。Console 条目：`{kind:'console-api'|'log'|'exception', level, text, args, url, line, timestamp, stack?}`。

### lib/storage.js（mod-capture）
```js
collectCookies(page, {urls}) → [{name, value, domain, path, expires, httpOnly, secure, sameSite}]
collectStorage(page, {includeValues=true, maxRecords=200})
  → {origins:[{origin, localStorage:{k:v}, sessionStorage:{k:v}, indexedDB:[{name, version, stores:[{name, keyPath, count, records?}]}], cacheStorage:{}}, cookies:[…], serviceWorkers:[…], quota?}
exportStorage(page, dir, {includeValues}) → {path, bytes, data}
```
IDB 通过页面内 async IIFE 读（`indexedDB.databases()` 可用则用），单 store 最多 maxRecords 条，读不到就标 unavailable，不要抛。

### lib/capture.js（mod-capture）
```js
captureBundle(page, {dir, name, options={}}) → {dir, manifestPath, manifest, files:[{path, bytes}], stats:{durationMs, network:[…], console:{errors,warns}, page:{url,title}}}
options: {screenshot:'both'|'fullpage'|'viewport'|false, pdf:true|false, har:true|false, bodies:'failures'|'all'|false,
          console:true, storage:true, ax:true, html:true, text:true, meta:true, links:true, forms:true, perf:true, resources:true,
          maxBodyBytes, maxChars}
```
默认全开（这是卖点）；任何子项失败只记 `manifest.<part>.error` 并继续，不能整体失败。文件命名固定：
`manifest.json`、`page.json`、`page.png`、`page-full.png`、`page.pdf`、`network.har.json`、`network.json`、`bodies/<0001>-<slug>.<ext>`、`console.json`、`storage.json`、`cookies.json`、`dom.html`、`text.txt`、`ax.json`、`perf.json`、`resources.json`。

### lib/shots.js（mod-media）
```js
screenshot(page, {mode='viewport'|'fullpage'|'element'|'clip', selector, clip, format='png', quality=80, dir, filename, format:'png'|'jpeg'})
  → {path, bytes, width, height, format}
captureFullPage(page, {dir, filename, format})
startScreencast(page, {dir, format='jpeg', quality=70, maxWidth=1280}) → {stop() → {dir, frames:[{path,bytes,timestamp}], durationMs, frameCount, manifestPath}, frames}
record(page, {durationMs=5000, dir, ...}) → 同上（自动 stop）
```
全页截图用 `Page.captureScreenshot {captureBeyondViewport:true, clip:{x:0,y:0,width:contentSize.width,height:contentSize.height,scale:1}}`。
录屏必须每帧 `Page.screencastFrameAck`，否则 Chrome 会停发。

### lib/pdf.js（mod-media）
```js
printToPdf(page, {dir, filename, landscape=false, printBackground=true, scale=1, paperWidth=8.27, paperHeight=11.69,
                   marginTop=0.4, marginBottom=0.4, marginLeft=0.4, marginRight=0.4, headerTemplate, footerTemplate, timeout=60000})
  → {path, bytes, pageCount?}
```

### lib/perf.js（mod-media）
```js
metrics(page) → {timestamp, metrics:{Name: value}}
trace(page, {durationMs=2000, categories, dir, filename}) → {path, bytes, events}
coverage(page, {durationMs=1000}) → {js:[…], css:[…]}
resourceSummary(page) → {count, totalBytes, byType:{}, entries:[{url,type,mimeType,size}]}
```

### lib/downloads.js（mod-media）
```js
setDownloadDir(page, dir) → {dir}                     // Browser.setDownloadBehavior（browser 级）
waitForDownload(page, {timeout=30000}) → {guid, suggestedFilename, state, path, bytes}
listDownloads(page) → [{guid, suggestedFilename, state, path, bytes}]
```

## 硬规则

1. **零依赖**：不得新增 npm 依赖；只用 `node:*` 内置模块。不得引入 `ws`/`puppeteer`/`sharp` 之类。
2. **失败要降级**：内部子步骤失败 → 记录 `{error}` 继续，不要 throw 整个工具。面向用户的入口（如 `screenshot`）失败才 throw 带可读信息的 Error。
3. **输出路径**：所有写文件走 `lib/util.js`（`writeJson`/`writeText`/`writeBinary`/`ensureDir`/`makeOutputDir`/`slug`/`bytes`），不要自己拼 `D:/` 或 `C:/`。
4. 不用 `console.log` 写业务日志（宿主里会污染输出）；需要调试就临时加，交付前删掉。
5. 中文注释可以有，但代码标识符全英文。
6. 不执行 git 操作、不改 `package.json`、不改别人的文件。改 `package.json` 需求找 Lead。
7. 交付时报告：改了哪些文件、`node test/xxx.test.mjs` 的真实输出、已知限制。测试必须真跑真 Chrome，不许"应该能行"。
