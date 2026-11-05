// dsh-omni-browser / lib/util.js
// Small, dependency-free helpers shared by every module.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';

export const IS_WIN = process.platform === 'win32';

/** Root for persistent browser state (profile etc.). */
export function omniHome() {
  return process.env.OMNI_HOME || path.join(os.homedir(), '.dsh', 'omni-browser');
}

/** Default directory where capture bundles are written. */
export function defaultOutputRoot() {
  return (
    process.env.OMNI_OUTPUT_DIR ||
    path.join(process.env.OMNI_WORKSPACE || process.cwd(), 'omni-capture')
  );
}

export function localStamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export function slug(s, max = 60) {
  const out = String(s ?? '')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, max);
  return out || 'page';
}

export function randomId(n = 6) {
  return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

/** Create a fresh, timestamped output directory (optionally named). */
export function makeOutputDir({ root, name } = {}) {
  const base = root || defaultOutputRoot();
  const dir = path.join(base, `${localStamp()}-${slug(name || 'capture', 40)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

/** Write pretty JSON (creating parent dirs) and return the absolute path. */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2), 'utf8');
  return path.resolve(file);
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, String(text ?? ''), 'utf8');
  return path.resolve(file);
}

export async function writeBinary(file, data) {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, data);
  return path.resolve(file);
}

export function bytes(n) {
  const v = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let x = v;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${i === 0 ? x : x.toFixed(x >= 10 ? 0 : 1)}${units[i]}`;
}

export function fileSizeSync(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

export async function fileSize(file) {
  try {
    return (await fsp.stat(file)).size;
  } catch {
    return 0;
  }
}

/** JSON-safe deep copy (drops undefined / functions / cycles). */
export function safeJson(value, fallback = null) {
  try {
    if (value === undefined) return fallback;
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

export function truncate(text, max = 20000) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.2));
  return `${head}\n\n... [truncated ${bytes(Buffer.byteLength(s) - Buffer.byteLength(head) - Buffer.byteLength(tail))} / ${bytes(Buffer.byteLength(s))} total] ...\n\n${tail}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 0-based ms timer. */
export function timer() {
  const started = Date.now();
  return () => Date.now() - started;
}

/** Collapse whitespace for one-line log/summary strings. */
export function oneLine(s, max = 300) {
  return truncate(String(s ?? '').replace(/\s+/g, ' ').trim(), max);
}

/** Recursively list files under a directory as [{path, size}], relative paths. */
export async function walk(dir, base = dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(abs, base)));
    else if (entry.isFile()) out.push({ path: path.relative(base, abs).split(path.sep).join('/'), size: await fileSize(abs) });
  }
  return out;
}

export function relPath(file, from = process.cwd()) {
  try {
    return path.relative(from, file).split(path.sep).join('/') || '.';
  } catch {
    return file;
  }
}

/** Normalize a user-supplied output dir (absolute or relative to cwd). */
export function resolveDir(input) {
  if (!input) return null;
  return path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);
}

export function isHttpUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function normalizeUrl(u, base) {
  try {
    return new URL(String(u), base || undefined).href;
  } catch {
    return String(u ?? '');
  }
}

export function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** Sleep that rejects when `signal` aborts. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export function todayLine() {
  return new Date().toISOString();
}
