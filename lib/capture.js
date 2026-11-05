// dsh-omni-browser / lib/capture.js
// Evidence-bundle orchestration: one call → one self-contained folder.
//
// Design rule (CONTRACT.md §硬规则 2): every sub-step is isolated. A part that
// fails only records `manifest.<part>.error`; the bundle keeps going.
import path from 'node:path';
import { ensureDir, makeOutputDir, writeJson, writeText, writeBinary, fileSize, bytes, slug, truncate, timer, resolveDir } from './util.js';
import { attachCollectors, getCollectors } from './collect.js';
import { collectCookies, collectStorage } from './storage.js';
import * as snapshot from './snapshot.js';
import * as shots from './shots.js';
import * as pdf from './pdf.js';
import * as perf from './perf.js';

const MAX_BODY_FILES = 2000;

const MIME_EXT = {
	'application/json': 'json',
	'application/ld+json': 'json',
	'application/problem+json': 'json',
	'application/javascript': 'js',
	'application/x-javascript': 'js',
	'text/javascript': 'js',
	'text/html': 'html',
	'application/xhtml+xml': 'html',
	'text/css': 'css',
	'text/plain': 'txt',
	'text/markdown': 'md',
	'text/csv': 'csv',
	'text/xml': 'xml',
	'application/xml': 'xml',
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/gif': 'gif',
	'image/webp': 'webp',
	'image/svg+xml': 'svg',
	'image/x-icon': 'ico',
	'image/vnd.microsoft.icon': 'ico',
	'application/pdf': 'pdf',
	'application/zip': 'zip',
	'application/wasm': 'wasm',
	'font/woff': 'woff',
	'font/woff2': 'woff2',
	'font/ttf': 'ttf',
	'application/octet-stream': 'bin',
};

const DEFAULT_OPTIONS = {
	screenshot: 'both', // 'both' | 'fullpage' | 'viewport' | false
	pdf: true,
	har: true,
	bodies: 'failures', // 'failures' | 'all' | false
	console: true,
	storage: true,
	ax: true,
	html: true,
	text: true,
	meta: true,
	links: true,
	forms: true,
	perf: true,
	resources: true,
	maxBodyBytes: 5 * 1024 * 1024,
	maxChars: 20000,
};

function errText(err) {
	return err && err.message ? err.message : String(err);
}

function isIsoDate(value) {
	return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function normalizeScreenshot(value) {
	if (value === false || value === 'false' || value === 'none' || value === null) return false;
	if (value === true || value === undefined) return 'both';
	const mode = String(value).toLowerCase();
	if (mode === 'viewport' || mode === 'fullpage' || mode === 'both') return mode;
	if (mode === 'full' || mode === 'full-page') return 'fullpage';
	return 'both';
}

function normalizeBodies(value) {
	if (value === false || value === 'false' || value === 'none' || value === null) return false;
	const mode = String(value).toLowerCase();
	if (mode === 'all') return 'all';
	return 'failures';
}

/** Normalize caller options into the effective capture options. */
export function normalizeOptions(options = {}) {
	const merged = { ...DEFAULT_OPTIONS, ...(options && typeof options === 'object' ? options : {}) };
	const maxBodyBytes = Number(merged.maxBodyBytes);
	const maxChars = Number(merged.maxChars);
	return {
		screenshot: normalizeScreenshot(merged.screenshot),
		pdf: merged.pdf !== false,
		har: merged.har !== false,
		bodies: normalizeBodies(merged.bodies),
		console: merged.console !== false,
		storage: merged.storage !== false,
		ax: merged.ax !== false,
		html: merged.html !== false,
		text: merged.text !== false,
		meta: merged.meta !== false,
		links: merged.links !== false,
		forms: merged.forms !== false,
		perf: merged.perf !== false,
		resources: merged.resources !== false,
		maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : DEFAULT_OPTIONS.maxBodyBytes,
		maxChars: Number.isFinite(maxChars) && maxChars > 0 ? maxChars : DEFAULT_OPTIONS.maxChars,
	};
}

function extensionFor(entry) {
	const mime = String(entry?.mimeType || '').split(';')[0].trim().toLowerCase();
	if (MIME_EXT[mime]) return MIME_EXT[mime];
	if (mime.startsWith('text/')) return 'txt';
	if (mime.startsWith('image/')) return mime.split('/')[1].replace(/[^a-z0-9]/g, '') || 'img';
	if (mime.startsWith('font/')) return mime.split('/')[1].replace(/[^a-z0-9]/g, '') || 'font';
	try {
		const ext = new URL(entry.url).pathname.match(/\.([a-z0-9]{1,6})$/i);
		if (ext) return ext[1].toLowerCase();
	} catch {
		/* ignore */
	}
	return 'bin';
}

function bodySlug(entry) {
	let tail = '';
	try {
		const url = new URL(entry.url);
		tail = `${url.pathname}${url.search}`;
	} catch {
		tail = String(entry.url || '');
	}
	return slug(`${entry.method || 'GET'}-${tail}`, 50);
}

/** Best-effort call into a teammate module that may still be a stub. */
async function callMaybe(mod, name, fn) {
	if (!mod || typeof mod[name] !== 'function') throw new Error(`${name} is not exported by its module`);
	return fn(mod[name]);
}

/**
 * Capture a complete evidence bundle for the current page.
 *
 * @param {import('./cdp.js').PageHandle} page
 * @param {{dir?:string, name?:string, options?:object}} opts
 * @returns {Promise<{dir:string, manifestPath:string, manifest:object, files:{path:string,bytes:number}[], stats:object}>}
 */
export async function captureBundle(page, opts = {}) {
	if (!page || typeof page.send !== 'function') throw new Error('captureBundle: a PageHandle is required');
	const startedAt = Date.now();
	const elapsed = timer();
	const options = normalizeOptions(opts.options);
	const url = (() => {
		try {
			return page.currentUrl() || '';
		} catch {
			return '';
		}
	})();
	const name = String(opts.name || url || 'capture');

	let dir;
	if (opts.dir) dir = path.resolve(resolveDir(opts.dir) || String(opts.dir));
	else dir = makeOutputDir({ name });
	await ensureDir(dir);

	const manifest = {
		version: '1.0',
		tool: 'omni_capture',
		creator: 'dsh-omni-browser',
		createdAt: new Date().toISOString(),
		name,
		dir,
		url,
		title: '',
		options,
		limits: {
			maxBodyBytes: options.maxBodyBytes,
			maxChars: options.maxChars,
			maxBodyFiles: MAX_BODY_FILES,
			maxNetworkEntries: 3000,
			maxTotalBodyBytes: 20 * 1024 * 1024,
		},
		files: {},
		warnings: [],
	};
	const files = [];

	/** Register a file that already exists on disk. */
	async function recordFile(rel, abs, extra = {}) {
		const size = await fileSize(abs);
		files.push({ path: abs, bytes: size, name: rel });
		manifest.files[rel] = { path: rel, bytes: size, ...extra };
		return { path: abs, bytes: size, file: rel };
	}

	/** Run one isolated bundle part. Never throws. */
	async function part(partName, fn) {
		const t0 = Date.now();
		try {
			const value = (await fn()) || {};
			const ok = value.ok !== false && !value.error;
			manifest[partName] = { ...value, ok, ms: Date.now() - t0 };
			if (!ok && !value.skipped) {
				manifest.warnings.push({ part: partName, error: value.error || 'unknown error' });
			}
			return value;
		} catch (err) {
			const error = errText(err);
			manifest[partName] = { ok: false, error, ms: Date.now() - t0 };
			manifest.warnings.push({ part: partName, error });
			return null;
		}
	}

	function skipped(partName, reason) {
		manifest[partName] = { ok: false, skipped: true, reason, ms: 0 };
	}

	// Title is needed by several parts; never fatal.
	try {
		manifest.title = await page.title();
	} catch {
		manifest.title = '';
	}

	/* --------------------------- collectors --------------------------- */
	// Attach early collectors when the caller did not; requests made before the
	// attach are missing from the HAR (recorded in manifest.collectors).
	let collectors = getCollectors(page);
	let collectorsAttachedHere = false;
	await part('collectors', async () => {
		if (!collectors) {
			collectors = attachCollectors(page, {
				maxEntries: 3000,
				maxBodyBytes: options.maxBodyBytes,
				bodies: options.bodies,
			});
			collectorsAttachedHere = true;
		}
		if (collectors.ready && typeof collectors.ready.then === 'function') await collectors.ready;
		const enableErrors = Array.isArray(collectors.errors) ? collectors.errors : [];
		return {
			ok: enableErrors.length === 0,
			attached: true,
			attachedLate: collectorsAttachedHere,
			...(enableErrors.length ? { error: enableErrors.map((e) => `${e.part}: ${e.error}`).join('; ') } : {}),
			...(collectorsAttachedHere ? { note: 'collectors were attached during capture; earlier requests are not in the HAR' } : {}),
		};
	});
	const network = collectors ? collectors.network : null;
	const consoleCollector = collectors ? collectors.console : null;

	// Wait for in-flight response bodies so the HAR is as complete as possible.
	if (network && typeof network.settle === 'function') {
		try {
			await network.settle();
		} catch {
			/* non-fatal */
		}
	}

	/* ------------------------------ page.json ------------------------------ */
	let pageModel = null;
	await part('page', async () => {
		pageModel = await callMaybe(snapshot, 'pageModel', (fn) =>
			fn(page, { mode: 'snapshot', maxChars: options.maxChars, maxItems: 300, includeAx: Boolean(options.ax) }),
		);
		if (!pageModel || typeof pageModel !== 'object') throw new Error('pageModel returned no data');
		if (!options.meta) delete pageModel.meta;
		if (!options.links) delete pageModel.links;
		if (!options.forms) delete pageModel.forms;
		if (!options.ax) delete pageModel.ax;
		const file = path.join(dir, 'page.json');
		await writeJson(file, pageModel);
		const rec = await recordFile('page.json', file);
		return { detail: rec, title: pageModel.title || manifest.title, keys: Object.keys(pageModel) };
	});

	/* ------------------------------ screenshots ------------------------------ */
	if (options.screenshot) {
		const modes = [];
		if (options.screenshot === 'both' || options.screenshot === 'viewport') {
			modes.push({ mode: 'viewport', partName: 'screenshot', rel: 'page.png' });
		}
		if (options.screenshot === 'both' || options.screenshot === 'fullpage') {
			modes.push({ mode: 'fullpage', partName: options.screenshot === 'both' ? 'screenshotFull' : 'screenshot', rel: 'page-full.png' });
		}
		for (const spec of modes) {
			await part(spec.partName, async () => {
				const res = await callMaybe(shots, 'screenshot', (fn) => fn(page, { mode: spec.mode, dir, filename: spec.rel, format: 'png' }));
				if (!res || !res.path) throw new Error('screenshot returned no path');
				const rec = await recordFile(spec.rel, res.path);
				return { detail: rec, width: res.width, height: res.height, ...(res.warning ? { warning: res.warning } : {}) };
			});
		}
	} else {
		skipped('screenshot', 'option screenshot=false');
	}

	/* --------------------------------- pdf --------------------------------- */
	if (options.pdf) {
		await part('pdf', async () => {
			const res = await callMaybe(pdf, 'printToPdf', (fn) => fn(page, { dir, filename: 'page.pdf' }));
			if (!res || !res.path) throw new Error('printToPdf returned no path');
			const rec = await recordFile('page.pdf', res.path);
			return { detail: rec, pageCount: res.pageCount };
		});
	} else skipped('pdf', 'option pdf=false');

	/* ------------------------------- bodies ------------------------------- */
	// Bodies are fetched *before* the HAR so that the HAR can embed their text.
	if (options.bodies && network) {
		await part('bodies', async () => {
			const entries = network.entries || [];
			const wanted = options.bodies === 'all' ? entries : entries.filter((e) => e.failed || Number(e.status) >= 400);
			const bodiesDir = path.join(dir, 'bodies');
			await ensureDir(bodiesDir);
			const saved = [];
			let omitted = 0;
			let truncatedCount = 0;
			let index = 0;
			for (const entry of wanted) {
				if (index >= MAX_BODY_FILES) {
					omitted = wanted.length - index;
					break;
				}
				const ext = extensionFor(entry);
				const rel = path.posix.join('bodies', `${String(index + 1).padStart(4, '0')}-${bodySlug(entry)}.${ext}`);
				const file = path.join(dir, rel.split('/').join(path.sep));
				let body;
				try {
					body = await network.getBody(entry.requestId);
				} catch (err) {
					entry.bodyError = errText(err);
					continue;
				}
				if (body.base64) await writeBinary(file, Buffer.from(body.base64, 'base64'));
				else if (typeof body.text === 'string') await writeText(file, body.text);
				else {
					entry.bodyError = body.reason || 'body not available';
					continue;
				}
				const size = await fileSize(file);
				saved.push({ path: file, bytes: size, name: rel, url: entry.url, status: entry.status, truncated: Boolean(body.truncated) });
				files.push(saved[saved.length - 1]);
				manifest.files[rel] = { path: rel, bytes: size, url: entry.url, status: entry.status };
				if (body.truncated) truncatedCount += 1;
				index += 1;
			}
			return {
				ok: saved.length > 0 || wanted.length === 0,
				count: saved.length,
				requested: wanted.length,
				truncated: truncatedCount,
				...(omitted ? { omitted, note: `body files capped at ${MAX_BODY_FILES}` } : {}),
				...(saved.length === 0 && wanted.length > 0 ? { error: 'no response body could be saved' } : {}),
				samples: saved.slice(0, 20).map((b) => ({ name: b.name, bytes: b.bytes, url: b.url, status: b.status })),
				bodiesDir: 'bodies',
			};
		});
	} else {
		skipped('bodies', options.bodies ? 'no network collector' : 'option bodies=false');
	}

	/* --------------------------------- HAR --------------------------------- */
	if (options.har && network) {
		await part('har', async () => {
			const har = await network.har();
			const entries = har?.log?.entries || [];
			const invalid = entries.filter((e) => !isIsoDate(e?.startedDateTime) || typeof e?.time !== 'number');
			const file = path.join(dir, 'network.har.json');
			await writeJson(file, har);
			const rec = await recordFile('network.har.json', file, { entries: entries.length });
			return {
				detail: rec,
				entries: entries.length,
				version: har?.log?.version,
				...(invalid.length ? { warning: `${invalid.length} HAR entries have a non-ISO startedDateTime or non-numeric time` } : {}),
			};
		});
		await part('network', async () => {
			const data = await network.toJSON({ includeBodies: false });
			data.bodiesPolicy = options.bodies;
			const file = path.join(dir, 'network.json');
			await writeJson(file, data);
			const rec = await recordFile('network.json', file);
			return { detail: rec, entries: data.entries.length, stats: data.stats };
		});
	} else {
		skipped('har', options.har ? 'no network collector' : 'option har=false');
		skipped('network', options.har ? 'no network collector' : 'option har=false');
	}

	/* -------------------------------- console -------------------------------- */
	let consoleStats = { errors: 0, warnings: 0, total: 0 };
	if (options.console && consoleCollector) {
		await part('console', async () => {
			const res = await consoleCollector.export(dir);
			consoleStats = { total: 0, errors: 0, warnings: 0, ...(res.counts || {}) };
			const rec = await recordFile('console.json', res.path);
			return { detail: rec, counts: res.counts, entries: consoleStats.total };
		});
	} else skipped('console', options.console ? 'no console collector' : 'option console=false');

	/* -------------------------------- storage -------------------------------- */
	if (options.storage) {
		await part('storage', async () => {
			const data = await collectStorage(page, { includeValues: true, maxRecords: 200 });
			const file = path.join(dir, 'storage.json');
			await writeJson(file, data);
			const rec = await recordFile('storage.json', file);
			return { detail: rec, origins: data.origins.length, counts: data.counts, unavailable: data.unavailable };
		});
		await part('cookies', async () => {
			const cookies = await collectCookies(page, {});
			const file = path.join(dir, 'cookies.json');
			await writeJson(file, { capturedAt: new Date().toISOString(), count: cookies.length, cookies });
			const rec = await recordFile('cookies.json', file);
			return { detail: rec, count: cookies.length };
		});
	} else {
		skipped('storage', 'option storage=false');
		skipped('cookies', 'option storage=false');
	}

	/* -------------------------------- dom / text -------------------------------- */
	if (options.html) {
		await part('html', async () => {
			const html = await callMaybe(snapshot, 'getHtml', (fn) => fn(page, { outer: true, maxChars: options.maxChars, includeHidden: false }));
			if (typeof html !== 'string') throw new Error('getHtml returned no string');
			const file = path.join(dir, 'dom.html');
			await writeText(file, html);
			const rec = await recordFile('dom.html', file);
			return { detail: rec, chars: html.length, truncated: html.length >= options.maxChars };
		});
	} else skipped('html', 'option html=false');

	if (options.text) {
		await part('text', async () => {
			const text = await callMaybe(snapshot, 'getText', (fn) => fn(page, { maxChars: options.maxChars }));
			if (typeof text !== 'string') throw new Error('getText returned no string');
			const file = path.join(dir, 'text.txt');
			await writeText(file, truncate(text, options.maxChars));
			const rec = await recordFile('text.txt', file);
			return { detail: rec, chars: text.length };
		});
	} else skipped('text', 'option text=false');

	/* ---------------------------------- ax ---------------------------------- */
	if (options.ax) {
		await part('ax', async () => {
			const tree = await callMaybe(snapshot, 'getAxTree', (fn) => fn(page, { maxNodes: 4000 }));
			if (!tree || !Array.isArray(tree.nodes)) throw new Error('getAxTree returned no nodes');
			const file = path.join(dir, 'ax.json');
			await writeJson(file, tree);
			const rec = await recordFile('ax.json', file);
			return { detail: rec, nodes: tree.nodes.length };
		});
	} else skipped('ax', 'option ax=false');

	/* ---------------------------- meta/links/forms ---------------------------- */
	// No dedicated files: these enrich page.json. Call the dedicated snapshot
	// helpers only when pageModel did not already provide the data.
	await part('meta', async () => {
		if (!options.meta) return { ok: false, skipped: true, reason: 'option meta=false' };
		if (pageModel && pageModel.meta && typeof pageModel.meta === 'object') {
			return { source: 'page.json', keys: Object.keys(pageModel.meta) };
		}
		const meta = await callMaybe(snapshot, 'getMeta', (fn) => fn(page));
		if (!meta) throw new Error('getMeta returned nothing');
		manifest.metaData = meta;
		return { source: 'snapshot.getMeta' };
	});

	for (const [listName, fnName] of [['links', 'getLinks'], ['forms', 'getForms']]) {
		await part(listName, async () => {
			if (!options[listName]) return { ok: false, skipped: true, reason: `option ${listName}=false` };
			if (pageModel && Array.isArray(pageModel[listName])) {
				return { source: 'page.json', count: pageModel[listName].length };
			}
			const value = await callMaybe(snapshot, fnName, (fn) => (listName === 'links' ? fn(page, { maxItems: 500 }) : fn(page)));
			if (value === undefined || value === null) throw new Error(`${fnName} returned nothing`);
			manifest[`${listName}Data`] = value;
			return { source: `snapshot.${fnName}`, count: Array.isArray(value) ? value.length : 0 };
		});
	}

	/* --------------------------------- perf --------------------------------- */
	if (options.perf) {
		await part('perf', async () => {
			const data = await callMaybe(perf, 'metrics', (fn) => fn(page));
			const file = path.join(dir, 'perf.json');
			await writeJson(file, data);
			const rec = await recordFile('perf.json', file);
			if (data && data.error) return { ok: false, error: data.error, detail: rec, metrics: 0 };
			return { detail: rec, metrics: Object.keys(data?.metrics || {}).length };
		});
	} else skipped('perf', 'option perf=false');

	/* ------------------------------- resources ------------------------------- */
	if (options.resources) {
		await part('resources', async () => {
			let data;
			let source = 'snapshot.getResources';
			try {
				const res = await callMaybe(snapshot, 'getResources', (fn) => fn(page));
				data = Array.isArray(res) ? { count: res.length, entries: res } : res;
			} catch (err) {
				// Degrade to the Perf-domain summary when snapshot.js is unavailable.
				source = 'perf.resourceSummary';
				data = await callMaybe(perf, 'resourceSummary', (fn) => fn(page));
				if (!data) throw new Error(`both getResources and resourceSummary failed: ${errText(err)}`);
			}
			const file = path.join(dir, 'resources.json');
			await writeJson(file, { capturedAt: new Date().toISOString(), source, ...data });
			const rec = await recordFile('resources.json', file);
			const count = data?.count ?? (Array.isArray(data?.entries) ? data.entries.length : undefined);
			return { detail: rec, count, source };
		});
	} else skipped('resources', 'option resources=false');

	/* -------------------------------- stats -------------------------------- */
	const networkStats = network && typeof network.stats === 'function' ? network.stats() : null;
	const stats = {
		durationMs: Date.now() - startedAt,
		network: networkStats,
		console: { errors: consoleStats.errors || 0, warnings: consoleStats.warnings || 0, total: consoleStats.total || 0 },
		page: { url: url || (pageModel && pageModel.url) || '', title: manifest.title || (pageModel && pageModel.title) || '' },
		dirSize: files.reduce((sum, f) => sum + (f.bytes || 0), 0),
	};
	stats.totalFiles = files.length;
	stats.totalBytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
	stats.totalBytesText = bytes(stats.totalBytes);
	manifest.stats = { ...stats };
	manifest.filesCount = files.length;

	/* ------------------------------- manifest ------------------------------- */
	const manifestPath = path.join(dir, 'manifest.json');
	await writeJson(manifestPath, manifest);
	const manifestBytes = await fileSize(manifestPath);
	files.push({ path: manifestPath, bytes: manifestBytes, name: 'manifest.json' });

	stats.durationMs = elapsed();
	stats.totalFiles = files.length;
	stats.totalBytes = files.reduce((sum, f) => sum + (f.bytes || 0), 0);
	stats.totalBytesText = bytes(stats.totalBytes);

	return { dir, manifestPath, manifest, files, stats };
}

export default { captureBundle, normalizeOptions };
