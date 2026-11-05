// dsh-omni-browser / lib/snapshot.js
// Page model: turn a live page into compact, JSON-safe structured data
// (text / outline / links / forms / tables / images / meta / resources / AX tree).
//
// Every public function fails with a readable Error (no raw CDP stacks).
// Zero dependencies: only node:* and the plugin's own cdp.js handle API.
import { truncate } from './util.js';

/* ------------------------------------------------------------------ *
 * small helpers
 * ------------------------------------------------------------------ */

function firstLine(err, max = 400) {
  const raw = err && err.message ? err.message : String(err ?? 'unknown error');
  return String(raw).split(/\r?\n/)[0].slice(0, max);
}

/** `page.evaluate` options for a frame-scoped isolated world (or main world). */
function evalOpts(contextId) {
  return contextId ? { contextId } : {};
}

/**
 * Resolve a frameId into an isolated-world execution context id.
 * Isolated worlds share the DOM but are immune to page CSP.
 */
async function frameContext(page, frameId) {
  if (!frameId) return null;
  await page.enableDomains({ page: true });
  let frames = [];
  try {
    frames = await page.frames();
  } catch {
    throw new Error(`无法读取页面 frame 列表（frameId: ${frameId}）`);
  }
  const want = String(frameId);
  const frame =
    frames.find((f) => f.id === want) ||
    frames.find((f) => f.id.startsWith(want)) ||
    frames.find((f) => (f.url || '').includes(want)) ||
    frames.find((f) => (f.name || '') === want);
  if (!frame) throw new Error(`未找到 frame: ${frameId}（可用: ${frames.map((f) => f.id).join(', ')}）`);
  try {
    const { executionContextId } = await page.send('Page.createIsolatedWorld', {
      frameId: frame.id,
      worldName: `omni-snapshot-${Date.now()}`,
      grantUniversalAccess: false,
    });
    return executionContextId;
  } catch (err) {
    throw new Error(`无法在 frame 中创建执行环境 (${frame.url || frame.id}): ${firstLine(err)}`);
  }
}

/* ------------------------------------------------------------------ *
 * in-page helper library, injected into every evaluation
 * ------------------------------------------------------------------ */

const PAGE_LIB = String.raw`
const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const v = collapse(s); return v.length > n ? v.slice(0, n) + '…' : v; };
const absUrl = (u) => { try { return new URL(String(u == null ? '' : u), location.href).href; } catch (e) { return String(u == null ? '' : u); } };
const rootOf = (s) => { if (!s) return document; const el = document.querySelector(s); if (!el) throw new Error('未找到选择器: ' + s); return el; };
const allIn = (root, s) => Array.prototype.slice.call(root.querySelectorAll(s));
const textOf = (el) => { if (!el) return ''; const t = el.innerText != null && el.innerText !== '' ? el.innerText : el.textContent; return collapse(t); };
const visibleOf = (el) => {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return false;
  const cs = getComputedStyle(el);
  if (!cs) return true;
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  if (Number(cs.opacity) === 0) return false;
  return true;
};
const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.x * 100) / 100, y: Math.round(r.y * 100) / 100, width: Math.round(r.width * 100) / 100, height: Math.round(r.height * 100) / 100 };
};
const describeEl = (el) => {
  if (!el) return '';
  const tag = (el.tagName || '').toLowerCase();
  let out = tag;
  if (el.id) out += '#' + el.id;
  const cn = typeof el.className === 'string' ? el.className : '';
  const cls = cn.trim().split(/\s+/).filter(Boolean).slice(0, 3);
  if (cls.length) out += '.' + cls.join('.');
  const t = textOf(el);
  if (t) out += ' "' + clip(t, 60) + '"';
  return out;
};
const labelOf = (el) => {
  if (!el) return '';
  try {
    if (el.labels && el.labels.length) {
      return collapse(Array.prototype.map.call(el.labels, (l) => l.innerText || l.textContent || '').join(' '));
    }
  } catch (e) {}
  try { if (el.closest) { const w = el.closest('label'); if (w) return textOf(w); } } catch (e) {}
  const aria = el.getAttribute ? (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) : '';
  if (aria) {
    const ids = String(aria).split(/\s+/).filter(Boolean);
    const nodes = [];
    for (const id of ids) { const n = document.getElementById(id); if (n) nodes.push(n.innerText || n.textContent || ''); }
    return collapse(nodes.length ? nodes.join(' ') : aria);
  }
  return '';
};
const findByText = (wanted) => {
  const want = collapse(wanted);
  if (!want) return null;
  const root = document.body || document.documentElement;
  if (!root) return null;
  const candidates = [root];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  let node = walker.nextNode();
  while (node) { if (node.nodeType === 1) candidates.push(node); node = walker.nextNode(); }
  let best = null;
  let bestScore = Infinity;
  for (const el of candidates) {
    try { if (el.closest && el.closest('script,style,noscript,template')) continue; } catch (e) {}
    const vals = [
      textOf(el),
      collapse(el.getAttribute && (el.getAttribute('aria-label') || '')),
      collapse(el.getAttribute && (el.getAttribute('title') || '')),
      collapse(el.getAttribute && (el.getAttribute('alt') || '')),
      collapse(el.getAttribute && (el.getAttribute('placeholder') || '')),
      collapse('value' in el ? el.value : ''),
    ];
    let exact = false;
    let contains = false;
    for (const v of vals) {
      if (!v) continue;
      if (v === want) { exact = true; break; }
      if (v.indexOf(want) !== -1) contains = true;
    }
    if (!exact && !contains) continue;
    let area = 0;
    let vis = 1e7;
    try {
      const r = el.getBoundingClientRect();
      area = Math.max(r.width, 0) * Math.max(r.height, 0);
      if (area > 0 && getComputedStyle(el).visibility !== 'hidden') vis = 0;
    } catch (e) {}
    const score = (exact ? 0 : 1e6) + vis + area;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
};
`;

/** Wrap a script body into a page-evaluable async IIFE with the shared lib. */
function pageExpr(script, vars = {}) {
  const decl = Object.entries(vars)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`)
    .join('\n');
  return `(async () => {\n${PAGE_LIB}\n${decl}\n${script}\n})()`;
}

/* ------------------------------------------------------------------ *
 * reusable in-page bodies (must not redeclare the same const twice)
 * ------------------------------------------------------------------ */

const TEXT_BODY = String.raw`
const textRoot = rootOf(selector);
const scrub = (node) => {
  for (const junk of Array.prototype.slice.call(node.querySelectorAll('script,style,noscript,template'))) {
    try { junk.remove(); } catch (e) {}
  }
  return node;
};
let pageText = '';
if (includeHidden) {
  const src = textRoot === document
    ? (document.body || document.documentElement)
    : textRoot;
  pageText = scrub(src.cloneNode(true)).textContent || '';
} else if (textRoot === document) {
  pageText = document.body ? document.body.innerText : '';
} else {
  pageText = textRoot.innerText != null ? textRoot.innerText : (textRoot.textContent || '');
}
if (!pageText || !pageText.trim()) {
  const src = textRoot === document
    ? (document.body || document.documentElement)
    : textRoot;
  pageText = scrub(src.cloneNode(true)).textContent || '';
}
pageText = String(pageText).replace(/\u00a0/g, ' ').replace(/[ \t]+\r?\n/g, '\n').replace(/\r\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
const textChars = pageText.length;
`;

const META_BODY = String.raw`
const meta = {};
const metaContent = (q) => { const m = document.querySelector(q); return m ? collapse(m.getAttribute('content')) : ''; };
const ogMap = {};
for (const m of allIn(document, 'meta[property^="og:"]')) {
  const k = (m.getAttribute('property') || '').slice(3);
  if (k && !(k in ogMap)) ogMap[k] = collapse(m.getAttribute('content'));
}
const twitterMap = {};
for (const m of allIn(document, 'meta[name^="twitter:"]')) {
  const k = (m.getAttribute('name') || '').slice(8);
  if (k && !(k in twitterMap)) twitterMap[k] = collapse(m.getAttribute('content'));
}
const jsonLd = [];
for (const s of allIn(document, 'script[type="application/ld+json"]')) {
  const rawJson = String(s.textContent || '').trim();
  if (!rawJson) continue;
  try { jsonLd.push(JSON.parse(rawJson)); } catch (e) { jsonLd.push({ _raw: clip(rawJson, 2000), _parseError: String((e && e.message) || e) }); }
}
const canonEl = document.querySelector('link[rel="canonical"]');
const iconEl = document.querySelector('link[rel~="icon"]');
const charsetMeta = document.querySelector('meta[charset]');
const httpEquivMeta = document.querySelector('meta[http-equiv="Content-Type"]');
const charsetFromHttp = httpEquivMeta ? ((String(httpEquivMeta.getAttribute('content') || '').match(/charset=([\w-]+)/i) || [])[1] || '') : '';
const viewportMeta = document.querySelector('meta[name="viewport"]');
meta.title = document.title || '';
meta.description = metaContent('meta[name="description"]');
meta.canonical = canonEl ? absUrl(canonEl.getAttribute('href')) : '';
meta.og = ogMap;
meta.twitter = twitterMap;
meta.jsonLd = jsonLd;
meta.lang = (document.documentElement && document.documentElement.lang) || '';
meta.charset = (charsetMeta ? charsetMeta.getAttribute('charset') : '') || charsetFromHttp || document.characterSet || '';
meta.viewport = viewportMeta ? collapse(viewportMeta.getAttribute('content')) : '';
meta.favicon = iconEl ? absUrl(iconEl.getAttribute('href')) : absUrl('/favicon.ico');
`;

const OUTLINE_BODY = String.raw`
const outlineItems = [];
for (const el of allIn(root, 'h1,h2,h3,h4,h5,h6')) {
  const level = Number((el.tagName || '').slice(1));
  const text = textOf(el);
  if (!text) continue;
  outlineItems.push({ level, text: clip(text, 300) });
  if (outlineItems.length >= maxItems) break;
}
`;

const LINKS_BODY = String.raw`
const linkItems = [];
const seenLinks = new Set();
for (const el of allIn(root, 'a[href], area[href]')) {
  const rawHref = el.getAttribute('href');
  if (rawHref == null || rawHref === '' || rawHref === '#') continue;
  const href = absUrl(rawHref);
  if (/^javascript:/i.test(href)) continue;
  const text = textOf(el) || collapse(el.getAttribute('aria-label') || '');
  const rel = collapse(el.getAttribute('rel') || '');
  const title = collapse(el.getAttribute('title') || '');
  const key = href + '\n' + text + '\n' + rel;
  if (seenLinks.has(key)) continue;
  seenLinks.add(key);
  linkItems.push({ text: clip(text, 200), href, rel, title: clip(title, 200) });
  if (linkItems.length >= maxItems) break;
}
const linkTotal = allIn(root, 'a[href], area[href]').length;
`;

const FORMS_BODY = String.raw`
const formItems = [];
for (const form of allIn(root, 'form')) {
  if (formItems.length >= maxItems) break;
  const fields = [];
  for (const el of allIn(form, 'input, select, textarea, button')) {
    const tag = (el.tagName || '').toLowerCase();
    let ftype = tag === 'input' ? String(el.type || 'text').toLowerCase() : tag;
    if (tag === 'select') ftype = el.multiple ? 'select-multiple' : 'select-one';
    const f = {
      name: el.getAttribute('name') || el.id || '',
      type: ftype,
      value: String(el.value == null ? '' : el.value),
      placeholder: el.getAttribute('placeholder') || '',
      required: !!(el.required || el.getAttribute('aria-required') === 'true'),
      label: labelOf(el),
    };
    if (ftype === 'checkbox' || ftype === 'radio') f.checked = !!el.checked;
    if (el.disabled) f.disabled = true;
    if (tag === 'select') f.options = allIn(el, 'option').map((o) => ({ value: o.value, label: collapse(o.textContent) }));
    fields.push(f);
  }
  formItems.push({
    action: form.getAttribute('action') ? absUrl(form.getAttribute('action')) : '',
    method: String(form.getAttribute('method') || 'get').toLowerCase(),
    id: form.id || '',
    fields,
  });
}
`;

const TABLES_BODY = String.raw`
const tableItems = [];
for (const table of allIn(root, 'table')) {
  if (tableItems.length >= maxItems) break;
  const headers = [];
  const rows = [];
  let firstRow = true;
  let rowCount = 0;
  for (const tr of allIn(table, 'tr')) {
    rowCount += 1;
    const ths = allIn(tr, 'th');
    const tds = allIn(tr, 'td');
    if (!ths.length && !tds.length) continue;
    const cells = allIn(tr, 'th, td').map((c) => textOf(c));
    if (firstRow && ths.length && !tds.length) { headers.push(...cells); firstRow = false; continue; }
    firstRow = false;
    if (rows.length >= maxRows) continue;
    rows.push(cells);
  }
  tableItems.push({
    caption: table.caption ? textOf(table.caption) : collapse(table.getAttribute('aria-label') || table.getAttribute('summary') || ''),
    headers,
    rows,
    rowCount,
    truncated: rowCount > rows.length + (headers.length ? 1 : 0),
  });
}
`;

const IMAGES_BODY = String.raw`
const imageItems = [];
for (const img of allIn(root, 'img')) {
  if (imageItems.length >= maxItems) break;
  const src = img.currentSrc || img.getAttribute('src') || '';
  imageItems.push({
    src: absUrl(src),
    alt: collapse(img.getAttribute('alt') || ''),
    title: collapse(img.getAttribute('title') || ''),
    width: img.naturalWidth || img.width || 0,
    height: img.naturalHeight || img.height || 0,
    loading: img.getAttribute('loading') || '',
  });
}
`;

/* ------------------------------------------------------------------ *
 * public API
 * ------------------------------------------------------------------ */

/** Visible (or raw) text of the page or a selector-scoped subtree. */
export async function getText(page, { selector = '', maxChars = 20000, includeHidden = false, frameId } = {}) {
  try {
    const contextId = await frameContext(page, frameId);
    const data = await page.evaluate(
      pageExpr(`${TEXT_BODY}\nreturn { text: pageText, chars: textChars };`, { selector: selector || '', includeHidden: !!includeHidden }),
      evalOpts(contextId),
    );
    return truncate(String(data?.text ?? ''), maxChars);
  } catch (err) {
    throw new Error(`getText 失败：${firstLine(err)}`);
  }
}

/** HTML of the whole document or a selector-scoped element. */
export async function getHtml(page, { selector = '', outer = true, maxChars = 200000, frameId } = {}) {
  try {
    const contextId = await frameContext(page, frameId);
    const data = await page.evaluate(
      pageExpr(
        String.raw`
const root = rootOf(selector);
const el = root === document ? document.documentElement : root;
if (!el) return { html: '' };
return { html: outer ? (el.outerHTML || '') : (el.innerHTML || '') };
`,
        { selector: selector || '', outer: outer !== false },
      ),
      evalOpts(contextId),
    );
    return truncate(String(data?.html ?? ''), maxChars);
  } catch (err) {
    throw new Error(`getHtml 失败：${firstLine(err)}`);
  }
}

/** Full accessibility tree (Accessibility.getFullAXTree) with ax refs. */
export async function getAxTree(page, { maxNodes = 4000 } = {}) {
  try {
    await page.enableDomains({ accessibility: true });
    const { nodes: rawNodes } = await page.send('Accessibility.getFullAXTree');
    const list = Array.isArray(rawNodes) ? rawNodes : [];
    const limit = Math.max(1, Number(maxNodes) || 4000);
    const nodes = [];
    for (const n of list) {
      if (nodes.length >= limit) break;
      const backendDOMNodeId = typeof n.backendDOMNodeId === 'number' ? n.backendDOMNodeId : null;
      const node = {
        nodeId: String(n.nodeId ?? ''),
        role: n.role && n.role.value != null ? String(n.role.value) : '',
        name: n.name && n.name.value != null ? String(n.name.value) : '',
        value: n.value && n.value.value != null ? String(n.value.value) : '',
        description: n.description && n.description.value != null ? String(n.description.value) : '',
        backendDOMNodeId,
        childIds: Array.isArray(n.childIds) ? n.childIds.map(String) : [],
      };
      if (backendDOMNodeId != null) node.ref = `ax:${backendDOMNodeId}`;
      nodes.push(node);
    }
    return { nodes, total: list.length, truncated: list.length > nodes.length };
  } catch (err) {
    throw new Error(`getAxTree 失败：${firstLine(err)}`);
  }
}

/** All links, deduplicated, with absolute hrefs. */
export async function getLinks(page, { maxItems = 500, frameId } = {}) {
  try {
    const contextId = await frameContext(page, frameId);
    const data = await page.evaluate(
      pageExpr(`const root = rootOf(selector);\n${LINKS_BODY}\nreturn { links: linkItems, total: linkTotal };`, {
        selector: '',
        maxItems: Math.max(1, Number(maxItems) || 500),
      }),
      evalOpts(contextId),
    );
    return Array.isArray(data?.links) ? data.links : [];
  } catch (err) {
    throw new Error(`getLinks 失败：${firstLine(err)}`);
  }
}

/** Form structure: action/method + every field with label and constraints. */
export async function getForms(page, { frameId } = {}) {
  try {
    const contextId = await frameContext(page, frameId);
    const data = await page.evaluate(
      pageExpr(`const root = rootOf(selector);\n${FORMS_BODY}\nreturn { forms: formItems };`, { selector: '', maxItems: 1000 }),
      evalOpts(contextId),
    );
    return Array.isArray(data?.forms) ? data.forms : [];
  } catch (err) {
    throw new Error(`getForms 失败：${firstLine(err)}`);
  }
}

/** Head metadata: title/description/canonical/og/twitter/json-ld/lang/charset/viewport/favicon. */
export async function getMeta(page, { frameId } = {}) {
  try {
    const contextId = await frameContext(page, frameId);
    const data = await page.evaluate(pageExpr(`${META_BODY}\nreturn { meta };`), evalOpts(contextId));
    return data?.meta || {
      title: '',
      description: '',
      canonical: '',
      og: {},
      twitter: {},
      jsonLd: [],
      lang: '',
      charset: '',
      viewport: '',
      favicon: '',
    };
  } catch (err) {
    throw new Error(`getMeta 失败：${firstLine(err)}`);
  }
}

/** Heading outline (h1-h6) in document order. */
export async function getOutline(page, { maxItems = 300, frameId } = {}) {
  try {
    const contextId = await frameContext(page, frameId);
    const data = await page.evaluate(
      pageExpr(`const root = rootOf(selector);\n${OUTLINE_BODY}\nreturn { outline: outlineItems };`, {
        selector: '',
        maxItems: Math.max(1, Number(maxItems) || 300),
      }),
      evalOpts(contextId),
    );
    return Array.isArray(data?.outline) ? data.outline : [];
  } catch (err) {
    throw new Error(`getOutline 失败：${firstLine(err)}`);
  }
}

/** Flattened Page.getResourceTree resources. */
export async function getResources(page) {
  try {
    await page.enableDomains({ page: true });
    const { frameTree } = await page.send('Page.getResourceTree');
    const out = [];
    const walk = (node) => {
      if (!node) return;
      const frameUrl = node.frame && node.frame.url ? node.frame.url : '';
      if (frameUrl && !/^(about|data):/.test(frameUrl)) {
        out.push({
          url: frameUrl,
          type: 'Document',
          mimeType: (node.frame && node.frame.mimeType) || 'text/html',
          size: 0,
        });
      }
      for (const r of node.resources || []) {
        const size = typeof r.contentSize === 'number' && r.contentSize >= 0 ? r.contentSize : 0;
        out.push({ url: r.url || '', type: r.type || '', mimeType: r.mimeType || '', size });
      }
      for (const child of node.childFrames || []) walk(child);
    };
    walk(frameTree);
    return out;
  } catch (err) {
    throw new Error(`getResources 失败：${firstLine(err)}`);
  }
}

/** The page as a self-contained, JSON-safe model. */
export async function pageModel(page, opts = {}) {
  const {
    mode = 'snapshot',
    selector = '',
    maxChars = 20000,
    maxItems = 300,
    includeAx = false,
    frameId,
  } = opts || {};
  const started = Date.now();
  const errors = [];
  const capItems = Math.max(1, Number(maxItems) || 300);
  const textOnly = String(mode) === 'text';

  let contextId = null;
  try {
    contextId = await frameContext(page, frameId);
  } catch (err) {
    throw new Error(`pageModel 失败：${firstLine(err)}`);
  }
  const ctx = evalOpts(contextId);

  // Top-level page identity (always the real page, even when scoped to a frame).
  let url = '';
  let title = '';
  try {
    url = await page.evaluate('location.href');
  } catch (err) {
    errors.push({ part: 'url', error: firstLine(err) });
    url = page.currentUrl ? page.currentUrl() : '';
  }
  try {
    title = await page.evaluate('document.title');
  } catch (err) {
    errors.push({ part: 'title', error: firstLine(err) });
    title = '';
  }

  let data;
  try {
    const script = textOnly
      ? `${TEXT_BODY}\nreturn { text: pageText };`
      : `${TEXT_BODY}\nconst root = rootOf(selector);\n${META_BODY}\n${OUTLINE_BODY}\n${LINKS_BODY}\n${FORMS_BODY}\n${TABLES_BODY}\n${IMAGES_BODY}\nreturn { text: pageText, meta, outline: outlineItems, links: linkItems, forms: formItems, tables: tableItems, images: imageItems };`;
    data = await page.evaluate(
      pageExpr(script, {
        selector: selector || '',
        includeHidden: false,
        maxItems: capItems,
        maxRows: Math.min(200, Math.max(1, capItems)),
      }),
      ctx,
    );
  } catch (err) {
    throw new Error(`pageModel 失败：${firstLine(err)}`);
  }

  const trunc = (s) => truncate(String(s ?? ''), maxChars);
  const model = {
    url,
    title,
    text: trunc(data?.text),
    outline: capList(data?.outline, capItems),
    counts: {
      textChars: String(data?.text ?? '').length,
      outline: capList(data?.outline, capItems).length,
      links: capList(data?.links, capItems).length,
      forms: capList(data?.forms, capItems).length,
      tables: capList(data?.tables, capItems).length,
      images: capList(data?.images, capItems).length,
    },
    capturedAt: new Date().toISOString(),
    captureMs: Date.now() - started,
  };
  if (!textOnly) {
    model.meta = data?.meta || null;
    model.links = capList(data?.links, capItems);
    model.forms = capList(data?.forms, capItems);
    model.tables = capList(data?.tables, capItems);
    model.images = capList(data?.images, capItems);
  }
  if (includeAx || mode === 'ax') {
    try {
      model.ax = await getAxTree(page, { maxNodes: 4000 });
      model.counts.ax = model.ax.nodes.length;
    } catch (err) {
      model.ax = { nodes: [], total: 0, truncated: false, error: firstLine(err) };
      errors.push({ part: 'ax', error: firstLine(err) });
    }
  }
  if (errors.length) model.errors = errors;
  return model;
}

function capList(value, max) {
  return Array.isArray(value) ? value.slice(0, Math.max(1, max)) : [];
}

/* ------------------------------------------------------------------ *
 * ref helpers
 * ------------------------------------------------------------------ */

/** AX node ref convention: 'ax:<backendDOMNodeId>'. */
export function axRef(backendDOMNodeId) {
  const id = typeof backendDOMNodeId === 'number' ? backendDOMNodeId : Number(String(backendDOMNodeId ?? '').trim());
  if (!Number.isInteger(id) || id < 0) {
    throw new Error(`axRef 失败：无效的 backendDOMNodeId: ${String(backendDOMNodeId)}`);
  }
  return `ax:${id}`;
}

/** Parse 'ax:123' (or a numeric backendDOMNodeId) back to its number. */
export function parseRef(ref) {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref >= 0 ? ref : null;
  const m = /^ax:(\d+)$/i.exec(String(ref ?? '').trim());
  return m ? Number(m[1]) : null;
}
