// dsh-omni-browser / lib/shots.js
// Screenshots (viewport / full page / element / clip) and screencast recording.
// Zero dependencies: only node:* builtins and lib/util.js helpers.
import path from 'node:path';
import { writeBinary, writeJson, ensureDir, makeOutputDir, resolveDir, localStamp, sleep, fileSize } from './util.js';

const FORMATS = new Set(['png', 'jpeg']);
const MAX_TEXTURE = 16000; // Chrome texture limit is 16384px; leave a little headroom.

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeFormat(format) {
  const f = String(format || 'png').toLowerCase();
  if (f === 'jpg') return 'jpeg';
  return FORMATS.has(f) ? f : 'png';
}

function extFor(format) {
  return format === 'jpeg' ? 'jpg' : 'png';
}

async function outputDir(dir, name) {
  if (dir) {
    const abs = path.resolve(resolveDir(dir) || dir);
    await ensureDir(abs);
    return abs;
  }
  return makeOutputDir({ name });
}

function defaultName(format, prefix = 'shot') {
  const ms = String(Date.now() % 1000).padStart(3, '0');
  return `${prefix}-${localStamp()}-${ms}.${extFor(format)}`;
}

function targetFile(dir, filename, format, prefix = 'shot') {
  if (!filename) return path.join(dir, defaultName(format, prefix));
  const name = String(filename);
  if (path.isAbsolute(name)) return name;
  const withExt = path.extname(name) ? name : `${name}.${extFor(format)}`;
  return path.join(dir, withExt);
}

/** True pixel size of an encoded PNG, or null. */
function pngPixelSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** True pixel size of an encoded JPEG (scans for a SOFn marker), or null. */
function jpegPixelSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let off = 2;
  while (off + 9 < buf.length) {
    if (buf[off] !== 0xff) {
      off += 1;
      continue;
    }
    const marker = buf[off + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    const len = buf.readUInt16BE(off + 2);
    if (len < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  return null;
}

function pixelSizeOf(buf, format) {
  return format === 'jpeg' ? jpegPixelSize(buf) : pngPixelSize(buf);
}

async function viewportSize(page) {
  try {
    const lm = await page.layoutMetrics();
    const vv = lm.cssVisualViewport || lm.visualViewport;
    const lv = lm.cssLayoutViewport || lm.layoutViewport;
    const width = Math.round(vv?.clientWidth || lv?.clientWidth || 0);
    const height = Math.round(vv?.clientHeight || lv?.clientHeight || 0);
    if (width > 0 && height > 0) return { width, height };
  } catch {
    /* fall through to page evaluation */
  }
  const size = await page.evaluate('({width: Math.max(innerWidth, document.documentElement.clientWidth), height: Math.max(innerHeight, document.documentElement.clientHeight), dpr: devicePixelRatio || 1})');
  return { width: Math.round(size.width) || 1, height: Math.round(size.height) || 1, dpr: size.dpr };
}

async function contentSize(page) {
  try {
    const lm = await page.layoutMetrics();
    const size = lm.cssContentSize || lm.contentSize;
    if (size && size.width > 0 && size.height > 0) {
      return { width: Math.ceil(size.width), height: Math.ceil(size.height) };
    }
  } catch {
    /* fall through */
  }
  const size = await page.evaluate(
    '({width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)})',
  );
  return { width: Math.ceil(size.width) || 1, height: Math.ceil(size.height) || 1 };
}

/** One Page.captureScreenshot with a graceful downscale retry for oversized clips. */
async function capture(page, params, meta = {}) {
  try {
    return await page.send('Page.captureScreenshot', params, { timeout: 60000 });
  } catch (err) {
    const clip = params.clip;
    const huge = clip && (clip.width > MAX_TEXTURE / 4 || clip.height > MAX_TEXTURE / 4);
    if (huge && (!clip.scale || clip.scale === 1)) {
      const scale = Math.max(0.05, Math.min(1, MAX_TEXTURE / Math.max(clip.width, clip.height)));
      const retry = { ...params, clip: { ...clip, scale: Math.floor(scale * 1000) / 1000 } };
      const res = await page.send('Page.captureScreenshot', retry, { timeout: 90000 });
      return { ...res, __scaled: retry.clip.scale, __retryReason: err.message, ...meta };
    }
    throw err;
  }
}

/**
 * Capture a screenshot.
 * mode: 'viewport' | 'fullpage' | 'element' | 'clip'
 * returns {path, bytes, width, height, format, pixelWidth?, pixelHeight?, scale?, warning?}
 */
export async function screenshot(page, opts = {}) {
  if (!page || typeof page.send !== 'function') throw new Error('screenshot: a PageHandle is required');
  const format = normalizeFormat(opts.format);
  const quality = clampInt(opts.quality, 80, 0, 100);
  const mode = String(opts.mode || 'viewport').toLowerCase();
  const dir = await outputDir(opts.dir, opts.name || 'screenshots');
  const params = { format, fromSurface: true };
  if (format === 'jpeg') params.quality = quality;

  let clip = null;
  let warning = null;
  let scale = 1;
  try {
    await page.enableDomains({ page: true });
    if (mode === 'viewport' || mode === 'viewport-only') {
      const vp = await viewportSize(page);
      params.captureBeyondViewport = false;
      clip = { x: 0, y: 0, width: vp.width, height: vp.height };
    } else if (mode === 'fullpage' || mode === 'full' || mode === 'full-page') {
      const cs = await contentSize(page);
      scale = 1;
      if (Math.max(cs.width, cs.height) > MAX_TEXTURE) {
        scale = Math.max(0.02, Math.floor((MAX_TEXTURE / Math.max(cs.width, cs.height)) * 1000) / 1000);
        warning = `page is ${cs.width}x${cs.height} CSS px; downscaled to scale ${scale} to stay under Chrome's texture limit`;
      }
      clip = { x: 0, y: 0, width: cs.width, height: cs.height, scale };
      params.clip = clip;
      params.captureBeyondViewport = true;
    } else if (mode === 'element') {
      const selector = opts.selector || (opts.clip && opts.clip.selector);
      if (!selector) throw new Error('screenshot mode "element" requires a selector');
      const info = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(String(selector))});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const sx = window.scrollX || window.pageXOffset || 0;
        const sy = window.scrollY || window.pageYOffset || 0;
        return { x: r.left + sx, y: r.top + sy, width: r.width, height: r.height, dpr: devicePixelRatio || 1 };
      })()`);
      if (!info) throw new Error(`element not found for selector: ${selector}`);
      const x = Math.max(0, Math.floor(info.x));
      const y = Math.max(0, Math.floor(info.y));
      const width = Math.max(1, Math.ceil(info.width + (info.x - x)));
      const height = Math.max(1, Math.ceil(info.height + (info.y - y)));
      clip = { x, y, width, height, scale: 1 };
      params.clip = clip;
      params.captureBeyondViewport = true;
    } else if (mode === 'clip') {
      const c = opts.clip || {};
      const x = Math.max(0, Number(c.x) || 0);
      const y = Math.max(0, Number(c.y) || 0);
      const width = Math.ceil(Number(c.width) || 0);
      const height = Math.ceil(Number(c.height) || 0);
      if (!(width > 0) || !(height > 0)) throw new Error('screenshot mode "clip" requires clip {x, y, width>0, height>0}');
      scale = Number(c.scale) > 0 ? Number(c.scale) : 1;
      clip = { x, y, width, height, scale };
      params.clip = clip;
      params.captureBeyondViewport = true;
    } else {
      throw new Error(`unknown screenshot mode "${mode}" (expected viewport | fullpage | element | clip)`);
    }

    const result = await capture(page, params);
    const buf = Buffer.from(result.data || '', 'base64');
    if (!buf.length) throw new Error('Chrome returned an empty screenshot');
    const file = targetFile(dir, opts.filename, format);
    const savedPath = await writeBinary(file, buf);
    const px = pixelSizeOf(buf, format);
    const out = {
      path: savedPath,
      bytes: buf.length,
      width: clip.width,
      height: clip.height,
      format,
      mode,
    };
    if (scale !== 1 || result.__scaled) out.scale = result.__scaled || scale;
    if (px) {
      out.pixelWidth = px.width;
      out.pixelHeight = px.height;
    }
    if (warning) out.warning = warning;
    if (opts.quality !== undefined && format === 'jpeg') out.quality = quality;
    return out;
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    throw new Error(`screenshot failed (mode=${mode}): ${detail}`);
  }
}

/** Full-page screenshot shortcut. */
export async function captureFullPage(page, opts = {}) {
  return screenshot(page, { ...opts, mode: 'fullpage' });
}

/**
 * Start a screencast. Each frame is acked immediately, then written to <dir>/frames/.
 * Returns {dir, frames, startedAt, stop({reason}) → {dir, frames, durationMs, frameCount, manifestPath}}.
 */
export async function startScreencast(page, opts = {}) {
  if (!page || typeof page.send !== 'function') throw new Error('startScreencast: a PageHandle is required');
  const format = normalizeFormat(opts.format && opts.format !== 'png' ? opts.format : 'jpeg');
  const quality = clampInt(opts.quality, 70, 0, 100);
  const maxWidth = clampInt(opts.maxWidth, 1280, 16, 10000);
  const maxHeight = opts.maxHeight ? clampInt(opts.maxHeight, 0, 16, 10000) : null;
  const everyNthFrame = clampInt(opts.everyNthFrame, 1, 1, 60);
  const dir = await outputDir(opts.dir, opts.name || 'screencast');
  const framesDir = path.join(dir, 'frames');
  await ensureDir(framesDir);

  const state = {
    dir,
    framesDir,
    frames: [],
    format,
    quality,
    maxWidth,
    startedAt: Date.now(),
    startedAtIso: new Date().toISOString(),
    stopped: false,
    stopping: null,
    stopError: null,
    dropped: 0,
  };
  const maxFrames = opts.maxFrames ? clampInt(opts.maxFrames, 20000, 1, 100000) : 20000;
  let writeChain = Promise.resolve();
  let seq = 0;

  await page.enableDomains({ page: true });

  const onFrame = (event) => {
    const params = event && event.params;
    if (!params || state.stopped) return;
    // Ack first: without this Chrome stops sending frames after a few.
    if (params.sessionId !== undefined) {
      page.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    }
    if (!params.data) return;
    if (state.frames.length >= maxFrames) {
      state.dropped += 1;
      return;
    }
    seq += 1;
    const file = path.join(framesDir, `frame-${String(seq).padStart(4, '0')}.${extFor(format)}`);
    const buf = Buffer.from(params.data, 'base64');
    const tsSeconds = params.metadata && Number.isFinite(params.metadata.timestamp) ? params.metadata.timestamp : null;
    const frame = {
      path: file,
      bytes: buf.length,
      timestamp: tsSeconds != null ? new Date(tsSeconds * 1000).toISOString() : new Date().toISOString(),
      seq,
    };
    state.frames.push(frame);
    writeChain = writeChain.then(() => writeBinary(file, buf)).catch((err) => {
      frame.error = err && err.message ? err.message : String(err);
    });
  };

  const off = page.on('Page.screencastFrame', onFrame);
  const params = { format, quality, maxWidth, everyNthFrame };
  if (maxHeight) params.maxHeight = maxHeight;
  try {
    await page.send('Page.startScreencast', params, { timeout: 15000 });
  } catch (err) {
    off();
    throw new Error(`startScreencast failed: ${err && err.message ? err.message : err}`);
  }

  async function stop() {
    if (state.stopping) return state.stopping;
    state.stopping = (async () => {
      if (state.stopped) return state.result;
      state.stopped = true;
      off();
      try {
        await page.send('Page.stopScreencast', {}, { timeout: 15000 });
      } catch (err) {
        state.stopError = err && err.message ? err.message : String(err);
      }
      await writeChain;
      for (const frame of state.frames) {
        const size = await fileSize(frame.path);
        if (size > 0) frame.bytes = size;
      }
      const durationMs = Date.now() - state.startedAt;
      const manifest = {
        dir,
        format,
        quality,
        maxWidth,
        everyNthFrame,
        frameCount: state.frames.length,
        durationMs,
        startedAt: state.startedAtIso,
        stoppedAt: new Date().toISOString(),
        stopError: state.stopError,
        dropped: state.dropped,
        frames: state.frames,
      };
      const manifestPath = await writeJson(path.join(dir, 'screencast.json'), manifest);
      state.result = {
        dir,
        frames: state.frames,
        durationMs,
        frameCount: state.frames.length,
        manifestPath,
        format,
        quality,
        maxWidth,
        dropped: state.dropped,
      };
      if (state.stopError) state.result.stopError = state.stopError;
      return state.result;
    })();
    return state.stopping;
  }

  return {
    dir,
    framesDir,
    frames: state.frames,
    format,
    quality,
    maxWidth,
    startedAt: state.startedAtIso,
    stop,
  };
}

/** Start a screencast, wait `durationMs`, stop it and return the full manifest. */
export async function record(page, opts = {}) {
  const durationMs = Math.max(100, Number(opts.durationMs) || 5000);
  const handle = await startScreencast(page, opts);
  let result;
  try {
    await sleep(durationMs);
  } finally {
    result = await handle.stop();
  }
  return result;
}
