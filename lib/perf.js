// dsh-omni-browser / lib/perf.js
// Performance metrics, DevTools timeline tracing, JS/CSS coverage and resource summary.
// Zero dependencies: only node:* builtins and lib/util.js helpers.
import path from 'node:path';
import { writeText, ensureDir, makeOutputDir, resolveDir, fileSize, sleep } from './util.js';

function errText(err) {
  return err && err.message ? err.message : String(err);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function outputDir(dir, name) {
  if (dir) {
    const abs = path.resolve(resolveDir(dir) || dir);
    await ensureDir(abs);
    return abs;
  }
  return makeOutputDir({ name });
}

/** Current Performance domain counters as a flat {Name: value} map. */
export async function metrics(page) {
  if (!page || typeof page.send !== 'function') throw new Error('metrics: a PageHandle is required');
  const timestamp = new Date().toISOString();
  try {
    await page.send('Performance.enable', {}, { timeout: 10000 });
    const result = await page.send('Performance.getMetrics', {}, { timeout: 10000 });
    const out = {};
    for (const item of result.metrics || []) out[item.name] = item.value;
    return { timestamp, metrics: out, names: Object.keys(out), url: page.currentUrl ? page.currentUrl() : '' };
  } catch (err) {
    return { timestamp, metrics: {}, names: [], error: errText(err) };
  }
}

/**
 * Record a Chrome trace (default category devtools.timeline) for `durationMs`.
 * The full event array is written to <dir>/<filename> as {traceEvents, metadata}.
 * returns {path, bytes, events: <event count>, durationMs, categories, dropped?}
 */
export async function trace(page, opts = {}) {
  if (!page || typeof page.send !== 'function') throw new Error('trace: a PageHandle is required');
  const durationMs = Math.max(50, num(opts.durationMs, 2000));
  const categories = opts.categories || 'devtools.timeline';
  const maxEvents = Math.max(1, num(opts.maxEvents, 200000));
  const dir = await outputDir(opts.dir, opts.name || 'trace');
  const filename = opts.filename ? String(opts.filename) : `trace-${Date.now()}.json`;
  const file = path.isAbsolute(filename) ? filename : path.join(dir, path.extname(filename) ? filename : `${filename}.json`);

  const events = [];
  let dropped = 0;
  let dataOff = () => {};
  let completePromise = null;
  const capturedAt = new Date().toISOString();
  const startedAt = Date.now();
  let startError = null;

  try {
    await page.send('Tracing.start', { categories, transferMode: 'ReportEvents' }, { timeout: 15000 });
  } catch (err) {
    startError = errText(err);
  }
  if (startError) throw new Error(`trace failed to start: ${startError}`);

  dataOff = page.on('Tracing.dataCollected', (event) => {
    const values = event && event.params && event.params.value;
    if (!Array.isArray(values)) return;
    for (const value of values) {
      if (events.length < maxEvents) events.push(value);
      else dropped += 1;
    }
  });
  completePromise = page.waitEvent('Tracing.tracingComplete', { timeout: durationMs + 30000 }).catch((err) => ({ __error: errText(err) }));

  try {
    await sleep(durationMs);
    await page.send('Tracing.end', {}, { timeout: 15000 });
  } catch (err) {
    dataOff();
    await completePromise;
    throw new Error(`trace failed while recording: ${errText(err)}`);
  }
  const complete = await completePromise;
  dataOff();
  if (complete && complete.__error) throw new Error(`trace did not complete: ${complete.__error}`);

  const traceDurationMs = Date.now() - startedAt;
  const payload = {
    traceEvents: events,
    metadata: {
      source: 'dsh-omni-browser',
      url: page.currentUrl ? page.currentUrl() : '',
      categories,
      requestedDurationMs: durationMs,
      durationMs: traceDurationMs,
      eventCount: events.length,
      dropped,
      startedAt: capturedAt,
    },
  };
  // Compact JSON on purpose: timeline traces are large and pretty-printing wastes space.
  const savedPath = await writeText(file, JSON.stringify(payload));
  const bytes = await fileSize(savedPath);
  const out = { path: savedPath, bytes, events: events.length, durationMs: traceDurationMs, categories };
  if (dropped) out.dropped = dropped;
  return out;
}

function mapJsCoverage(result, maxFunctions) {
  return (result || []).map((entry) => {
    const functions = entry.functions || [];
    const root = functions[0] && functions[0].ranges ? functions[0].ranges : [];
    const totalBytes = root.length ? Math.max(...root.map((r) => Number(r.endOffset) || 0)) : 0;
    const mapped = functions.slice(0, maxFunctions).map((fn) => ({
      functionName: fn.functionName || '(anonymous)',
      isBlockCoverage: Boolean(fn.isBlockCoverage),
      ranges: (fn.ranges || []).map((r) => ({ startOffset: r.startOffset, endOffset: r.endOffset, count: r.count })),
    }));
    const out = { scriptId: entry.scriptId, url: entry.url || '', totalBytes, functionCount: functions.length, functions: mapped };
    if (functions.length > mapped.length) out.functionsTruncated = functions.length - mapped.length;
    return out;
  });
}

/**
 * Measure precise JS coverage + CSS rule usage over `durationMs`.
 * Domains that are unavailable degrade to [] with `<kind>Supported:false`
 * and an entry in `unsupported` instead of throwing.
 * returns {js:[…], css:[…], jsSupported, cssSupported, unsupported:[…], jsError?, cssError?}
 */
export async function coverage(page, opts = {}) {
  if (!page || typeof page.send !== 'function') throw new Error('coverage: a PageHandle is required');
  const durationMs = Math.max(0, num(opts.durationMs, 1000));
  const maxFunctions = Math.max(1, num(opts.maxFunctions, 200));
  const maxRules = Math.max(1, num(opts.maxRules, 5000));
  const out = { js: [], css: [], jsSupported: false, cssSupported: false, unsupported: [] };
  const capturedAt = new Date().toISOString();

  try {
    await page.send('Profiler.enable', {}, { timeout: 10000 });
    await page.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true, allowTriggeredUpdates: false }, { timeout: 10000 });
    out.jsSupported = true;
  } catch (err) {
    out.jsError = errText(err);
    out.unsupported.push('js');
  }

  try {
    await page.enableDomains({ dom: true });
    await page.send('CSS.enable', {}, { timeout: 10000 });
    await page.send('CSS.startRuleUsageTracking', {}, { timeout: 10000 });
    out.cssSupported = true;
  } catch (err) {
    out.cssError = errText(err);
    out.unsupported.push('css');
  }

  if (out.jsSupported || out.cssSupported) await sleep(durationMs);

  if (out.jsSupported) {
    try {
      const result = await page.send('Profiler.takePreciseCoverage', {}, { timeout: 20000 });
      out.js = mapJsCoverage(result.result || [], maxFunctions);
      out.jsTimestamp = result.timestamp;
    } catch (err) {
      out.jsError = errText(err);
      out.js = [];
      if (!out.unsupported.includes('js')) out.unsupported.push('js');
      out.jsSupported = false;
    }
    try {
      await page.send('Profiler.stopPreciseCoverage', {}, { timeout: 10000 });
    } catch {
      /* best effort */
    }
  }

  if (out.cssSupported) {
    try {
      const result = await page.send('CSS.stopRuleUsageTracking', {}, { timeout: 20000 });
      out.css = (result.ruleUsage || []).slice(0, maxRules).map((rule) => ({
        styleSheetId: rule.styleSheetId,
        startOffset: rule.startOffset,
        endOffset: rule.endOffset,
        used: Boolean(rule.used),
      }));
      if (result.ruleUsage && result.ruleUsage.length > out.css.length) out.cssTruncated = result.ruleUsage.length - out.css.length;
    } catch (err) {
      out.cssError = errText(err);
      out.css = [];
      if (!out.unsupported.includes('css')) out.unsupported.push('css');
      out.cssSupported = false;
    }
  }

  out.capturedAt = capturedAt;
  out.durationMs = durationMs;
  if (out.js.length) out.jsScripts = out.js.length;
  if (out.css.length) out.cssUsed = out.css.filter((r) => r.used).length;
  return out;
}

// Chrome's Page.getResourceTree is unreliable on recent builds (observed on Chrome 156:
// it only lists a fraction of the loaded resources), so resourceSummary is a hybrid of
// the frame-tree resource list, frame documents and the in-page Resource Timing API.
const CANONICAL_TYPES = [
  'Document', 'Stylesheet', 'Image', 'Media', 'Font', 'Script', 'TextTrack', 'XHR',
  'Fetch', 'Prefetch', 'EventSource', 'WebSocket', 'Manifest', 'SignedExchange',
  'Ping', 'CSPViolationReport', 'Other',
];
const INITIATOR_TO_TYPE = {
  fetch: 'XHR',
  xmlhttprequest: 'XHR',
  xhr: 'XHR',
  img: 'Image',
  image: 'Image',
  script: 'Script',
  link: 'Stylesheet',
  css: 'Stylesheet',
  iframe: 'Document',
  frame: 'Document',
  navigation: 'Document',
  audio: 'Media',
  video: 'Media',
  beacon: 'Ping',
  eventsource: 'EventSource',
  websocket: 'WebSocket',
  manifest: 'Manifest',
  texttrack: 'TextTrack',
};

function normalizeResourceType(raw, fallback = 'Other') {
  if (!raw) return fallback;
  const key = String(raw).toLowerCase();
  if (INITIATOR_TO_TYPE[key]) return INITIATOR_TO_TYPE[key];
  const canonical = CANONICAL_TYPES.find((t) => t.toLowerCase() === key);
  return canonical || fallback;
}

function addResource(ctx, url, type, mimeType, size) {
  if (!url || typeof url !== 'string') return;
  const bytes = Math.max(0, Number(size) || 0);
  const existing = ctx.byUrl.get(url);
  if (existing) {
    // A later source may know the decoded size / MIME type the earlier one lacked.
    if (!existing.size && bytes) existing.size = bytes;
    if (!existing.mimeType && mimeType) existing.mimeType = mimeType;
    if (!existing.type || existing.type === 'Other') existing.type = normalizeResourceType(type);
    return;
  }
  const entry = {
    url,
    type: normalizeResourceType(type),
    mimeType: mimeType || '',
    size: bytes,
  };
  ctx.byUrl.set(url, entry);
  ctx.entries.push(entry);
}

function walkFrameTree(node, ctx) {
  if (!node) return;
  const frame = node.frame || node;
  // getResourceTree normally lists the frame's Document too, but not on every build.
  if (frame && frame.url) {
    addResource(ctx, frame.url, 'Document', frame.mime || frame.mimeType || '', 0);
  }
  for (const resource of node.resources || []) {
    addResource(ctx, resource.url, resource.type, resource.mimeType, resource.contentSize);
  }
  for (const child of node.childFrames || []) walkFrameTree(child, ctx);
}

/**
 * Summarize every resource loaded by the page (main frame + child frames).
 * Combines Page.getResourceTree, frame documents and performance.getEntriesByType('resource')
 * because no single source reports a complete list. Deduplicated by URL.
 * returns {count, totalBytes, byType:{type:{count,bytes}}, entries:[{url,type,mimeType,size}], sources}
 */
export async function resourceSummary(page, opts = {}) {
  if (!page || typeof page.send !== 'function') throw new Error('resourceSummary: a PageHandle is required');
  const maxEntries = Math.max(1, num(opts.maxEntries, 5000));
  const ctx = { entries: [], byUrl: new Map() };
  const out = { count: 0, totalBytes: 0, byType: {}, entries: ctx.entries, sources: [] };

  try {
    await page.enableDomains({ page: true });
    const result = await page.send('Page.getResourceTree', {}, { timeout: 15000 });
    walkFrameTree(result.frameTree, ctx);
    out.sources.push('resource-tree');
  } catch (err) {
    out.resourceTreeError = errText(err);
  }

  try {
    // Sizes here are transfer sizes; prefer the decoded contentSize from the resource tree.
    const perfEntries = await page.evaluate(`(() => performance.getEntriesByType('resource').map((e) => ({
      url: e.name,
      type: e.initiatorType || 'other',
      mimeType: '',
      size: (e.transferSize || e.encodedBodySize || e.decodedBodySize || 0) || 0
    })))()`);
    for (const item of perfEntries || []) {
      if (item && item.url) addResource(ctx, item.url, item.type, item.mimeType, item.size);
    }
    out.sources.push('performance-api');
  } catch (err) {
    out.performanceError = errText(err);
  }

  // Last resort: at least report the document itself even if both CDP sources failed.
  const currentUrl = typeof page.currentUrl === 'function' ? page.currentUrl() : '';
  if (currentUrl && !ctx.byUrl.has(currentUrl)) {
    addResource(ctx, currentUrl, 'Document', '', 0);
    out.sources.push('current-url');
  }

  if (!ctx.entries.length) {
    out.error = out.resourceTreeError || out.performanceError || 'no resources reported by any source';
    return out;
  }

  for (const entry of ctx.entries) {
    const bucket = out.byType[entry.type] || (out.byType[entry.type] = { count: 0, bytes: 0 });
    bucket.count += 1;
    bucket.bytes += entry.size;
    out.totalBytes += entry.size;
  }
  out.count = ctx.entries.length;
  if (ctx.entries.length > maxEntries) {
    out.truncated = ctx.entries.length - maxEntries;
    ctx.entries.length = maxEntries;
    out.count = maxEntries;
  }
  return out;
}
