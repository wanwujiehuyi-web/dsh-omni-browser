// dsh-omni-browser / lib/downloads.js
// Download directory + download tracking through the *browser-level*
// Browser.setDownloadBehavior / Browser.downloadWillBegin / Browser.downloadProgress.
// Zero dependencies: only node:* builtins and lib/util.js helpers.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, makeOutputDir, resolveDir, fileSize } from './util.js';

const stores = new WeakMap(); // BrowserSession -> download store (shared by all its pages)

function browserOf(page) {
  return (page && page.browser) || page;
}

function errText(err) {
  return err && err.message ? err.message : String(err);
}

function isTerminal(info) {
  return info.state === 'completed' || info.state === 'canceled' || info.state === 'interrupted';
}

function newRecord(guid, params = {}) {
  return {
    guid,
    downloadId: params.downloadId || null,
    suggestedFilename: params.suggestedFilename || '',
    url: params.url || '',
    frameId: params.frameId || null,
    state: 'inProgress',
    path: null,
    bytes: 0,
    totalBytes: 0,
    receivedBytes: 0,
    startedAt: Date.now(),
    startedAtIso: new Date().toISOString(),
    updatedAt: Date.now(),
    completedAt: null,
    dir: null,
  };
}

/** Resolve the real file name/size (Chrome may rename to "sample (1).txt"). */
async function resolveDownloadedFile(dir, suggestedFilename) {
  if (!dir) return { path: null, bytes: 0 };
  if (suggestedFilename) {
    const candidate = path.join(dir, suggestedFilename);
    try {
      const st = await fsp.stat(candidate);
      if (st.isFile()) return { path: candidate, bytes: st.size };
    } catch {
      /* Chrome may have uniquified the name */
    }
  }
  try {
    const names = await fsp.readdir(dir);
    const files = [];
    for (const name of names) {
      if (name.endsWith('.crdownload') || name.endsWith('.tmp')) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (st.isFile()) files.push({ path: full, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* raced with Chrome */
      }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    if (files.length) {
      // Prefer a file whose name shares the suggested basename prefix.
      if (suggestedFilename) {
        const stem = path.basename(suggestedFilename, path.extname(suggestedFilename));
        const match = files.find((f) => path.basename(f.path).startsWith(stem));
        if (match) return { path: match.path, bytes: match.size };
      }
      return { path: files[0].path, bytes: files[0].size };
    }
  } catch {
    /* directory missing */
  }
  return { path: null, bytes: 0 };
}

function onBrowserEvent(store, event) {
  const method = event && event.method;
  const params = (event && event.params) || {};
  let info = null;
  if (method === 'Browser.downloadWillBegin' && params.guid) {
    info = newRecord(params.guid, params);
    info.dir = store.dir;
    store.downloads.set(params.guid, info);
    store.startedAt = info.startedAt;
  } else if (method === 'Browser.downloadProgress' && params.guid) {
    info = store.downloads.get(params.guid);
    if (!info) {
      info = newRecord(params.guid, { suggestedFilename: params.suggestedFilename });
      info.dir = store.dir;
      store.downloads.set(params.guid, info);
    }
    if (params.state) info.state = params.state;
    if (Number.isFinite(params.totalBytes)) info.totalBytes = params.totalBytes;
    if (Number.isFinite(params.receivedBytes)) info.receivedBytes = params.receivedBytes;
    info.bytes = Number(params.totalBytes) > 0 ? Number(params.totalBytes) : Number(params.receivedBytes) || 0;
    info.updatedAt = Date.now();
    if (isTerminal(info) && !info.completedAt) info.completedAt = info.updatedAt;
  } else {
    return;
  }
  // Wake matching waiters.
  if (isTerminal(info)) {
    for (const waiter of [...store.waiters]) {
      if (waiter.matches(info)) {
        store.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(info);
      }
    }
  }
}

function ensureStore(page) {
  const browser = browserOf(page);
  if (!browser || typeof browser.on !== 'function') {
    throw new Error('downloads: a PageHandle attached to a BrowserSession is required');
  }
  let store = stores.get(browser);
  if (store) return store;
  store = {
    browser,
    dir: null,
    eventsEnabled: false,
    downloads: new Map(),
    waiters: new Set(),
    startedAt: 0,
    off: null,
  };
  store.off = browser.on((event) => {
    try {
      onBrowserEvent(store, event);
    } catch {
      /* never break the CDP socket */
    }
  });
  stores.set(browser, store);
  return store;
}

/**
 * Point Chrome's downloads at `dir` (browser-level command, applies to every tab)
 * and start collecting Browser.download* events.
 * returns {dir, eventsEnabled}
 */
export async function setDownloadDir(page, dir) {
  const store = ensureStore(page);
  const abs = path.resolve(resolveDir(dir) || makeOutputDir({ name: 'downloads' }));
  await ensureDir(abs);
  const browser = store.browser;
  try {
    await browser.send(
      'Browser.setDownloadBehavior',
      { behavior: 'allow', downloadPath: abs, eventsEnabled: true },
      undefined,
      { timeout: 15000 },
    );
    store.eventsEnabled = true;
  } catch (err) {
    // Older/quirky builds reject eventsEnabled; retry without it (no progress events).
    try {
      await browser.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: abs }, undefined, { timeout: 15000 });
      store.eventsEnabled = false;
      store.warning = `download events unavailable (${errText(err)}); waitForDownload will time out`;
    } catch (retryErr) {
      throw new Error(`setDownloadDir failed: ${errText(retryErr)}`);
    }
  }
  store.dir = abs;
  const out = { dir: abs, eventsEnabled: store.eventsEnabled };
  if (store.warning) out.warning = store.warning;
  return out;
}

async function finalize(store, info) {
  if (!info || !isTerminal(info)) return null;
  if (info.state === 'completed') {
    info.dir = store.dir || info.dir;
    if (!info.path) {
      const resolved = await resolveDownloadedFile(info.dir, info.suggestedFilename);
      if (resolved.path) {
        info.path = resolved.path;
        info.bytes = resolved.bytes;
      }
    }
    if (info.path && (!info.bytes || info.bytes < 0)) info.bytes = await fileSize(info.path);
  }
  return {
    guid: info.guid,
    suggestedFilename: info.suggestedFilename,
    state: info.state,
    path: info.path,
    bytes: info.bytes,
    url: info.url,
    dir: info.dir || store.dir,
    startedAt: info.startedAtIso,
    completedAt: info.completedAt ? new Date(info.completedAt).toISOString() : null,
  };
}

/**
 * Wait for the next download to finish (or be canceled).
 * Handles the common click → wait ordering with a small grace window; a download
 * already in progress when called is waited on too.
 * returns {guid, suggestedFilename, state, path, bytes, …}
 */
export async function waitForDownload(page, opts = {}) {
  const store = ensureStore(page);
  if (!store.dir) {
    await setDownloadDir(page, opts.dir || makeOutputDir({ name: 'downloads' }));
  }
  const timeout = Math.max(100, Number(opts.timeout) || 30000);
  const wantedGuid = opts.guid ? String(opts.guid) : null;
  const graceMs = opts.graceMs != null ? Math.max(0, Number(opts.graceMs)) : 2000;
  const since = opts.since != null ? Number(opts.since) : Date.now() - graceMs;
  const all = [...store.downloads.values()];

  const matchesNow = (info) => {
    if (!isTerminal(info)) return false;
    if (wantedGuid) return info.guid === wantedGuid;
    return (info.completedAt || 0) >= since;
  };

  const already = all.find(matchesNow);
  if (already) return finalize(store, already);

  // A download that started before the call but is still running: wait for that one.
  const inFlight = wantedGuid
    ? all.find((info) => info.guid === wantedGuid && !isTerminal(info))
    : [...all].reverse().find((info) => !isTerminal(info) && info.startedAt >= since);

  return new Promise((resolve, reject) => {
    const waiter = {
      timer: null,
      matches: (info) => (wantedGuid ? info.guid === wantedGuid : inFlight ? info.guid === inFlight.guid : (info.completedAt || 0) >= since),
      resolve: (info) => {
        finalize(store, info).then(resolve, reject);
      },
    };
    waiter.timer = setTimeout(() => {
      store.waiters.delete(waiter);
      const pendingNames = [...store.downloads.values()]
        .filter((info) => !isTerminal(info))
        .map((info) => info.suggestedFilename || info.guid);
      reject(
        new Error(
          `waitForDownload timed out after ${timeout}ms (dir: ${store.dir}${pendingNames.length ? `, in progress: ${pendingNames.join(', ')}` : ', no download seen'})`,
        ),
      );
    }, timeout);
    store.waiters.add(waiter);
  });
}

/** List every download this browser session has seen (newest last). */
export async function listDownloads(page) {
  const store = ensureStore(page);
  const out = [];
  for (const info of store.downloads.values()) {
    const item = await finalize(store, info);
    if (item) out.push(item);
    else
      out.push({
        guid: info.guid,
        suggestedFilename: info.suggestedFilename,
        state: info.state,
        path: null,
        bytes: info.bytes,
        url: info.url,
        dir: store.dir,
        startedAt: info.startedAtIso,
        completedAt: null,
      });
  }
  out.sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
  return out;
}
