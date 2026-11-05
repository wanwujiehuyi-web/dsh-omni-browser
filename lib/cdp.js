// dsh-omni-browser / lib/cdp.js
// Zero-dependency Chrome DevTools Protocol client.
//
// Owns: Chrome process lifecycle, websocket transport, flatten-mode sessions,
// target/page bookkeeping and page-level primitives (evaluate / goto / enable).
// Everything else (collectors, snapshots, screenshots, storage, capture bundles)
// is built on top of the small public API documented in CONTRACT.md.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { omniHome, sleep } from './util.js';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
];

/** Locate a Chromium-family browser executable. */
export function findBrowserExecutable(explicit) {
  const envPath = process.env.OMNI_CHROME_PATH;
  const candidates = [explicit, envPath, ...CHROME_CANDIDATES].filter(Boolean);
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

export function listBrowserCandidates() {
  return [process.env.OMNI_CHROME_PATH, ...CHROME_CANDIDATES].filter(Boolean);
}

export class CdpError extends Error {
  constructor(message, { method, code, data } = {}) {
    super(message);
    this.name = 'CdpError';
    this.method = method;
    this.code = code;
    this.data = data;
  }
}

async function httpJson(url, { timeout = 3000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        process.kill(pid, 'SIGKILL');
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** A single browser (Chrome/Edge/Chromium) process + CDP connection. */
export class BrowserSession {
  constructor(config = {}) {
    this.config = {
      host: '127.0.0.1',
      port: 9222,
      headless: true,
      chromePath: '',
      userDataDir: '',
      windowSize: '1440,900',
      lang: 'zh-CN',
      launchArgs: [],
      connectTimeout: 20000,
      timeout: 30000,
      onPage: null,
      ...config,
    };
    this.port = Number(this.config.port ?? 9222);
    this.autoPort = this.port === 0;
    this.pages = new Map(); // targetId -> PageHandle
    this.activePageId = null;
    this.listeners = new Set();
    this.pending = new Map();
    this.seq = 0;
    this.ws = null;
    this.connected = false;
    this.launched = false;
    this.chromePid = null;
    this.profileDir = null;
    this.versionInfo = null;
    this._ensuring = null;
    this._wsPath = null;
  }

  get endpoint() {
    return `http://${this.config.host}:${this.port}`;
  }

  /* ------------------------------------------------------------------ *
   * lifecycle
   * ------------------------------------------------------------------ */

  async probe(timeout = 1500) {
    try {
      this.versionInfo = await httpJson(`${this.endpoint}/json/version`, { timeout });
      return true;
    } catch {
      return false;
    }
  }

  /** Make sure a browser is running and we are attached. Idempotent. */
  async ensure() {
    if (this.connected && this.ws && this.ws.readyState === 1) return this.status();
    if (this._ensuring) return this._ensuring;
    this._ensuring = (async () => {
      if (!(await this.probe())) await this.launch();
      await this.attach();
      await this.syncTargets();
      return this.status();
    })();
    try {
      return await this._ensuring;
    } finally {
      this._ensuring = null;
    }
  }

  chromeFlags() {
    const c = this.config;
    const flags = [
      `--remote-debugging-port=${this.autoPort ? 0 : this.port}`,
      `--user-data-dir=${this.profileDir}`,
      `--window-size=${c.windowSize}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-extensions',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-popup-blocking',
      '--disable-component-update',
      '--no-service-autorun',
      '--password-store=basic',
      '--use-mock-keychain',
      '--mute-audio',
      `--lang=${c.lang}`,
    ];
    if (c.headless) flags.push('--headless=new', '--hide-scrollbars', '--disable-gpu');
    if (Array.isArray(c.launchArgs)) flags.push(...c.launchArgs);
    return flags;
  }

  async launch() {
    const exe = findBrowserExecutable(this.config.chromePath);
    if (!exe) {
      throw new CdpError(
        `No Chrome / Edge / Chromium executable found. Tried:\n${listBrowserCandidates().join('\n')}\n` +
          'Set config.chromePath (or env OMNI_CHROME_PATH) to your browser binary.',
      );
    }
    this.profileDir =
      this.config.userDataDir ||
      path.join(omniHome(), this.autoPort ? 'profile-auto' : `profile-${this.port}`);
    await fsp.mkdir(this.profileDir, { recursive: true });
    if (this.autoPort) {
      try {
        await fsp.rm(path.join(this.profileDir, 'DevToolsActivePort'), { force: true });
      } catch {
        /* ignore */
      }
    }
    const child = spawn(exe, [...this.chromeFlags(), 'about:blank'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => {});
    child.unref();
    this.chromePid = child.pid;
    this.launched = true;
    if (this.autoPort) await this.discoverPort();
    await this.waitVersion();
    return { pid: child.pid, exe, profileDir: this.profileDir, port: this.port };
  }

  async discoverPort(timeout = this.config.connectTimeout) {
    const file = path.join(this.profileDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const text = await fsp.readFile(file, 'utf8');
        const [portLine, wsLine] = text.trim().split(/\r?\n/);
        const port = Number(portLine);
        if (Number.isFinite(port) && port > 0) {
          this.port = port;
          this._wsPath = wsLine ? wsLine.trim() : null;
          return port;
        }
      } catch {
        /* not written yet */
      }
      await sleep(120);
    }
    throw new CdpError(`Chrome did not report a DevTools port within ${timeout}ms (profile: ${this.profileDir})`);
  }

  async waitVersion(timeout = this.config.connectTimeout) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await this.probe(1500)) return this.versionInfo;
      await sleep(150);
    }
    throw new CdpError(`Browser did not expose a DevTools endpoint at ${this.endpoint} within ${timeout}ms`);
  }

  async attach() {
    const info = await httpJson(`${this.endpoint}/json/version`);
    this.versionInfo = info;
    let wsUrl = info.webSocketDebuggerUrl;
    if (!wsUrl && this._wsPath) wsUrl = `ws://${this.config.host}:${this.port}${this._wsPath}`;
    if (!wsUrl) throw new CdpError('DevTools endpoint did not provide a websocket URL');
    await this.connect(wsUrl);
    await this.send('Target.setDiscoverTargets', { discover: true });
    await this.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    return info;
  }

  async connect(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('websocket connect timeout')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new CdpError(`websocket connection failed: ${wsUrl}`));
      });
    });
    this.ws.addEventListener('message', (event) => this.onMessage(event));
    this.ws.addEventListener('close', () => this.onClose());
    this.ws.addEventListener('error', () => {});
    this.connected = true;
  }

  onClose() {
    this.connected = false;
    for (const page of this.pages.values()) page.sessionId = null;
    this.emit({ method: 'Omni.disconnected', params: {} });
  }

  /* ------------------------------------------------------------------ *
   * transport
   * ------------------------------------------------------------------ */

  /** Raw CDP call. Resolves with the `result` object, rejects on protocol error. */
  async send(method, params = {}, sessionId = undefined, opts = {}) {
    const timeout = opts.timeout ?? this.config.timeout;
    if (!this.ws || this.ws.readyState !== 1) {
      throw new CdpError(`CDP socket is not connected (${method})`, { method });
    }
    const id = ++this.seq;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP timeout after ${timeout}ms: ${method}`, { method }));
      }, timeout);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      this.pending.delete(id);
      throw new CdpError(`Failed to send ${method}: ${err.message}`, { method });
    }
    return promise;
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new CdpError(`${message.error.message} (${message.error.code}${message.error.data ? `: ${message.error.data}` : ''})`, {
            method: pending.method,
            code: message.error.code,
            data: message.error.data,
          }),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (message.method) this.dispatch(message);
  }

  dispatch({ method, params, sessionId }) {
    if (method === 'Target.attachedToTarget') {
      const info = params?.targetInfo;
      if (info && info.type === 'page') this.ensurePage(info.targetId, params.sessionId, info);
    } else if (method === 'Target.targetInfoChanged') {
      const info = params?.targetInfo;
      const page = info && this.pages.get(info.targetId);
      if (page) {
        page.info = info;
        if (info.url) page.lastUrl = info.url;
        if (info.title) page.lastTitle = info.title;
      }
    } else if (method === 'Target.targetDestroyed') {
      const id = params?.targetId;
      if (id) {
        this.pages.delete(id);
        if (this.activePageId === id) this.activePageId = null;
      }
    } else if (method === 'Target.detachedFromTarget') {
      const page = this.pageBySession(params?.sessionId);
      if (page) {
        page.sessionId = null;
        page.detached = true;
      }
    }
    const page = sessionId ? this.pageBySession(sessionId) : null;
    if (page) page.emit(method, params);
    this.emit({ method, params, sessionId });
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* listener errors must not break the socket */
      }
    }
  }

  /** Subscribe to every browser-level CDP event. Returns unsubscribe. */
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  pageBySession(sessionId) {
    if (!sessionId) return null;
    for (const page of this.pages.values()) if (page.sessionId === sessionId) return page;
    return null;
  }

  ensurePage(targetId, sessionId, info) {
    let page = this.pages.get(targetId);
    if (page) {
      if (sessionId) {
        page.sessionId = sessionId;
        page.detached = false;
      }
      if (info) page.info = info;
      return page;
    }
    page = new PageHandle(this, targetId, sessionId || null, info || null);
    this.pages.set(targetId, page);
    if (!this.activePageId) this.activePageId = targetId;
    this.emit({ method: 'Omni.page-created', params: { page: page.toJSON() } });
    if (typeof this.config.onPage === 'function') {
      try {
        this.config.onPage(page);
      } catch {
        /* a bad hook must not break the session */
      }
    }
    return page;
  }

  async syncTargets() {
    const { targetInfos = [] } = await this.send('Target.getTargets');
    for (const info of targetInfos) {
      if (info.type !== 'page') continue;
      const existing = this.pages.get(info.targetId);
      if (existing?.sessionId) {
        existing.info = info;
        continue;
      }
      try {
        const { sessionId } = await this.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
        this.ensurePage(info.targetId, sessionId, info);
      } catch {
        /* un-attachable target (e.g. closing) */
      }
    }
    const live = new Set(targetInfos.map((t) => t.targetId));
    for (const id of [...this.pages.keys()]) if (!live.has(id)) this.pages.delete(id);
    if (this.activePageId && !this.pages.has(this.activePageId)) this.activePageId = null;
    if (!this.activePageId && this.pages.size) this.activePageId = [...this.pages.keys()][0];
    return [...this.pages.values()];
  }

  /* ------------------------------------------------------------------ *
   * pages
   * ------------------------------------------------------------------ */

  findPage(target) {
    if (!target) return null;
    if (this.pages.has(target)) return this.pages.get(target);
    const t = String(target);
    for (const page of this.pages.values()) {
      if (page.targetId.startsWith(t)) return page;
    }
    for (const page of this.pages.values()) {
      if ((page.currentUrl() || '').includes(t)) return page;
    }
    return null;
  }

  /** Resolve the page to operate on; creates one if the browser has none. */
  async page(target) {
    await this.ensure();
    if (target) {
      let page = this.findPage(target);
      if (!page) throw new CdpError(`No open tab matches "${target}"`);
      if (!page.sessionId) await page.reattach();
      this.activePageId = page.targetId;
      return page;
    }
    if (!this.pages.size) return this.newPage('about:blank');
    let page = this.pages.get(this.activePageId) || [...this.pages.values()][0];
    if (!page.sessionId) {
      try {
        await page.reattach();
      } catch {
        /* fall through: return detached page, caller reports error */
      }
    }
    this.activePageId = page.targetId;
    return page;
  }

  async newPage(url = 'about:blank') {
    await this.ensure();
    const { targetId } = await this.send('Target.createTarget', { url });
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const page = this.pages.get(targetId);
      if (page?.sessionId) {
        this.activePageId = targetId;
        return page;
      }
      await sleep(50);
    }
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const page = this.ensurePage(targetId, sessionId);
    this.activePageId = targetId;
    return page;
  }

  async activatePage(target) {
    const page = await this.page(target);
    await this.send('Target.activateTarget', { targetId: page.targetId });
    this.activePageId = page.targetId;
    return page;
  }

  async closePage(target) {
    const page = await this.page(target);
    try {
      await this.send('Target.closeTarget', { targetId: page.targetId });
    } finally {
      this.pages.delete(page.targetId);
      if (this.activePageId === page.targetId) this.activePageId = null;
    }
    return { closed: page.targetId };
  }

  async listPages() {
    await this.ensure();
    await this.syncTargets();
    return [...this.pages.values()].map((p) => p.toJSON());
  }

  /* ------------------------------------------------------------------ *
   * teardown
   * ------------------------------------------------------------------ */

  /**
   * Disconnect. If we launched the browser ourselves, close it (unless keepBrowser).
   */
  async stop({ kill = true, keepBrowser = false } = {}) {
    const pid = this.chromePid;
    const launched = this.launched;
    if (launched && !keepBrowser) {
      try {
        if (this.connected) await this.send('Browser.close', {}, undefined, { timeout: 3000 });
      } catch {
        /* ignore */
      }
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.connected = false;
    this.ws = null;
    this.pending.clear();
    if (launched && !keepBrowser && kill && pid) {
      await sleep(600);
      if (isAlive(pid)) killTree(pid);
    }
    this.chromePid = null;
    this.launched = false;
    this.pages.clear();
    this.activePageId = null;
    this.versionInfo = null;
  }

  async status() {
    return {
      endpoint: this.endpoint,
      connected: this.connected,
      launchedByPlugin: this.launched,
      chromePid: this.chromePid,
      profileDir: this.profileDir,
      browser: this.versionInfo?.Browser || null,
      protocolVersion: this.versionInfo?.['Protocol-Version'] || null,
      userAgent: this.versionInfo?.['User-Agent'] || null,
      activePage: this.activePageId,
      pages: [...this.pages.values()].map((p) => p.toJSON()),
    };
  }
}

/** One flatten-mode page target. */
export class PageHandle {
  constructor(browser, targetId, sessionId, info) {
    this.browser = browser;
    this.targetId = targetId;
    this.sessionId = sessionId || null;
    this.info = info || null;
    this.detached = !this.sessionId;
    this.listeners = new Set();
    this.enabled = new Set();
    this.lastUrl = info?.url || '';
    this.lastTitle = info?.title || '';
  }

  send(method, params = {}, opts = {}) {
    if (!this.sessionId) {
      throw new CdpError(`Tab ${this.targetId} is detached; re-open it with omni_open`, { method });
    }
    return this.browser.send(method, params, this.sessionId, opts);
  }

  async reattach() {
    const { sessionId } = await this.browser.send('Target.attachToTarget', {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = sessionId;
    this.detached = false;
    return this;
  }

  /** Subscribe to one CDP event (or '*' for all). Returns unsubscribe. */
  on(method, fn) {
    const listener = { method: method || '*', fn };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method, params) {
    for (const listener of this.listeners) {
      if (listener.method === '*' || listener.method === method) {
        try {
          listener.fn({ method, params });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /** Wait for one matching event. */
  waitEvent(method, { timeout = 30000, predicate = null } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new CdpError(`Timed out after ${timeout}ms waiting for ${method}`));
      }, timeout);
      const off = this.on(method, (event) => {
        if (predicate && !predicate(event.params)) return;
        clearTimeout(timer);
        off();
        resolve(event.params);
      });
    });
  }

  async enableDomains(want = {}) {
    const map = {
      page: 'Page.enable',
      runtime: 'Runtime.enable',
      network: 'Network.enable',
      log: 'Log.enable',
      dom: 'DOM.enable',
      accessibility: 'Accessibility.enable',
      performance: 'Performance.enable',
      security: 'Security.enable',
      debugger: 'Debugger.enable',
    };
    for (const [domain, command] of Object.entries(map)) {
      if (!want[domain] || this.enabled.has(domain)) continue;
      try {
        await this.send(command, {});
        this.enabled.add(domain);
      } catch {
        /* some domains are unavailable; callers degrade gracefully */
      }
    }
    return [...this.enabled];
  }

  /** Enable the domains every higher-level module can rely on. */
  async ensureCore() {
    return this.enableDomains({ page: true, runtime: true, network: true, log: true });
  }

  /** Evaluate an expression in the main world and return its value. */
  async evaluate(expression, opts = {}) {
    await this.enableDomains({ runtime: true });
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression: String(expression),
        awaitPromise: opts.awaitPromise !== false,
        returnByValue: opts.returnByValue !== false,
        userGesture: opts.userGesture !== false,
        allowUnsafeEvalBlockedByCSP: opts.allowUnsafeEval !== false,
        ...(opts.contextId ? { contextId: opts.contextId } : {}),
      },
      { timeout: opts.timeout ?? this.browser.config.timeout },
    );
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const text = details.exception?.description || details.text || 'evaluation failed';
      throw new CdpError(`Page evaluation failed: ${text}`, { data: details });
    }
    const remote = result.result || {};
    if (opts.returnByValue === false) return remote;
    return remote.value === undefined ? undefined : remote.value;
  }

  /** Navigate the tab and wait for a lifecycle milestone. */
  async goto(url, opts = {}) {
    await this.ensureCore();
    const timeout = opts.timeout ?? 45000;
    const waitUntil = opts.waitUntil || 'load';
    const target = new URL(url, (this.lastUrl || 'about:blank')).href;

    let waiter = Promise.resolve();
    if (waitUntil !== 'none') {
      const eventName = waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
      waiter = new Promise((resolve) => {
        const timer = setTimeout(() => {
          off();
          resolve();
        }, timeout);
        const off = this.on(eventName, () => {
          clearTimeout(timer);
          off();
          resolve();
        });
        this._pendingNavOff = off;
      });
    }
    let nav;
    try {
      nav = await this.send('Page.navigate', { url: target }, { timeout });
    } catch (err) {
      if (this._pendingNavOff) this._pendingNavOff();
      throw err;
    }
    if (nav.errorText) {
      if (this._pendingNavOff) this._pendingNavOff();
      throw new CdpError(`Navigation failed: ${nav.errorText} (${target})`, { method: 'Page.navigate' });
    }
    await waiter;
    if (waitUntil === 'networkidle') await this.waitNetworkIdle(opts.idleMs ?? 800, Math.min(timeout, 15000));
    if (opts.settle) await sleep(opts.settle);
    this.lastUrl = nav.url || target;
    return { url: this.lastUrl, frameId: nav.frameId, loaderId: nav.loaderId };
  }

  /** Resolve when no network request has started for `idleMs`. */
  async waitNetworkIdle(idleMs = 800, timeout = 15000) {
    await this.enableDomains({ network: true });
    return new Promise((resolve) => {
      let timer = setTimeout(done, idleMs);
      const off = this.on('Network.requestWillBeSent', () => {
        clearTimeout(timer);
        timer = setTimeout(done, idleMs);
      });
      const hardStop = setTimeout(done, timeout);
      function done() {
        clearTimeout(timer);
        clearTimeout(hardStop);
        off();
        resolve();
      }
    });
  }

  async title() {
    return this.evaluate('document.title');
  }

  async url() {
    return this.evaluate('location.href');
  }

  currentUrl() {
    return this.lastUrl || this.info?.url || '';
  }

  async reload(opts = {}) {
    await this.ensureCore();
    await this.send('Page.reload', { ignoreCache: opts.ignoreCache !== false }, { timeout: opts.timeout ?? 45000 });
    await sleep(opts.settle ?? 500);
    return { url: this.currentUrl() };
  }

  async goBack() {
    await this.evaluate('history.back()').catch(() => {});
    await sleep(600);
    return { url: this.currentUrl() };
  }

  async goForward() {
    await this.evaluate('history.forward()').catch(() => {});
    await sleep(600);
    return { url: this.currentUrl() };
  }

  async frames() {
    const { frameTree } = await this.send('Page.getFrameTree');
    const out = [];
    const walk = (node, parentId) => {
      if (!node?.frame) return;
      out.push({
        id: node.frame.id,
        parentId: parentId || null,
        url: node.frame.url || node.frame.unreachableUrl || '',
        name: node.frame.name || '',
        securityOrigin: node.frame.securityOrigin || '',
        mimeType: node.frame.mimeType || '',
      });
      for (const child of node.childFrames || []) walk(child, node.frame.id);
    };
    walk(frameTree, null);
    return out;
  }

  async layoutMetrics() {
    return this.send('Page.getLayoutMetrics');
  }

  async targetInfo() {
    const { targetInfo } = await this.send('Target.getTargetInfo', { targetId: this.targetId });
    return targetInfo;
  }

  toJSON() {
    return {
      targetId: this.targetId,
      attached: Boolean(this.sessionId),
      url: this.currentUrl(),
      title: this.lastTitle || this.info?.title || '',
      type: this.info?.type || 'page',
    };
  }
}

/** Create + start a session in one call (used by tests and module smoke tests). */
export async function startBrowser(config = {}) {
  const session = new BrowserSession(config);
  await session.ensure();
  return session;
}
