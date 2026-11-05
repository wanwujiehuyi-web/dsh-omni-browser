# dsh-omni-browser

> **Control a real browser — and take the whole page with you.**
> 16 `omni_*` tools that drive Chrome/Edge over CDP *and* capture everything a page is as one self-contained evidence folder.

Most browser plugins in the DSH marketplace give you a remote control. `dsh-omni-browser` gives you a remote control **plus a forensic camera**: DOM, accessibility tree, HAR with response bodies, console log, cookies/storage, full-page screenshots, PDF and a screencast — all written into one timestamped folder with a manifest.

No npm dependencies, no bundled Chromium, no cloud service. It starts the Chrome you already have and talks raw CDP.

---

## Why another browser plugin?

| | Control-only plugins | **dsh-omni-browser** |
|---|---|---|
| Click / type / navigate | ✅ | ✅ |
| Read DOM & text | ✅ | ✅ |
| Accessibility tree with stable refs | sometimes | ✅ `ax:<backend-node-id>` |
| HAR 1.2 **with response bodies** | ❌ | ✅ |
| Console + uncaught exceptions | sometimes | ✅ |
| Cookies / localStorage / IndexedDB / CacheStorage / service workers | ❌ | ✅ |
| Full-page screenshot + element screenshot + PDF | partly | ✅ |
| Screencast frames of what actually happened | ❌ | ✅ |
| One-call **evidence bundle** + manifest | ❌ | ✅ `omni_capture` |
| Bounded multi-page **harvest** | ❌ | ✅ `omni_harvest` |

Use it for: agent research on real sites, bug reports that must be reproducible, compliance/archival snapshots, scraping where you need the network truth (not just the rendered text), and "why did the page show that?" debugging.

---

## Install

```bash
# from the DSH marketplace registry (once listed)
dsh plugin --profile desktop add github:wanwujiehuyi-web/dsh-omni-browser

# or from a local checkout, in the DSH GUI
# plugin_manager → install_bundle → /absolute/path/to/dsh-omni-browser
```

Requirements: DSH with the `tools` service, Node 22+, and a local Chrome / Edge / Chromium.

---

## Quick start

```
omni_open        { "url": "https://example.com" }
omni_page        { "mode": "snapshot" }
omni_capture     { "name": "example" }
```

`omni_capture` returns something like:

```json
{
  "ok": true,
  "dir": "D:\\work\\omni-capture\\example-20261105-151230",
  "manifestPath": ".../manifest.json",
  "fileCount": 14,
  "totalBytesText": "1.8 MB",
  "files": [{ "path": "page.png", "bytes": 184212 }, "..."]
}
```

and the folder contains:

```
manifest.json          schema + per-artifact status + timings
page.json              title, url, meta, outline, links, forms, counts
page.png               viewport screenshot
page-full.png          full-page screenshot (beyond the fold)
page.pdf               print-to-PDF (vector text)
dom.html               rendered DOM (outerHTML)
text.txt               readable innerText
ax.json                accessibility tree (roles/names/values/backend ids)
network.har.json       HAR 1.2: headers, timings, post data, bodies
network.json           compact request list
bodies/0001-*.json     response bodies (failures by default, all with bodies:"all")
console.json           console messages + uncaught exceptions
storage.json           cookies + localStorage/sessionStorage/IndexedDB/CacheStorage
cookies.json           cookies only
perf.json              runtime metrics
resources.json         resource tree with sizes
```

Every part degrades gracefully: if PDF or a response body is unavailable, the rest of the bundle is still written and the manifest records the error.

---

## The 16 tools

| Tool | What it does |
|---|---|
| `omni_status` | Is Chrome running, which tabs, version, profile. `action: launch \| close \| restart` |
| `omni_open` | Open a URL (reuse tab or `newTab`), wait for `load`/`domcontentloaded`/`networkidle` |
| `omni_tabs` | `list` / `new` / `close` / `activate` |
| `omni_page` | Read the page: `snapshot`, `text`, `html`, `ax`, `links`, `forms`, `meta`, `outline`, `frames`, `resources` |
| `omni_act` | `click`, `dblclick`, `hover`, `focus`, `type`, `press`, `scroll`, `select`, `check`, `uncheck`, `upload`, `drag`, `wait`, `back`, `forward`, `reload` — real input events |
| `omni_eval` | Evaluate JS in the page, get JSON back |
| `omni_screenshot` | `viewport` / `fullpage` / `element` / `clip` → real file |
| `omni_pdf` | Print current page to PDF |
| `omni_network` | `list`, `body` (one response body), `har`, `stats`, `save`, `clear` |
| `omni_console` | `list` / `clear` / `save` console + exceptions |
| `omni_storage` | `all`, `cookies`, `local`, `session`, `indexeddb`, `cache`, `sw`, `save` |
| `omni_capture` | **one-call evidence bundle** |
| `omni_harvest` | bounded crawl, one bundle per page |
| `omni_record` | screencast the tab for N seconds → JPEG frames + manifest |
| `omni_download` | `enable` (set download dir), `wait`, `list` |
| `omni_perf` | `metrics`, `trace`, `coverage`, `resources` |

Element targets accept `{ "selector": "#id" }`, `{ "text": "Sign in" }`, `{ "ref": "ax:1234" }` (from `omni_page mode=ax`) or `{ "x": 100, "y": 200 }`.

---

## Configuration

All optional — set via the plugin `config` in `cordis.patch.yml`, or environment variables:

| Env | Meaning | Default |
|---|---|---|
| `OMNI_CHROME_PATH` | Browser executable | auto-detect Chrome/Edge/Chromium |
| `OMNI_PORT` | CDP port (`0` = pick a free port) | `0` |
| `OMNI_HEADLESS` | `1` / `0` | `1` |
| `OMNI_USER_DATA_DIR` | Browser profile directory | `~/.dsh/omni-browser/profile-<DSH profile>` |
| `OMNI_OUTPUT_DIR` | Where captures go | `<cwd>/omni-capture/<timestamp>/` |
| `OMNI_HOME` | Plugin data home | `~/.dsh/omni-browser` |

The plugin uses its **own browser profile**, so it never touches your personal Chrome session. Cookies you log into inside the managed browser persist between runs (same profile directory).

---

## Privacy & safety

- Captures may contain **secrets** (session cookies, tokens in headers, page content). Treat `omni-capture/` as sensitive data. Use `includeValues: false` with `omni_storage` to keep keys but redact values.
- The browser profile is isolated by default, but anything you type into it is real — use a dedicated account for risky automation.
- This tool is for sites you are allowed to access. It is not a scraping-as-a-service bypass and does not solve CAPTCHAs.

---

## How it works

```
index.js            host entry: config, shared session, 16 tool registrations
lib/cdp.js          Chrome lifecycle + raw CDP transport (WebSocket, no deps)
lib/snapshot.js     page model: text/html/AX/links/forms/meta/outline/resources
lib/actions.js      trusted input actions
lib/collect.js      Network/Console collectors, HAR 1.2
lib/storage.js      cookies + Web Storage + IndexedDB + CacheStorage
lib/capture.js      evidence-bundle orchestration + manifest
lib/shots.js        screenshots + screencast frames
lib/pdf.js          print-to-PDF
lib/perf.js         metrics / trace / coverage / resource tree
lib/downloads.js    download behavior + wait/list
lib/harvest.js      bounded multi-page crawl
```

Tests run against a local fixture site (`test/server.mjs`) with a real headless Chrome — no internet required:

```bash
node test/smoke.mjs        # CDP transport health check
node test/tools.test.mjs   # all 16 tools end-to-end
```

---

## License

MIT © 2026 wanwujiehuyi
