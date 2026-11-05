/**
 * dsh-omni-browser -- host half
 * ============================================================================
 * What it is: a DSH tool pack that drives a real Chrome/Edge/Chromium over the
 * DevTools Protocol, and — unlike the existing control-only browser plugins —
 * captures *everything a page is* as one self-contained evidence folder:
 *
 *   DOM + readable text + outline + links/forms/meta
 *   accessibility tree (with real backend node ids)
 *   HAR 1.2 with response bodies
 *   console messages + uncaught exceptions
 *   cookies / localStorage / sessionStorage / IndexedDB / CacheStorage
 *   screenshots (viewport + full page + element), PDF, screencast frames
 *   performance metrics, coverage, resource tree
 *   a manifest.json that describes and ties the bundle together
 *
 * Sixteen `omni_*` tools share one lazily-started browser session. Everything
 * is dependency-free (node:* only), so the plugin does not need npm install.
 * ============================================================================
 */
import os from 'node:os'
import path from 'node:path'

import { BrowserSession, CdpError } from './lib/cdp.js'
import { attachCollectors } from './lib/collect.js'
import { captureBundle } from './lib/capture.js'
import {
  pageModel, getText, getHtml, getAxTree, getLinks, getForms, getMeta, getOutline, getResources,
} from './lib/snapshot.js'
import {
  resolveTarget, click as actClick, type as actType, press as actPress, scroll as actScroll,
  hover as actHover, focus as actFocus, selectOption, setChecked, uploadFiles, drag as actDrag, waitFor,
} from './lib/actions.js'
import { screenshot as takeScreenshot, record as recordScreencast } from './lib/shots.js'
import { printToPdf } from './lib/pdf.js'
import { metrics as perfMetrics, trace as perfTrace, coverage as perfCoverage, resourceSummary } from './lib/perf.js'
import { setDownloadDir, waitForDownload, listDownloads } from './lib/downloads.js'
import { collectCookies, collectStorage, exportStorage } from './lib/storage.js'
import { harvest } from './lib/harvest.js'
import {
  ensureDir, writeJson, makeOutputDir, resolveDir, relPath, bytes as fmtBytes, truncate, safeJson, oneLine, defaultOutputRoot,
} from './lib/util.js'

export const name = 'omni-browser'
/** Hard dependency: we only exist to register tools. */
export const inject = ['tools']

/* -------------------------------------------------------------------------- *
 * config + shared browser session
 * -------------------------------------------------------------------------- */

const STATE = {
  config: null,
  session: null,
  collectors: new WeakMap(),
}

function normalizeConfig(config = {}) {
  const env = process.env
  const home = env.OMNI_HOME || path.join(os.homedir(), '.dsh', 'omni-browser')
  return {
    chromePath: config.chromePath || env.OMNI_CHROME_PATH || '',
    port: config.port !== undefined ? Number(config.port) : env.OMNI_PORT ? Number(env.OMNI_PORT) : 0,
    headless: config.headless !== undefined ? Boolean(config.headless) : env.OMNI_HEADLESS ? env.OMNI_HEADLESS !== '0' : true,
    userDataDir: config.userDataDir || env.OMNI_USER_DATA_DIR || path.join(home, `profile-${env.DSH_PROFILE || 'default'}`),
    outputDir: config.outputDir || env.OMNI_OUTPUT_DIR || '',
    timeout: Number(config.timeout || 30000),
    maxBodyBytes: Number(config.maxBodyBytes || 10 * 1024 * 1024),
    maxNetworkEntries: Number(config.maxNetworkEntries || 3000),
  }
}

function config() {
  if (!STATE.config) STATE.config = normalizeConfig({})
  return STATE.config
}

async function ensureCollectors(page) {
  if (STATE.collectors.has(page)) return STATE.collectors.get(page)
  const bundle = attachCollectors(page, {
    maxEntries: config().maxNetworkEntries,
    maxBodyBytes: config().maxBodyBytes,
  })
  STATE.collectors.set(page, bundle)
  return bundle
}

function getSession() {
  if (STATE.session) return STATE.session
  const c = config()
  const session = new BrowserSession({
    chromePath: c.chromePath,
    port: c.port,
    headless: c.headless,
    userDataDir: c.userDataDir,
    timeout: c.timeout,
    onPage: (page) => {
      // Always collect: a page opened later by the site itself must be captured too.
      ensureCollectors(page).catch(() => {})
    },
  })
  STATE.session = session
  return session
}

async function shutdown() {
  const session = STATE.session
  STATE.session = null
  STATE.collectors = new WeakMap()
  if (!session) return
  try {
    await session.stop({ keepBrowser: true })
  } catch {
    /* ignore */
  }
}

/** Resolve the page a tool call should operate on (launching Chrome if needed). */
async function targetPage(args = {}) {
  const session = getSession()
  await session.ensure()
  const page = await session.page(args.target ? String(args.target) : undefined)
  await ensureCollectors(page)
  return page
}

function outBase(args, exec) {
  if (args.dir) {
    const base = exec?.cwd || process.cwd()
    return path.isAbsolute(String(args.dir)) ? String(args.dir) : path.resolve(base, String(args.dir))
  }
  if (config().outputDir) return config().outputDir
  return exec?.cwd ? path.join(exec.cwd, 'omni-capture') : defaultOutputRoot()
}

function newOutDir(args, exec, name) {
  return makeOutputDir({ root: outBase(args, exec), name: name || 'omni' })
}

/* -------------------------------------------------------------------------- *
 * tool plumbing (same contract the desktop-layout plugin uses)
 * -------------------------------------------------------------------------- */

const defineTool = (spec) => {
  const check = (schema, where) => {
    if (!schema || typeof schema !== 'object') return
    if (schema.type === 'object' && schema.additionalProperties === undefined) {
      throw new Error(`defineTool(${spec.name}): ${where} is an object without additionalProperties`)
    }
    for (const [k, v] of Object.entries(schema.properties || {})) check(v, `${where}.properties.${k}`)
  }
  check(spec.parameters, 'parameters')
  check(spec.output?.schema, 'output.schema')
  return spec
}

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

const safe = (v) => {
  if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  try {
    return JSON.parse(JSON.stringify(v))
  } catch {
    return String(v)
  }
}

/** Wrap a handler: catch everything, never let the host see a raw stack. */
function guarded(handler) {
  return async (args = {}, exec) => {
    try {
      const value = await handler(args || {}, exec)
      return safe(value)
    } catch (err) {
      const message = err instanceof CdpError ? `browser error: ${err.message}` : (err?.message || String(err))
      return { ok: false, error: message }
    }
  }
}

const P = {
  target: {
    type: 'string',
    description: 'Tab to use: targetId prefix or a substring of its URL. Omit for the active tab.',
  },
  dir: {
    type: 'string',
    description: 'Output folder (absolute, or relative to the current directory). Default: <cwd>/omni-capture/<timestamp>/.',
  },
  timeout: { type: 'number', description: 'Timeout in milliseconds.' },
  selector: { type: 'string', description: 'CSS selector.' },
  maxChars: { type: 'number', description: 'Max characters returned in the tool response (default 20000).' },
}

const targetSpec = {
  type: 'object',
  additionalProperties: false,
  description: 'Element target: {selector} | {text} (visible text) | {ref} (ax:<id> from omni_page ax) | {x,y}.',
  properties: {
    selector: { type: 'string' },
    text: { type: 'string' },
    ref: { type: 'string' },
    x: { type: 'number' },
    y: { type: 'number' },
  },
}

function pickTarget(args) {
  if (args.target && typeof args.target === 'object') return args.target
  if (args.ref) return { ref: String(args.ref) }
  if (args.selector) return { selector: String(args.selector) }
  if (args.text) return { text: String(args.text) }
  if (args.target) return String(args.target)
  return null
}

function summarizeEntries(entries, limit = 300) {
  const list = Array.isArray(entries) ? entries : []
  return list.slice(-limit).map((e) => ({
    requestId: e.requestId,
    method: e.method,
    status: e.status,
    type: e.resourceType,
    mimeType: e.mimeType,
    url: oneLine(e.url, 240),
    durationMs: e.durationMs,
    bytes: e.sizes?.encoded ?? e.encodedDataLength ?? null,
    failed: Boolean(e.failed),
    error: e.errorText || undefined,
  }))
}

/* -------------------------------------------------------------------------- *
 * tool definitions
 * -------------------------------------------------------------------------- */

const TOOLS = []

TOOLS.push({
  name: 'omni_status',
  description: [
    'Status / lifecycle of the omni browser: is Chrome running, which tabs are open, which version,',
    'where captures are written. action=launch starts it, close stops the Chrome this plugin started,',
    'restart recycles it.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['status', 'launch', 'close', 'restart'], description: 'Default: status.' },
      verbose: { type: 'boolean', description: 'Include config + launch candidate paths.' },
    },
  },
  async execute(args) {
    const action = args.action || 'status'
    if (action === 'close') {
      const session = STATE.session
      const stopped = Boolean(session)
      if (session) await session.stop({ keepBrowser: false })
      STATE.session = null
      STATE.collectors = new WeakMap()
      return { ok: true, closed: stopped, hint: 'Chrome launched by the plugin was closed.' }
    }
    if (action === 'restart') {
      await shutdown()
      const session = getSession()
      const st = await session.ensure()
      return { ok: true, running: true, restarted: true, ...st, outputDir: outBase({}, undefined) }
    }
    if (action === 'launch') {
      const session = getSession()
      const st = await session.ensure()
      return { ok: true, running: true, ...st, outputDir: outBase({}, undefined) }
    }
    const session = STATE.session
    const st = session ? await session.status() : { connected: false, pages: [] }
    const result = {
      ok: true,
      running: Boolean(st.connected),
      ...st,
      outputDir: outBase({}, undefined),
      captureHint: 'omni_capture writes the full evidence bundle; omni_page / omni_network / omni_console / omni_storage give single slices.',
    }
    if (args.verbose) {
      const c = config()
      result.config = { ...c, userDataDir: c.userDataDir }
      result.outputRoot = c.outputDir || outBase({}, undefined)
    }
    return result
  },
})

TOOLS.push({
  name: 'omni_open',
  description: 'Open a URL in the managed browser (or a new tab with newTab=true) and wait for load. Also the easiest way to start Chrome the first time.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string', description: 'http(s):// or data: URL to open.' },
      newTab: { type: 'boolean', description: 'Open in a fresh tab (default false: reuse active tab).' },
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'none'], description: 'Default: load.' },
      settle: { type: 'number', description: 'Extra milliseconds to wait after load (default 0).' },
      ...P,
    },
    required: ['url'],
  },
  async execute(args) {
    const session = getSession()
    await session.ensure()
    const page = args.newTab
      ? await session.newPage(String(args.url))
      : await session.page(args.target ? String(args.target) : undefined)
    await ensureCollectors(page)
    const nav = args.newTab && String(args.url) !== 'about:blank'
      ? { url: page.currentUrl() }
      : await page.goto(String(args.url), {
        waitUntil: args.waitUntil || 'load',
        settle: args.settle || 0,
        timeout: args.timeout || 45000,
      })
    await ensureCollectors(page)
    return {
      ok: true,
      targetId: page.targetId,
      url: nav.url || page.currentUrl(),
      title: await page.title().catch(() => ''),
      newTab: Boolean(args.newTab),
    }
  },
})

TOOLS.push({
  name: 'omni_tabs',
  description: 'List, open, activate or close tabs in the managed browser.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['list', 'new', 'close', 'activate'], description: 'Default: list.' },
      url: { type: 'string', description: 'URL for action=new.' },
      ...P,
    },
  },
  async execute(args) {
    const action = args.action || 'list'
    const session = getSession()
    await session.ensure()
    if (action === 'list') {
      return { ok: true, action, tabs: await session.listPages() }
    }
    if (action === 'new') {
      const page = await session.newPage(args.url || 'about:blank')
      await ensureCollectors(page)
      return { ok: true, action, targetId: page.targetId, url: page.currentUrl(), title: page.lastTitle || '' }
    }
    if (action === 'close') {
      if (!args.target) return { ok: false, error: 'close needs target (tab id prefix or URL substring)' }
      return { ok: true, action, ...(await session.closePage(String(args.target))) }
    }
    if (action === 'activate') {
      if (!args.target) return { ok: false, error: 'activate needs target' }
      const page = await session.activatePage(String(args.target))
      return { ok: true, action, targetId: page.targetId, url: page.currentUrl() }
    }
    return { ok: false, error: `unknown action: ${action}` }
  },
})

TOOLS.push({
  name: 'omni_page',
  description: [
    'Read the current page as a model instead of a screenshot. modes:',
    'snapshot (title/meta/text/outline/links/forms counts), text (innerText), html (outerHTML),',
    'ax (accessibility tree with ref="ax:<id>" usable by omni_act), links, forms, meta, outline,',
    'frames, resources.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: {
        type: 'string',
        enum: ['snapshot', 'text', 'html', 'ax', 'links', 'forms', 'meta', 'outline', 'frames', 'resources'],
        description: 'Default: snapshot.',
      },
      ...P,
      maxItems: { type: 'number', description: 'Max list items (links/forms/ax/outline), default 300.' },
      includeAx: { type: 'boolean', description: 'snapshot mode: include the accessibility tree too.' },
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const mode = args.mode || 'snapshot'
    const maxChars = args.maxChars || 20000
    const maxItems = args.maxItems || 300
    const selector = args.selector ? String(args.selector) : undefined
    let value
    if (mode === 'snapshot') value = await pageModel(page, { selector, maxChars, maxItems, includeAx: Boolean(args.includeAx) })
    else if (mode === 'text') value = { text: truncate(await getText(page, { selector, maxChars }), maxChars) }
    else if (mode === 'html') value = { html: truncate(await getHtml(page, { selector, maxChars }), maxChars) }
    else if (mode === 'ax') value = await getAxTree(page, { maxNodes: maxItems })
    else if (mode === 'links') value = { links: await getLinks(page, { maxItems }) }
    else if (mode === 'forms') value = { forms: await getForms(page) }
    else if (mode === 'meta') value = await getMeta(page)
    else if (mode === 'outline') value = { outline: await getOutline(page, { maxItems }) }
    else if (mode === 'frames') value = { frames: await page.frames() }
    else if (mode === 'resources') value = { resources: await getResources(page) }
    else return { ok: false, error: `unknown mode: ${mode}` }
    return { ok: true, mode, url: page.currentUrl(), title: await page.title().catch(() => ''), ...safeJson(value, {}) }
  },
})

const ACT_ACTIONS = ['click', 'dblclick', 'hover', 'focus', 'type', 'press', 'scroll', 'select', 'check', 'uncheck', 'upload', 'drag', 'wait', 'back', 'forward', 'reload']

TOOLS.push({
  name: 'omni_act',
  description: [
    'Perform a real user action on the page: click/dblclick/hover/focus/type/press/scroll/select/check/uncheck/',
    'upload/drag, plus wait/back/forward/reload. Uses trusted input events (not el.click()), so frameworks see it.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ACT_ACTIONS },
      target: targetSpec,
      selector: { type: 'string', description: 'Shortcut for target={selector}.' },
      text: { type: 'string', description: 'type=text to enter; target={text} when action targets by visible text.' },
      key: { type: 'string', description: 'press: Enter | Tab | Escape | ArrowDown | a ...' },
      value: { type: 'string', description: 'select: option value or label.' },
      files: { type: 'array', items: { type: 'string' }, description: 'upload: absolute file paths.' },
      to: targetSpec,
      dy: { type: 'number', description: 'scroll delta y (default 600).' },
      dx: { type: 'number' },
      toTop: { type: 'boolean' },
      toBottom: { type: 'boolean' },
      clear: { type: 'boolean', description: 'type: clear the field first (default true).' },
      delayMs: { type: 'number', description: 'type: delay between characters.' },
      submit: { type: 'boolean', description: 'type: press Enter afterwards.' },
      modifiers: { type: 'array', items: { type: 'string' }, description: 'e.g. ["Control","Shift"].' },
      waitMs: { type: 'number', description: 'wait: milliseconds to wait.' },
      functionText: { type: 'string', description: 'wait: JS expression polled until truthy.' },
      urlIncludes: { type: 'string', description: 'wait: URL substring.' },
      ...P,
    },
    required: ['action'],
  },
  async execute(args) {
    const page = await targetPage(args)
    const action = String(args.action || 'click')
    const t = pickTarget(args)
    const timeout = args.timeout || 10000
    let detail = {}
    if (action === 'click' || action === 'dblclick') detail = await actClick(page, t, { clickCount: action === 'dblclick' ? 2 : 1, timeout })
    else if (action === 'hover') detail = await actHover(page, t, { timeout })
    else if (action === 'focus') detail = await actFocus(page, t, { timeout })
    else if (action === 'type') detail = await actType(page, t, String(args.text ?? ''), { clear: args.clear !== false, delayMs: args.delayMs || 0, submit: Boolean(args.submit), timeout })
    else if (action === 'press') detail = await actPress(page, String(args.key || 'Enter'), { modifiers: args.modifiers || [] })
    else if (action === 'scroll') detail = await actScroll(page, { dy: args.dy ?? 600, dx: args.dx || 0, target: t, toTop: Boolean(args.toTop), toBottom: Boolean(args.toBottom) })
    else if (action === 'select') detail = await selectOption(page, t, String(args.value ?? args.text ?? ''), { timeout })
    else if (action === 'check' || action === 'uncheck') detail = await setChecked(page, t, action === 'check', { timeout })
    else if (action === 'upload') detail = await uploadFiles(page, t, args.files || [], { timeout })
    else if (action === 'drag') detail = await actDrag(page, t, pickTarget({ target: args.to }), { timeout })
    else if (action === 'wait') detail = await waitFor(page, {
      ms: args.waitMs, selector: args.selector || (t && t.selector), text: args.text,
      urlIncludes: args.urlIncludes, functionText: args.functionText, timeout: args.timeout || 15000,
    })
    else if (action === 'back') detail = await page.goBack()
    else if (action === 'forward') detail = await page.goForward()
    else if (action === 'reload') detail = await page.reload({ ignoreCache: args.clear !== false })
    else return { ok: false, error: `unknown action: ${action}` }
    return { ok: true, action, url: page.currentUrl(), ...safeJson(detail, {}) }
  },
})

TOOLS.push({
  name: 'omni_eval',
  description: 'Evaluate a JavaScript expression in the page and return its JSON value. Use it for one-off probes the other tools do not cover.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      expression: { type: 'string', description: 'JS expression; promises are awaited by default.' },
      awaitPromise: { type: 'boolean', description: 'Default true.' },
      ...P,
    },
    required: ['expression'],
  },
  async execute(args) {
    const page = await targetPage(args)
    const value = await page.evaluate(String(args.expression), { awaitPromise: args.awaitPromise !== false })
    return { ok: true, url: page.currentUrl(), result: safe(value) }
  },
})

TOOLS.push({
  name: 'omni_screenshot',
  description: 'Screenshot the page: viewport, full page (beyond the fold), a single element, or an explicit clip rectangle. Saves a real file and returns its path.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['viewport', 'fullpage', 'element', 'clip'], description: 'Default: viewport.' },
      selector: { type: 'string', description: 'element mode: CSS selector.' },
      clip: {
        type: 'object',
        additionalProperties: false,
        description: 'clip mode rectangle in CSS pixels.',
        properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        required: ['x', 'y', 'width', 'height'],
      },
      format: { type: 'string', enum: ['png', 'jpeg'], description: 'Default: png.' },
      quality: { type: 'number', description: 'jpeg quality 0-100 (default 80).' },
      filename: { type: 'string' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const dir = newOutDir(args, exec, 'shot')
    const mode = args.mode || 'viewport'
    const res = await takeScreenshot(page, {
      mode, selector: args.selector, clip: args.clip, format: args.format || 'png',
      quality: args.quality || 80, dir, filename: args.filename,
    })
    return { ok: true, mode, ...res, path: relPath(res.path, exec?.cwd || process.cwd()), file: res.path, sizeText: fmtBytes(res.bytes) }
  },
})

TOOLS.push({
  name: 'omni_pdf',
  description: 'Print the current page to PDF via Chrome print-to-PDF (vector text, selectable), with paper size / landscape / background options.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      landscape: { type: 'boolean' },
      printBackground: { type: 'boolean', description: 'Default true.' },
      paperWidth: { type: 'number', description: 'Inches, default 8.27 (A4).' },
      paperHeight: { type: 'number', description: 'Inches, default 11.69 (A4).' },
      scale: { type: 'number' },
      filename: { type: 'string' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const dir = newOutDir(args, exec, 'pdf')
    const res = await printToPdf(page, {
      dir, filename: args.filename, landscape: Boolean(args.landscape),
      printBackground: args.printBackground !== false,
      paperWidth: args.paperWidth, paperHeight: args.paperHeight, scale: args.scale,
      timeout: args.timeout,
    })
    return { ok: true, ...res, path: relPath(res.path, exec?.cwd || process.cwd()), file: res.path, sizeText: fmtBytes(res.bytes) }
  },
})

TOOLS.push({
  name: 'omni_network',
  description: [
    'Inspect everything the page requested: list (method/status/type/bytes/timing), body (fetch one response body),',
    'har (HAR 1.2 file with headers, timings, post data and bodies), stats, save, clear.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['list', 'body', 'har', 'stats', 'save', 'clear'], description: 'Default: list.' },
      requestId: { type: 'string', description: 'body mode: CDP requestId from list.' },
      filter: { type: 'string', description: 'Substring of the URL.' },
      method: { type: 'string', description: 'HTTP method filter.' },
      status: { type: 'number', description: 'Status code filter.' },
      type: { type: 'string', description: 'Resource type filter (XHR, Fetch, Document, Script, Image...).' },
      limit: { type: 'number', description: 'Default 300.' },
      filename: { type: 'string' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const { network } = await ensureCollectors(page)
    const mode = args.mode || 'list'
    if (mode === 'clear') {
      network.clear?.()
      return { ok: true, mode, cleared: true }
    }
    if (mode === 'stats') return { ok: true, mode, stats: network.stats(), url: page.currentUrl() }
    if (mode === 'body') {
      if (!args.requestId) return { ok: false, error: 'body mode needs requestId' }
      const body = await network.getBody(String(args.requestId))
      const entry = (network.entries || []).find((e) => e.requestId === args.requestId)
      let file = null
      if (body.text !== undefined && body.text !== null) {
        const dir = newOutDir(args, exec, 'body')
        file = (await writeJson(path.join(dir, `${String(args.requestId).replace(/[^\w.-]/g, '_')}.txt`), body.text)).replace(/\.txt$/, '')
      }
      return {
        ok: true, mode, requestId: args.requestId,
        url: entry?.url, mimeType: entry?.mimeType, size: body.size, truncated: Boolean(body.truncated),
        text: body.text === undefined ? undefined : truncate(body.text, args.maxChars || 20000),
        base64: body.base64 ? truncate(body.base64, 400) : undefined,
        reason: body.reason, file,
      }
    }
    if (mode === 'har') {
      const har = await network.har()
      const dir = newOutDir(args, exec, 'har')
      const file = await writeJson(path.join(dir, args.filename || 'network.har.json'), har)
      return {
        ok: true, mode, file, path: relPath(file, exec?.cwd || process.cwd()),
        bytes: fmtBytes((har?.log?.entries || []).length), entries: (har?.log?.entries || []).length,
      }
    }
    if (mode === 'save') {
      const dir = newOutDir(args, exec, 'network')
      const res = await network.export(dir)
      return { ok: true, mode, ...res }
    }
    const entries = await network.list({
      filter: args.filter, method: args.method, status: args.status, type: args.type, limit: args.limit || 300,
    })
    return {
      ok: true, mode, url: page.currentUrl(), count: entries.length,
      stats: network.stats(), entries: summarizeEntries(entries, args.limit || 300),
    }
  },
})

TOOLS.push({
  name: 'omni_console',
  description: 'Read console messages and uncaught exceptions collected for the current tab, in order.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['list', 'clear', 'save'], description: 'Default: list.' },
      level: { type: 'string', enum: ['all', 'error', 'warn', 'info', 'log', 'debug', 'exception'], description: 'Default: all.' },
      limit: { type: 'number', description: 'Default 200.' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const { console: consoleCollector } = await ensureCollectors(page)
    const mode = args.mode || 'list'
    if (mode === 'clear') {
      consoleCollector.clear()
      return { ok: true, mode, cleared: true }
    }
    if (mode === 'save') {
      const dir = newOutDir(args, exec, 'console')
      const res = await consoleCollector.export(dir)
      return { ok: true, mode, ...res, entries: (consoleCollector.entries || []).length }
    }
    const entries = await consoleCollector.list({ level: args.level || 'all', limit: args.limit || 200 })
    return {
      ok: true, mode, url: page.currentUrl(), count: entries.length,
      errors: entries.filter((e) => e.level === 'error' || e.kind === 'exception').length,
      entries: entries.map((e) => ({
        level: e.level, kind: e.kind, text: oneLine(e.text, 500), url: e.url, line: e.line, timestamp: e.timestamp,
      })),
    }
  },
})

TOOLS.push({
  name: 'omni_storage',
  description: 'Capture cookies, localStorage, sessionStorage, IndexedDB, CacheStorage and service workers for the current page. Values can be included or redacted.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['all', 'cookies', 'local', 'session', 'indexeddb', 'cache', 'sw', 'save'], description: 'Default: all.' },
      includeValues: { type: 'boolean', description: 'Default true; false redacts values (keeps key names + sizes).' },
      maxRecords: { type: 'number', description: 'Max IndexedDB records per store (default 200).' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const mode = args.mode || 'all'
    if (mode === 'save') {
      const dir = newOutDir(args, exec, 'storage')
      const res = await exportStorage(page, dir, { includeValues: args.includeValues !== false, maxRecords: args.maxRecords || 200 })
      return { ok: true, mode, ...res, path: res.path ? relPath(res.path, exec?.cwd || process.cwd()) : undefined }
    }
    if (mode === 'cookies') {
      const cookies = await collectCookies(page, {})
      return { ok: true, mode, count: cookies.length, cookies: args.includeValues === false ? cookies.map((c) => ({ ...c, value: '<redacted>' })) : cookies }
    }
    const data = await collectStorage(page, { includeValues: args.includeValues !== false, maxRecords: args.maxRecords || 200 })
    const pick = {
      cookies: data.cookies, origins: data.origins, serviceWorkers: data.serviceWorkers, quota: data.quota,
    }
    if (mode === 'all') return { ok: true, mode, url: page.currentUrl(), ...safeJson(pick, {}) }
    const origin = (data.origins || [])[0] || {}
    if (mode === 'local') return { ok: true, mode, localStorage: origin.localStorage ?? {} }
    if (mode === 'session') return { ok: true, mode, sessionStorage: origin.sessionStorage ?? {} }
    if (mode === 'indexeddb') return { ok: true, mode, indexedDB: origin.indexedDB ?? [] }
    if (mode === 'cache') return { ok: true, mode, cacheStorage: origin.cacheStorage ?? {} }
    if (mode === 'sw') return { ok: true, mode, serviceWorkers: data.serviceWorkers ?? [] }
    return { ok: false, error: `unknown mode: ${mode}` }
  },
})

TOOLS.push({
  name: 'omni_capture',
  description: [
    'THE all-in-one evidence bundle: one call writes DOM, readable text, meta, links, forms, accessibility tree,',
    'HAR with response bodies, console log, cookies/storage, full-page + viewport screenshots, PDF and a manifest',
    'into a single timestamped folder you can hand to a human or feed to another model.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'Folder label (default: page title / host).' },
      screenshot: { type: 'boolean', description: 'Default true (viewport + full page).' },
      pdf: { type: 'boolean', description: 'Default true.' },
      har: { type: 'boolean', description: 'Default true.' },
      bodies: { type: 'string', enum: ['failures', 'all', 'none'], description: 'Which response bodies to save. Default: failures.' },
      console: { type: 'boolean', description: 'Default true.' },
      storage: { type: 'boolean', description: 'Default true.' },
      ax: { type: 'boolean', description: 'Default true.' },
      html: { type: 'boolean', description: 'Default true.' },
      text: { type: 'boolean', description: 'Default true.' },
      meta: { type: 'boolean', description: 'Default true.' },
      links: { type: 'boolean', description: 'Default true.' },
      forms: { type: 'boolean', description: 'Default true.' },
      perf: { type: 'boolean', description: 'Default true.' },
      resources: { type: 'boolean', description: 'Default true.' },
      maxChars: { type: 'number' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const dir = newOutDir(args, exec, args.name || page.lastTitle || page.currentUrl())
    const options = {
      screenshot: args.screenshot !== false,
      pdf: args.pdf !== false,
      har: args.har !== false,
      bodies: args.bodies || 'failures',
      console: args.console !== false,
      storage: args.storage !== false,
      ax: args.ax !== false,
      html: args.html !== false,
      text: args.text !== false,
      meta: args.meta !== false,
      links: args.links !== false,
      forms: args.forms !== false,
      perf: args.perf !== false,
      resources: args.resources !== false,
      maxChars: args.maxChars || 400000,
      maxBodyBytes: config().maxBodyBytes,
    }
    const bundle = await captureBundle(page, { dir, name: args.name, options })
    const files = (bundle.files || []).map((f) => ({
      path: relPath(f.path, exec?.cwd || process.cwd()),
      bytes: f.bytes,
      sizeText: fmtBytes(f.bytes),
    }))
    return {
      ok: true,
      dir: bundle.dir,
      dirPath: relPath(bundle.dir, exec?.cwd || process.cwd()),
      manifestPath: bundle.manifestPath,
      manifest: relPath(bundle.manifestPath, exec?.cwd || process.cwd()),
      fileCount: files.length,
      totalBytesText: fmtBytes(files.reduce((sum, f) => sum + (f.bytes || 0), 0)),
      files,
      stats: bundle.stats,
      note: 'Everything in this folder is a self-contained snapshot of the page; manifest.json lists each artifact.',
    }
  },
})

TOOLS.push({
  name: 'omni_harvest',
  description: [
    'Crawl a small site and capture a bundle per page: follow links from a start URL (same origin, optional URL pattern),',
    'bounded by maxPages / maxDepth, then return a per-page index. This is the batch version of omni_capture.',
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      startUrl: { type: 'string', description: 'Seed URL (default: current page URL).' },
      urls: { type: 'array', items: { type: 'string' }, description: 'Explicit URL list (skips discovery).' },
      maxPages: { type: 'number', description: 'Default 5, max 50.' },
      maxDepth: { type: 'number', description: 'Link depth when discovering, default 1.' },
      sameOrigin: { type: 'boolean', description: 'Follow only same-origin links (default true).' },
      pattern: { type: 'string', description: 'Only URLs matching this regular expression (e.g. "/docs/").' },
      delayMs: { type: 'number', description: 'Delay between pages, default 400.' },
      screenshots: { type: 'boolean', description: 'Per page screenshot (default true).' },
      har: { type: 'boolean', description: 'Per page HAR (default true).' },
      pdf: { type: 'boolean', description: 'Per page PDF (default false).' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const root = newOutDir(args, exec, args.name || 'harvest')
    const result = await harvest(page, {
      startUrl: args.startUrl || (page.currentUrl() || undefined),
      urls: args.urls,
      maxPages: Math.min(Number(args.maxPages || 5), 50),
      maxDepth: args.maxDepth === undefined ? 1 : Number(args.maxDepth),
      sameOrigin: args.sameOrigin !== false,
      pattern: args.pattern,
      delayMs: args.delayMs === undefined ? 400 : Number(args.delayMs),
      outDir: root,
      perPage: { screenshot: args.screenshots !== false, har: args.har !== false, pdf: Boolean(args.pdf) },
    })
    return {
      ok: true,
      dir: result.dir,
      dirPath: relPath(result.dir, exec?.cwd || process.cwd()),
      manifestPath: result.manifestPath,
      pages: (result.pages || []).map((p) => ({ url: p.url, ok: p.ok, dir: p.dir, bytes: p.bytes, error: p.error })),
      captured: (result.pages || []).filter((p) => p.ok).length,
      failed: (result.pages || []).filter((p) => !p.ok).length,
    }
  },
})

TOOLS.push({
  name: 'omni_record',
  description: 'Record the tab as a screencast (JPEG frames + manifest) for N seconds — useful for demos, bug reports and "what did it actually do" evidence.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      seconds: { type: 'number', description: 'Default 5, max 120.' },
      format: { type: 'string', enum: ['jpeg', 'png'], description: 'Default jpeg.' },
      quality: { type: 'number', description: 'jpeg quality (default 70).' },
      maxWidth: { type: 'number', description: 'Default 1280.' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const dir = newOutDir(args, exec, 'record')
    const seconds = Math.min(Math.max(Number(args.seconds || 5), 0.5), 120)
    const res = await recordScreencast(page, {
      durationMs: seconds * 1000, dir, format: args.format || 'jpeg',
      quality: args.quality || 70, maxWidth: args.maxWidth || 1280,
    })
    return {
      ok: true, dir: res.dir, dirPath: relPath(res.dir, exec?.cwd || process.cwd()),
      frameCount: res.frameCount, durationMs: res.durationMs,
      manifestPath: res.manifestPath, path: res.manifestPath ? relPath(res.manifestPath, exec?.cwd || process.cwd()) : undefined,
      frames: (res.frames || []).slice(0, 5).map((f) => ({ path: relPath(f.path, exec?.cwd || process.cwd()), bytes: f.bytes })),
      note: 'Frames are captured on repaint; a static page produces few frames. Frames can be muxed with ffmpeg if installed.',
    }
  },
})

TOOLS.push({
  name: 'omni_download',
  description: 'Configure where downloads go, wait for a download to finish and list what was downloaded in this tab.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['enable', 'wait', 'list'], description: 'Default: enable.' },
      waitMs: { type: 'number', description: 'wait: timeout, default 30000.' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const action = args.action || 'enable'
    if (action === 'enable') {
      const dir = args.dir ? resolveDir(String(args.dir)) : newOutDir(args, exec, 'downloads')
      await ensureDir(dir)
      const res = await setDownloadDir(page, dir)
      return { ok: true, action, dir: res?.dir || dir, path: relPath(res?.dir || dir, exec?.cwd || process.cwd()) }
    }
    if (action === 'wait') {
      const res = await waitForDownload(page, { timeout: args.waitMs || 30000 })
      return { ok: true, action, ...res, path: res.path ? relPath(res.path, exec?.cwd || process.cwd()) : undefined }
    }
    const list = await listDownloads(page)
    return { ok: true, action, count: list.length, downloads: list }
  },
})

TOOLS.push({
  name: 'omni_perf',
  description: 'Performance evidence: runtime metrics (heap, nodes, layout), a DevTools trace file, JS/CSS coverage, and the resource tree with sizes.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      mode: { type: 'string', enum: ['metrics', 'trace', 'coverage', 'resources'], description: 'Default: metrics.' },
      durationMs: { type: 'number', description: 'trace/coverage capture window (default 2000).' },
      ...P,
    },
  },
  async execute(args, exec) {
    const page = await targetPage(args)
    const mode = args.mode || 'metrics'
    if (mode === 'metrics') return { ok: true, mode, ...safeJson(await perfMetrics(page), {}) }
    if (mode === 'trace') {
      const dir = newOutDir(args, exec, 'trace')
      const res = await perfTrace(page, { durationMs: args.durationMs || 2000, dir })
      return { ok: true, mode, ...res, path: relPath(res.path, exec?.cwd || process.cwd()) }
    }
    if (mode === 'coverage') return { ok: true, mode, ...safeJson(await perfCoverage(page, { durationMs: args.durationMs || 1000 }), {}) }
    return { ok: true, mode, ...safeJson(await resourceSummary(page), {}) }
  },
})

/* -------------------------------------------------------------------------- *
 * plugin entry
 * -------------------------------------------------------------------------- */

export function apply(ctx, configValue) {
  STATE.config = normalizeConfig(configValue || {})
  const disposers = []
  const register = (spec) => {
    const tool = defineTool({ ...spec, output: spec.output || textOutput, execute: guarded(spec.execute) })
    disposers.push(ctx.tools.register(tool))
  }
  for (const spec of TOOLS) register(spec)

  const cleanup = () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
    shutdown()
  }
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => cleanup)
    } catch {
      /* older hosts: no effect helper, tools still work */
    }
  }
  if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', cleanup)
    } catch {
      /* ignore */
    }
  }
}

export const tools = TOOLS.map((t) => t.name)

/** Exposed for tests / advanced users. */
export { BrowserSession }
