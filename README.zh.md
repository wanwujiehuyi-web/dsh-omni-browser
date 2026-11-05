# dsh-omni-browser

> **不只是操控浏览器，还能把整个网页状态完整取证带走。**
> 16 个 `omni_*` 工具：用原生 CDP 驱动本机 Chrome/Edge，一键把一个页面的全部状态抓成一个自包含证据目录。

市场里的浏览器插件大多只给你一个"遥控器"。`dsh-omni-browser` 给的是遥控器 + 取证相机：DOM、无障碍树、带响应体的 HAR、Console、cookies/存储、全页截图、PDF、录屏，全部写进一个带 manifest 的时间戳目录。

零 npm 依赖、不打包 Chromium、不连云端，直接用你机器上已有的 Chrome。

## 和别的浏览器插件有什么不同

| | 只做操控的插件 | **dsh-omni-browser** |
|---|---|---|
| 点击/输入/导航 | ✅ | ✅ |
| DOM 与正文 | ✅ | ✅ |
| 无障碍树（带稳定 ref） | 部分 | ✅ `ax:<backendNodeId>` |
| HAR 1.2 **含响应体** | ❌ | ✅ |
| Console + 未捕获异常 | 部分 | ✅ |
| cookies / localStorage / IndexedDB / CacheStorage / SW | ❌ | ✅ |
| 全页截图 + 元素截图 + PDF | 部分 | ✅ |
| 录屏帧（真实过程证据） | ❌ | ✅ |
| 一键**证据包** + manifest | ❌ | ✅ `omni_capture` |
| 有界多页批量采集 | ❌ | ✅ `omni_harvest` |

适用：真实站点上的 Agent 调研、可复现的 bug 报告、合规/存档快照、需要"网络真相"而不只是渲染文本的抓取，以及"页面为什么长这样"的排查。

## 安装

```bash
dsh plugin --profile desktop add github:wanwujiehuyi-web/dsh-omni-browser
```

也可在 DSH 里用 `plugin_manager` → `install_bundle` → 指向本地包目录。要求：Node 22+、本机有 Chrome/Edge/Chromium。

## 快速上手

```
omni_open     { "url": "https://example.com" }
omni_page     { "mode": "snapshot" }
omni_capture  { "name": "example" }
```

`omni_capture` 会在 `<cwd>/omni-capture/<时间戳>/` 写出：

```
manifest.json   page.json      page.png        page-full.png   page.pdf
dom.html        text.txt       ax.json         network.har.json network.json
bodies/…        console.json   storage.json    cookies.json    perf.json
resources.json
```

任何一项失败只会在 manifest 里记错误，整个包照常产出。

## 16 个工具

| 工具 | 作用 |
|---|---|
| `omni_status` | 浏览器状态 / `launch` `close` `restart` |
| `omni_open` | 打开 URL（可 `newTab`），等待 load/domcontentloaded/networkidle |
| `omni_tabs` | `list` / `new` / `close` / `activate` |
| `omni_page` | `snapshot` `text` `html` `ax` `links` `forms` `meta` `outline` `frames` `resources` |
| `omni_act` | `click` `dblclick` `hover` `focus` `type` `press` `scroll` `select` `check` `uncheck` `upload` `drag` `wait` `back` `forward` `reload`（真实输入事件） |
| `omni_eval` | 页面内执行 JS 并返回 JSON |
| `omni_screenshot` | `viewport` / `fullpage` / `element` / `clip`，落真实文件 |
| `omni_pdf` | 当前页打印成 PDF |
| `omni_network` | `list` `body` `har` `stats` `save` `clear` |
| `omni_console` | `list` `clear` `save` |
| `omni_storage` | `all` `cookies` `local` `session` `indexeddb` `cache` `sw` `save` |
| `omni_capture` | **一键完整证据包** |
| `omni_harvest` | 有界爬取，每页一个证据包 |
| `omni_record` | 录屏 N 秒 → JPEG 帧 + manifest |
| `omni_download` | `enable` / `wait` / `list` |
| `omni_perf` | `metrics` `trace` `coverage` `resources` |

元素定位支持 `{ "selector": "#id" }`、`{ "text": "登录" }`、`{ "ref": "ax:1234" }`（来自 `omni_page mode=ax`）或 `{ "x": 100, "y": 200 }`。

## 配置（都可选）

环境变量或插件 config：`OMNI_CHROME_PATH`、`OMNI_PORT`（0 = 自动选空闲端口）、`OMNI_HEADLESS`、`OMNI_USER_DATA_DIR`、`OMNI_OUTPUT_DIR`、`OMNI_HOME`。

插件使用**独立浏览器 profile**，不碰你日常的 Chrome 会话；在里面登录过的站点会在多次运行间保留（同一 profile 目录）。

## 隐私与安全

- 证据包里可能有**敏感内容**（session cookie、请求头里的 token、页面正文）。把 `omni-capture/` 当敏感数据对待；`omni_storage` 传 `includeValues: false` 可只保留键名、隐去值。
- 默认隔离 profile，但你在里面输入的都是真实操作——高风险自动化请用专用账号。
- 仅用于你有权访问的站点，不提供验证码绕过之类能力。

## 开发

```bash
node test/smoke.mjs        # CDP 传输健康检查
node test/tools.test.mjs   # 16 个工具端到端（本地 fixture 站点 + 真 Chrome，无需外网）
```

## 许可

MIT © 2026 wanwujiehuyi
