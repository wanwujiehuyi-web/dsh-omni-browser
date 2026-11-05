// dsh-omni-browser / lib/actions.js
// Page actions driven by REAL browser input events:
//   Input.dispatchMouseEvent / Input.dispatchKeyEvent / Input.insertText.
// `el.click()` is never used to perform an action.
//
// Targets are accepted in these forms:
//   'css selector' | { selector } | { text: 'visible label' } |
//   { ref: 'ax:123' } (AX backendDOMNodeId) | { x, y }
//
// All public actions throw readable Errors on failure; resolveTarget is the
// only non-throwing probe (returns {ok:false, error} after its timeout).
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './util.js';

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

const firstLine = (err, max = 400) => {
  const raw = err && err.message ? err.message : String(err ?? 'unknown error');
  return String(raw).split(/\r?\n/)[0].slice(0, max);
};

const fail = (name, err) => {
  if (err && err.__actionError) return err;
  const e = new Error(`${name}失败：${firstLine(err)}`);
  e.__actionError = true;
  return e;
};

const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const BUTTONS = { left: 'left', right: 'right', middle: 'middle' };
const BUTTON_MASK = { left: 1, right: 2, middle: 4, none: 0 };

function modMask(modifiers) {
  let mask = 0;
  for (const m of Array.isArray(modifiers) ? modifiers : modifiers == null ? [] : [modifiers]) {
    const bit = MODIFIERS[String(m).toLowerCase()];
    if (bit) mask |= bit;
    else if (Number.isInteger(m)) mask |= m;
  }
  return mask;
}

function normalizeButton(button) {
  const b = String(button || 'left').toLowerCase();
  return BUTTONS[b] ? b : 'left';
}

/** Run a JSON round-trip so models/values are always serializable. */
function clean(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

/** Settle two animation frames so layout/scroll listeners have run. */
async function frames(page, count = 2) {
  const n = Math.max(1, count | 0);
  try {
    await page.evaluate(
      `new Promise((resolve) => { let i = 0; const tick = () => (++i >= ${n} ? resolve(true) : requestAnimationFrame(tick)); requestAnimationFrame(tick); })`,
    );
  } catch {
    await sleep(16 * n);
  }
}

/* ------------------------------------------------------------------ *
 * in-page helper library (self-contained per evaluation)
 * ------------------------------------------------------------------ */

const ACT_LIB = String.raw`
const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const v = collapse(s); return v.length > n ? v.slice(0, n) + '…' : v; };
const textOf = (el) => {
  if (!el) return '';
  const t = el.innerText != null && el.innerText !== '' ? el.innerText : el.textContent;
  return collapse(t);
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
    let hidden = 0;
    try {
      const r = el.getBoundingClientRect();
      area = Math.max(r.width, 0) * Math.max(r.height, 0);
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) hidden = 1;
    } catch (e) {}
    const score = (exact ? 0 : 1e6) + hidden * 1e7 + area;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  return best;
};
const measure = async (el) => {
  if (!el) return null;
  if (!el.isConnected) return { ok: false, error: '元素已从 DOM 中移除' };
  try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { el.scrollIntoView(); }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const round = (n) => Math.round(n * 100) / 100;
  const rect = { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) };
  const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0;
  const tag = (el.tagName || '').toLowerCase();
  const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
  return {
    ok: true,
    rect,
    visible,
    description: describeEl(el),
    tagName: tag,
    editable,
    scroll: { x: window.scrollX, y: window.scrollY },
  };
};
`;

function expr(script, vars = {}) {
  const decl = Object.entries(vars)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`)
    .join('\n');
  return `(async () => {\n${ACT_LIB}\n${decl}\n${script}\n})()`;
}

/* ------------------------------------------------------------------ *
 * low-level CDP wrappers
 * ------------------------------------------------------------------ */

async function callOn(page, objectId, functionDeclaration, args = []) {
  const res = await page.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const details = res.exceptionDetails;
    throw new Error(details.exception?.description || details.text || '函数执行失败');
  }
  return res.result ? res.result.value : undefined;
}

async function resolveObjectId(page, spec) {
  await page.enableDomains({ dom: true, runtime: true });
  if (spec.kind === 'ref') {
    const { object } = await page.send('DOM.resolveNode', { backendNodeId: spec.backendNodeId });
    if (!object || !object.objectId) throw new Error(`无法解析 ref ax:${spec.backendNodeId}`);
    return object.objectId;
  }
  const expression =
    spec.kind === 'selector'
      ? `document.querySelector(${JSON.stringify(spec.selector)})`
      : `(() => {\n${ACT_LIB}\nreturn findByText(${JSON.stringify(spec.text)});\n})()`;
  const res = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: false,
    awaitPromise: false,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || '目标解析失败');
  }
  if (!res.result || !res.result.objectId) {
    throw new Error(spec.kind === 'selector' ? `未找到选择器: ${spec.selector}` : `未找到文本: ${spec.text}`);
  }
  return res.result.objectId;
}

/** Resolve the target element's objectId (throws readable errors). */
async function objectIdOf(page, spec) {
  try {
    return await resolveObjectId(page, spec);
  } catch (err) {
    throw fail('目标定位', err);
  }
}

const MEASURE_FN = String.raw`
async function () {
  const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const clip = (s, n) => { const v = collapse(s); return v.length > n ? v.slice(0, n) + '…' : v; };
  const textOf = (el) => {
    try { const t = el.innerText != null && el.innerText !== '' ? el.innerText : el.textContent; return collapse(t); } catch (e) { return ''; }
  };
  const describeEl = (el) => {
    let out = (el.tagName || '').toLowerCase();
    if (el.id) out += '#' + el.id;
    const cn = typeof el.className === 'string' ? el.className : '';
    const cls = cn.trim().split(/\s+/).filter(Boolean).slice(0, 3);
    if (cls.length) out += '.' + cls.join('.');
    const t = textOf(el);
    if (t) out += ' "' + clip(t, 60) + '"';
    return out;
  };
  if (!this || this.nodeType !== 1) return { ok: false, error: '引用不是元素节点' };
  if (!this.isConnected) return { ok: false, error: '元素已从 DOM 中移除' };
  try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { this.scrollIntoView(); }
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const r = this.getBoundingClientRect();
  const cs = getComputedStyle(this);
  const round = (n) => Math.round(n * 100) / 100;
  const tag = (this.tagName || '').toLowerCase();
  return {
    ok: true,
    rect: { x: round(r.x), y: round(r.y), width: round(r.width), height: round(r.height) },
    visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0,
    description: describeEl(this),
    tagName: tag,
    editable: tag === 'input' || tag === 'textarea' || tag === 'select' || !!this.isContentEditable,
    scroll: { x: window.scrollX, y: window.scrollY },
  };
}
`;

/* ------------------------------------------------------------------ *
 * target normalization / resolution
 * ------------------------------------------------------------------ */

function normalizeTarget(target) {
  if (typeof target === 'string' && target.trim()) {
    return { kind: 'selector', selector: target.trim() };
  }
  if (typeof target === 'number' && Number.isInteger(target) && target >= 0) {
    return { kind: 'ref', backendNodeId: target };
  }
  if (target && typeof target === 'object') {
    if (typeof target.ref === 'string' || typeof target.ref === 'number') {
      const m = /^ax:(\d+)$/i.exec(String(target.ref).trim());
      const id = typeof target.ref === 'number' ? target.ref : m ? Number(m[1]) : Number(String(target.ref).trim());
      if (Number.isInteger(id) && id >= 0) return { kind: 'ref', backendNodeId: id };
      return { kind: 'invalid', error: `无效的 ref: ${String(target.ref)}（应为 ax:<backendDOMNodeId>）` };
    }
    if (typeof target.selector === 'string' && target.selector.trim()) {
      return { kind: 'selector', selector: target.selector.trim() };
    }
    if (typeof target.text === 'string' && target.text.trim()) {
      return { kind: 'text', text: target.text.trim() };
    }
    if (typeof target.x === 'number' && typeof target.y === 'number') {
      return { kind: 'point', x: target.x, y: target.y };
    }
  }
  return {
    kind: 'invalid',
    error: '无效的目标：需要 CSS 选择器、{selector}、{text}、{ref:"ax:123"} 或 {x,y}',
  };
}

async function attemptResolve(page, spec) {
  if (spec.kind === 'invalid') return { ok: false, kind: 'invalid', error: spec.error };
  if (spec.kind === 'point') {
    return {
      ok: true,
      kind: 'point',
      rect: { x: spec.x, y: spec.y, width: 0, height: 0 },
      visible: true,
      description: `point (${spec.x}, ${spec.y})`,
      tagName: '',
      editable: false,
    };
  }
  if (spec.kind === 'ref') {
    await page.enableDomains({ dom: true, runtime: true });
    let objectId;
    try {
      const resolved = await page.send('DOM.resolveNode', { backendNodeId: spec.backendNodeId });
      objectId = resolved.object && resolved.object.objectId;
    } catch (err) {
      return { ok: false, kind: 'ref', error: `ref ax:${spec.backendNodeId} 无法解析（节点可能已移除）`, detail: firstLine(err) };
    }
    if (!objectId) return { ok: false, kind: 'ref', error: `ref ax:${spec.backendNodeId} 无法解析` };
    const measured = await callOn(page, objectId, MEASURE_FN);
    if (!measured || !measured.ok) {
      return { ok: false, kind: 'ref', error: measured?.error || '无法测量 ref 目标' };
    }
    return { ...measured, kind: 'ref', backendNodeId: spec.backendNodeId, objectId };
  }
  if (spec.kind === 'selector') {
    const measured = await page.evaluate(
      expr(`const el = document.querySelector(selector);\nif (!el) return null;\nreturn await measure(el);`, {
        selector: spec.selector,
      }),
    );
    if (!measured) return { ok: false, kind: 'selector', error: `未找到选择器: ${spec.selector}` };
    return { ...measured, kind: 'selector', selector: spec.selector };
  }
  // text
  const measured = await page.evaluate(
    expr(`const el = findByText(text);\nif (!el) return null;\nreturn await measure(el);`, { text: spec.text }),
  );
  if (!measured) return { ok: false, kind: 'text', error: `未找到可见文本: ${spec.text}` };
  return { ...measured, kind: 'text', text: spec.text };
}

/**
 * Locate a target without throwing. Polls until found or `timeout` expires.
 * Returns {ok, kind, rect, visible, description, backendNodeId?, objectId?, error?}.
 */
export async function resolveTarget(page, target, opts = {}) {
  const timeout = Math.max(0, Number(opts.timeout ?? 5000) || 0);
  const spec = normalizeTarget(target);
  const started = Date.now();
  let last = { ok: false, kind: spec.kind, error: spec.error || '未找到目标' };
  let attempts = 0;
  for (;;) {
    attempts += 1;
    try {
      const res = await attemptResolve(page, spec);
      if (res && res.ok) return clean({ ...res, attempts, elapsedMs: Date.now() - started });
      last = res || last;
    } catch (err) {
      last = { ok: false, kind: spec.kind, error: firstLine(err) };
    }
    if (Date.now() - started >= timeout) {
      return clean({ ...last, ok: false, attempts, elapsedMs: Date.now() - started });
    }
    await sleep(150);
  }
}

async function requireTarget(page, target, opts = {}, who = '操作') {
  const resolved = await resolveTarget(page, target, opts);
  if (!resolved.ok) throw fail(who, resolved.error || '未找到目标');
  return resolved;
}

/* ------------------------------------------------------------------ *
 * real input primitives
 * ------------------------------------------------------------------ */

async function viewportOf(page) {
  try {
    return await page.evaluate('({ width: Math.max(1, innerWidth), height: Math.max(1, innerHeight) })');
  } catch {
    return { width: 1280, height: 800 };
  }
}

function centerOf(resolved) {
  const r = resolved.rect || { x: 0, y: 0, width: 0, height: 0 };
  return {
    x: r.width > 0 ? r.x + r.width / 2 : r.x,
    y: r.height > 0 ? r.y + r.height / 2 : r.y,
  };
}

async function moveMouse(page, x, y, { modifiers = 0, buttons = 0 } = {}) {
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
    buttons,
    modifiers,
    clickCount: 0,
  });
}

async function realClick(page, resolved, { button = 'left', clickCount = 1, modifiers = [] } = {}) {
  const vp = await viewportOf(page);
  const center = centerOf(resolved);
  const x = Math.min(Math.max(center.x, 0), vp.width - 1);
  const y = Math.min(Math.max(center.y, 0), vp.height - 1);
  const mask = modMask(modifiers);
  const btn = normalizeButton(button);
  await moveMouse(page, x, y, { modifiers: mask });
  for (let n = 1; n <= Math.max(1, clickCount); n += 1) {
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: btn,
      buttons: BUTTON_MASK[btn],
      modifiers: mask,
      clickCount: n,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: btn,
      buttons: 0,
      modifiers: mask,
      clickCount: n,
    });
    if (n < clickCount) await sleep(30);
  }
  await frames(page, 2);
  return { x, y, button: btn, clickCount, modifiers: mask };
}

const KEY_DEFS = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  del: { key: 'Delete', code: 'Delete', vk: 46 },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  shift: { key: 'Shift', code: 'ShiftLeft', vk: 16 },
  control: { key: 'Control', code: 'ControlLeft', vk: 17 },
  ctrl: { key: 'Control', code: 'ControlLeft', vk: 17 },
  alt: { key: 'Alt', code: 'AltLeft', vk: 18 },
  meta: { key: 'Meta', code: 'MetaLeft', vk: 91 },
};

function keyDefFor(key) {
  const raw = String(key ?? '');
  const named = KEY_DEFS[raw.toLowerCase()];
  if (named) return { ...named };
  if (raw.length === 1) {
    const ch = raw;
    const upper = ch.toUpperCase();
    let code = '';
    if (/[a-z]/i.test(ch)) code = `Key${upper}`;
    else if (/[0-9]/.test(ch)) code = `Digit${ch}`;
    else if (ch === ' ') code = 'Space';
    else if (ch === '\n') return { key: 'Enter', code: 'Enter', vk: 13, text: '\r' };
    else code = '';
    return { key: ch, code, vk: ch.charCodeAt(0), text: ch };
  }
  return null;
}

async function dispatchKey(page, key, { modifiers = [] } = {}) {
  const def = keyDefFor(key);
  if (!def) throw new Error(`不支持的按键: ${String(key)}`);
  const mask = modMask(modifiers);
  const base = {
    key: def.key,
    code: def.code || '',
    modifiers: mask,
    windowsVirtualKeyCode: def.vk || 0,
    nativeVirtualKeyCode: def.vk || 0,
  };
  if (def.text) {
    await page.send('Input.dispatchKeyEvent', {
      ...base,
      type: 'keyDown',
      text: def.text,
      unmodifiedText: def.text,
    });
  } else {
    await page.send('Input.dispatchKeyEvent', { ...base, type: 'rawKeyDown' });
  }
  await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  return { key: def.key, code: def.code || '', modifiers: mask };
}

/* ------------------------------------------------------------------ *
 * public actions
 * ------------------------------------------------------------------ */

/** Click an element with real mouse events at its center. */
export async function click(page, target, opts = {}) {
  const { button = 'left', clickCount = 1, modifiers = [], timeout = 5000 } = opts;
  try {
    const resolved = await requireTarget(page, target, { timeout }, 'click');
    if (resolved.visible === false && resolved.kind !== 'point') {
      throw new Error(`目标不可见: ${resolved.description || ''}`);
    }
    const pos = await realClick(page, resolved, { button, clickCount, modifiers });
    return clean({ ok: true, ...pos, kind: resolved.kind, description: resolved.description });
  } catch (err) {
    throw fail('click', err);
  }
}

/** Type text into an element using real key/insertText events. */
export async function type(page, target, text, opts = {}) {
  const { clear = true, delayMs = 0, submit = false, timeout = 5000 } = opts;
  const value = String(text ?? '');
  try {
    const resolved = await requireTarget(page, target, { timeout }, 'type');
    const objectId = resolved.objectId || (await objectIdOf(page, normalizeTarget(target)));

    await callOn(
      page,
      objectId,
      `async function (clearFirst) {
        if (!this.isConnected) throw new Error('元素已从 DOM 中移除');
        try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
        if (typeof this.focus === 'function') this.focus({ preventScroll: true });
        try {
          if (clearFirst) {
            if (typeof this.select === 'function') this.select();
            else if (this.isContentEditable) {
              const range = document.createRange(); range.selectNodeContents(this);
              const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
            }
          } else if (typeof this.setSelectionRange === 'function' && this.value != null) {
            const len = String(this.value).length; this.setSelectionRange(len, len);
          } else if (this.isContentEditable) {
            const range = document.createRange(); range.selectNodeContents(this); range.collapse(false);
            const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
          }
        } catch (e) {}
        return { focused: document.activeElement === this, tag: (this.tagName || '').toLowerCase() };
      }`,
      [!!clear],
    );

    if (clear) await dispatchKey(page, 'Backspace');
    else await dispatchKey(page, 'ArrowRight');

    if (delayMs > 0) {
      for (const ch of Array.from(value)) {
        if (ch === '\n') await dispatchKey(page, 'Enter');
        else {
          await page.send('Input.insertText', { text: ch });
          await sleep(Math.max(5, Number(delayMs) || 0));
        }
      }
    } else if (value) {
      await page.send('Input.insertText', { text: value });
    }
    if (submit) await dispatchKey(page, 'Enter');
    await frames(page, 1);

    const written = await callOn(
      page,
      objectId,
      `function () {
        if (this.isContentEditable) return String(this.innerText || '');
        return this.value != null ? String(this.value) : '';
      }`,
    );
    return clean({ ok: true, kind: resolved.kind, description: resolved.description, value: written, submitted: !!submit });
  } catch (err) {
    throw fail('type', err);
  }
}

/** Press one key (real keyDown/keyUp) on the focused element. */
export async function press(page, key, opts = {}) {
  const { modifiers = [] } = opts;
  try {
    const sent = await dispatchKey(page, key, { modifiers });
    await frames(page, 1);
    return clean({ ok: true, ...sent });
  } catch (err) {
    throw fail('press', err);
  }
}

/** Scroll the page (real wheel by default) or a specific element into view. */
export async function scroll(page, opts = {}) {
  const { dy = 600, dx = 0, target, toTop = false, toBottom = false, behavior = 'instant', timeout = 5000 } = opts;
  try {
    if (target != null) {
      const resolved = await requireTarget(page, target, { timeout }, 'scroll');
      const pos = await page.evaluate(
        expr(
          `const el = document.querySelector(selector);
           if (!el) return null;
           try { el.scrollIntoView({ block: 'center', inline: 'center', behavior }); } catch (e) { el.scrollIntoView(); }
           await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
           return { x: window.scrollX, y: window.scrollY };`,
          { selector: resolved.selector || '' },
        ),
      );
      return clean({ ok: true, ...pos, kind: resolved.kind, description: resolved.description });
    }
    if (toTop || toBottom) {
      const pos = await page.evaluate(
        `(() => {
           const maxY = () => Math.max(0, (document.documentElement ? document.documentElement.scrollHeight : 0) - innerHeight);
           window.scrollTo({ top: ${toBottom ? 'maxY()' : '0'}, left: window.scrollX, behavior: 'instant' });
           return { x: window.scrollX, y: window.scrollY };
         })()`,
      );
      return clean({ ok: true, ...pos, deltaX: 0, deltaY: 0 });
    }
    const vp = await viewportOf(page);
    const x = Math.floor(vp.width / 2);
    const y = Math.floor(vp.height / 2);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: Number(dx) || 0,
      deltaY: Number(dy) || 0,
      modifiers: 0,
    });
    await sleep(80);
    let pos = await page.evaluate('({ x: window.scrollX, y: window.scrollY })');
    if ((Number(dy) || 0) !== 0 && Math.abs(pos.y) < 1 && Math.abs(Number(dy)) > 1) {
      // Headless wheel can be swallowed (e.g. inner scroll containers); fall back.
      pos = await page.evaluate(
        `(() => {
           try { window.scrollBy({ top: ${Number(dy) || 0}, left: ${Number(dx) || 0}, behavior: '${String(behavior)}' }); } catch (e) { window.scrollBy(${Number(dx) || 0}, ${Number(dy) || 0}); }
           return { x: window.scrollX, y: window.scrollY };
         })()`,
      );
    }
    return clean({ ok: true, ...pos, deltaX: Number(dx) || 0, deltaY: Number(dy) || 0 });
  } catch (err) {
    throw fail('scroll', err);
  }
}

/** Move the real mouse over an element (mouseMoved). */
export async function hover(page, target, opts = {}) {
  const { timeout = 5000, modifiers = [] } = opts;
  try {
    const resolved = await requireTarget(page, target, { timeout }, 'hover');
    const vp = await viewportOf(page);
    const center = centerOf(resolved);
    const x = Math.min(Math.max(center.x, 0), vp.width - 1);
    const y = Math.min(Math.max(center.y, 0), vp.height - 1);
    await moveMouse(page, x, y, { modifiers: modMask(modifiers) });
    await frames(page, 1);
    return clean({ ok: true, x, y, kind: resolved.kind, description: resolved.description });
  } catch (err) {
    throw fail('hover', err);
  }
}

/** Focus an element and report what actually holds focus. */
export async function focus(page, target, opts = {}) {
  const { timeout = 5000 } = opts;
  try {
    const resolved = await requireTarget(page, target, { timeout }, 'focus');
    const objectId = resolved.objectId || (await objectIdOf(page, normalizeTarget(target)));
    const result = await callOn(
      page,
      objectId,
      `async function () {
        if (!this.isConnected) throw new Error('元素已从 DOM 中移除');
        try { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
        if (typeof this.focus === 'function') this.focus({ preventScroll: true });
        await new Promise((r) => requestAnimationFrame(r));
        const active = document.activeElement;
        return {
          focused: active === this,
          active: active ? (active.id ? '#' + active.id : (active.tagName || '').toLowerCase()) : null,
        };
      }`,
    );
    return clean({ ok: true, ...result, kind: resolved.kind, description: resolved.description });
  } catch (err) {
    throw fail('focus', err);
  }
}

/** Choose an option in a <select> by value or visible label. */
export async function selectOption(page, target, valueOrLabel, opts = {}) {
  const { timeout = 5000 } = opts;
  try {
    const resolved = await requireTarget(page, target, { timeout }, 'selectOption');
    const objectId = resolved.objectId || (await objectIdOf(page, normalizeTarget(target)));
    const wanted = String(valueOrLabel ?? '');
    const result = await callOn(
      page,
      objectId,
      `function (wanted) {
        const el = this;
        if (!el || (el.tagName || '').toLowerCase() !== 'select') {
          throw new Error('目标不是 <select>: ' + (el && el.tagName));
        }
        const options = Array.prototype.slice.call(el.options || []);
        const opt =
          options.find((o) => o.value === wanted) ||
          options.find((o) => String(o.textContent || '').replace(/\s+/g, ' ').trim() === wanted) ||
          options.find((o) => String(o.textContent || '').replace(/\s+/g, ' ').trim().indexOf(wanted) !== -1);
        if (!opt) {
          throw new Error('选项不存在: ' + wanted + '（可用: ' + options.map((o) => o.value + '=' + String(o.textContent || '').trim()).join(', ') + '）');
        }
        if (el.multiple) {
          for (const o of options) o.selected = false;
        }
        el.value = opt.value;
        opt.selected = true;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { value: el.value, label: String(opt.textContent || '').replace(/\s+/g, ' ').trim(), index: opt.index };
      }`,
      [wanted],
    );
    await frames(page, 1);
    return clean({ ok: true, ...result, kind: resolved.kind, description: resolved.description });
  } catch (err) {
    throw fail('selectOption', err);
  }
}

/** Set a checkbox/radio state (real mouse click when a UI toggle is possible). */
export async function setChecked(page, target, checked, opts = {}) {
  const { timeout = 5000 } = opts;
  const want = !!checked;
  try {
    const resolved = await requireTarget(page, target, { timeout }, 'setChecked');
    const objectId = resolved.objectId || (await objectIdOf(page, normalizeTarget(target)));
    const state = await callOn(
      page,
      objectId,
      `function () {
        return {
          tag: (this.tagName || '').toLowerCase(),
          type: String(this.type || '').toLowerCase(),
          checked: !!this.checked,
        };
      }`,
    );
    if (state.tag !== 'input' || (state.type !== 'checkbox' && state.type !== 'radio')) {
      throw new Error(`目标不是 checkbox/radio（是 ${state.tag}${state.type ? ':' + state.type : ''}）`);
    }
    if (state.checked === want) {
      return clean({ ok: true, changed: false, checked: want, kind: resolved.kind, description: resolved.description });
    }
    // A radio cannot be unchecked through the UI: do it programmatically.
    if (state.type === 'radio' && !want) {
      await callOn(
        page,
        objectId,
        `function () {
          this.checked = false;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }`,
      );
    } else {
      await realClick(page, resolved, {});
    }
    const after = await callOn(
      page,
      objectId,
      `function () { return !!this.checked; }`,
    );
    if (after !== want) {
      // Last-resort programmatic toggle (custom widgets can swallow clicks).
      await callOn(
        page,
        objectId,
        `function (want) {
          this.checked = !!want;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return !!this.checked;
        }`,
        [want],
      );
    }
    const finalState = await callOn(page, objectId, 'function () { return !!this.checked; }');
    return clean({ ok: true, changed: true, checked: finalState, kind: resolved.kind, description: resolved.description });
  } catch (err) {
    throw fail('setChecked', err);
  }
}

/** Attach files to an <input type="file"> through DOM.setFileInputFiles. */
export async function uploadFiles(page, target, files, opts = {}) {
  const { timeout = 5000 } = opts;
  try {
    const list = Array.isArray(files) ? files : files == null ? [] : [files];
    if (!list.length) throw new Error('未提供文件路径');
    const absolute = [];
    for (const file of list) {
      const abs = path.resolve(String(file));
      let stat;
      try {
        stat = fs.statSync(abs);
      } catch {
        throw new Error(`文件不存在: ${abs}`);
      }
      if (!stat.isFile()) throw new Error(`不是文件: ${abs}`);
      absolute.push(abs);
    }
    const resolved = await requireTarget(page, target, { timeout }, 'uploadFiles');
    const objectId = resolved.objectId || (await objectIdOf(page, normalizeTarget(target)));
    const kind = await callOn(
      page,
      objectId,
      `function () { return { tag: (this.tagName || '').toLowerCase(), type: String(this.type || '').toLowerCase() }; }`,
    );
    if (kind.tag !== 'input' || kind.type !== 'file') {
      throw new Error(`目标不是 <input type="file">（是 ${kind.tag}${kind.type ? ':' + kind.type : ''}）`);
    }
    await page.enableDomains({ dom: true });
    await page.send('DOM.setFileInputFiles', { files: absolute, objectId });
    await frames(page, 1);
    const count = await callOn(page, objectId, 'function () { return this.files ? this.files.length : 0; }');
    return clean({ ok: true, files: absolute, count, kind: resolved.kind, description: resolved.description });
  } catch (err) {
    throw fail('uploadFiles', err);
  }
}

/** Drag from one target to another with real mouse press/move/release. */
export async function drag(page, from, to, opts = {}) {
  const { timeout = 5000, steps = 12 } = opts;
  try {
    const fromResolved = await requireTarget(page, from, { timeout }, 'drag');
    const toResolved = await requireTarget(page, to, { timeout }, 'drag');
    const vp = await viewportOf(page);
    const clamp = (p) => ({ x: Math.min(Math.max(p.x, 0), vp.width - 1), y: Math.min(Math.max(p.y, 0), vp.height - 1) });
    const start = clamp(centerOf(fromResolved));
    const end = clamp(centerOf(toResolved));
    const n = Math.max(2, Math.min(60, Number(steps) || 12));
    await moveMouse(page, start.x, start.y);
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let i = 1; i <= n; i += 1) {
      const t = i / n;
      const x = start.x + (end.x - start.x) * t;
      const y = start.y + (end.y - start.y) * t;
      await page.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'left',
        buttons: 1,
      });
      if (n <= 20) await sleep(8);
    }
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await frames(page, 2);
    return clean({
      ok: true,
      from: { x: start.x, y: start.y },
      to: { x: end.x, y: end.y },
      steps: n,
      fromDescription: fromResolved.description,
      toDescription: toResolved.description,
    });
  } catch (err) {
    throw fail('drag', err);
  }
}

/** Wait for a combination of page conditions (all must become true). */
export async function waitFor(page, conditions = {}, opts = {}) {
  const started = Date.now();
  try {
    const conds = conditions && typeof conditions === 'object' ? conditions : {};
    const timeout = Math.max(0, Number(opts.timeout ?? conds.timeout ?? 15000) || 0);
    if (!conds || !Object.keys(conds).length) {
      throw new Error('未提供等待条件（selector/text/urlIncludes/networkIdle/functionText/ms）');
    }
    const deadline = started + timeout;
    const last = {};

    const check = async () => {
      if (conds.selector != null) {
        const found = await page.evaluate(
          `(() => { try { return !!document.querySelector(${JSON.stringify(String(conds.selector))}); } catch (e) { return false; } })()`,
        );
        last.selector = found;
        if (!found) return false;
      }
      if (conds.text != null) {
        const found = await page.evaluate(
          `(() => { const el = document.body || document.documentElement; const t = el ? (el.innerText || el.textContent || '') : ''; return String(t).indexOf(${JSON.stringify(String(conds.text))}) !== -1; })()`,
        );
        last.text = found;
        if (!found) return false;
      }
      if (conds.urlIncludes != null) {
        const found = await page.evaluate(`String(location.href).indexOf(${JSON.stringify(String(conds.urlIncludes))}) !== -1`);
        last.urlIncludes = found;
        if (!found) return false;
      }
      if (conds.functionText != null) {
        const src = String(conds.functionText).trim();
        let found = false;
        try {
          found = !!(await page.evaluate(`(async () => { try { return await (${src})(); } catch (e) { return false; } })()`));
        } catch {
          found = false;
        }
        last.functionText = found;
        if (!found) return false;
      }
      return true;
    };

    if (conds.ms != null) {
      await sleep(Math.max(0, Number(conds.ms) || 0));
      last.ms = true;
    }
    if (conds.networkIdle) {
      await page.waitNetworkIdle(Number(conds.networkIdle) || 500, Math.max(1000, timeout || 15000));
      last.networkIdle = true;
    }
    const hasPolling = conds.selector != null || conds.text != null || conds.urlIncludes != null || conds.functionText != null;
    if (hasPolling) {
      for (;;) {
        const ok = await check();
        if (ok) return clean({ ok: true, elapsedMs: Date.now() - started, url: page.currentUrl(), checked: last });
        if (Date.now() >= deadline) {
          const pieces = [];
          if (conds.selector != null) pieces.push(`selector=${conds.selector}`);
          if (conds.text != null) pieces.push(`text=${conds.text}`);
          if (conds.urlIncludes != null) pieces.push(`urlIncludes=${conds.urlIncludes}`);
          if (conds.functionText != null) pieces.push('functionText');
          throw new Error(`等待超时（${timeout}ms）：${pieces.join(', ')} 仍未满足`);
        }
        await sleep(150);
      }
    }
    return clean({ ok: true, elapsedMs: Date.now() - started, url: page.currentUrl(), checked: last });
  } catch (err) {
    throw fail('waitFor', err);
  }
}
