// test/capture.test.mjs — real-Chrome test for lib/collect.js + lib/storage.js + lib/capture.js.
// Run with: node test/capture.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { startServer } from './server.mjs';
import { BrowserSession } from '../lib/cdp.js';
import { attachCollectors } from '../lib/collect.js';
import { collectStorage, collectCookies, exportStorage } from '../lib/storage.js';
import { captureBundle } from '../lib/capture.js';

const log = (...args) => console.log('[capture-test]', ...args);
const pass = (msg) => log('OK  ', msg);
const tmpRoot = `D:/Temp/omni-capture-test-${Date.now()}`;
const bundleDir = path.join(tmpRoot, 'bundle');
const minDir = path.join(tmpRoot, 'bundle-min');
const exportDir = path.join(tmpRoot, 'exports');

const filesOnDisk = async (dir) => {
	try {
		return (await fsp.readdir(dir, { withFileTypes: true })).map((d) => d.name);
	} catch {
		return [];
	}
};
const statBytes = async (file) => {
	try {
		return (await fsp.stat(file)).size;
	} catch {
		return -1;
	}
};

const srv = await startServer();
const session = new BrowserSession({
	port: 0,
	headless: true,
	userDataDir: `D:/Temp/omni-capture-profile-${Date.now()}`,
});
let page;
let exitCode = 0;

try {
	await session.ensure();
	page = await session.page();
	log('fixture server:', srv.url);

	// Collectors MUST be attached before navigation so requestWillBeSent is seen.
	const collectors = attachCollectors(page, { maxBodyBytes: 64 * 1024 });
	await page.goto(srv.url + '/', { waitUntil: 'load', settle: 1200 });
	await collectors.ready;
	pass('attachCollectors(before goto) + goto /');

	// A 404 exercised later proves the `bodies: 'failures'` capture path.
	await page.evaluate("fetch('/missing-404').then(r => r.status)");
	// A 200KB text response proves body truncation.
	await page.evaluate("fetch('/big').then(r => r.text()).then(t => t.length)");
	// An uncaught exception proves Runtime.exceptionThrown + stack capture.
	await page.evaluate("setTimeout(() => { throw new Error('fixture boom'); }, 0)");
	await new Promise((resolve) => setTimeout(resolve, 600));

	/* ---------------------------------- HAR ---------------------------------- */
	const har = await collectors.network.har();
	const harEntries = har?.log?.entries || [];
	log('HAR entries:', harEntries.length);
	assert.equal(har.log.version, '1.2', 'HAR version must be 1.2');
	assert.equal(typeof har.log.creator?.name, 'string', 'HAR creator.name');
	assert.ok(Array.isArray(har.log.pages), 'HAR log.pages array');
	assert.ok(harEntries.length >= 4, `expected >=4 HAR entries, got ${harEntries.length}`);

	let priorStart = -Infinity;
	for (const entry of harEntries) {
		assert.equal(typeof entry.startedDateTime, 'string', 'startedDateTime is a string');
		assert.ok(Number.isFinite(Date.parse(entry.startedDateTime)), `ISO startedDateTime: ${entry.startedDateTime}`);
		assert.equal(typeof entry.time, 'number', 'time is a number in ms');
		assert.ok(entry.time >= 0, 'time >= 0');
		assert.ok(entry.request && entry.response && entry.timings, 'request/response/timings exist');
		assert.equal(typeof entry.request.method, 'string');
		assert.match(entry.request.url, /^http/);
		assert.equal(typeof entry.request.httpVersion, 'string');
		assert.ok(Array.isArray(entry.request.headers), 'request.headers array');
		assert.ok(Array.isArray(entry.request.queryString), 'request.queryString array');
		assert.ok(Array.isArray(entry.request.cookies), 'request.cookies array');
		assert.equal(typeof entry.request.headersSize, 'number');
		assert.equal(typeof entry.request.bodySize, 'number');
		assert.equal(typeof entry.response.status, 'number');
		assert.equal(typeof entry.response.statusText, 'string');
		assert.equal(typeof entry.response.httpVersion, 'string');
		assert.ok(Array.isArray(entry.response.headers), 'response.headers array');
		assert.ok(Array.isArray(entry.response.cookies), 'response.cookies array');
		assert.equal(typeof entry.response.content?.mimeType, 'string');
		assert.equal(typeof entry.response.content?.size, 'number');
		assert.equal(typeof entry.response.headersSize, 'number');
		assert.equal(typeof entry.response.bodySize, 'number');
		assert.equal(typeof entry.response.redirectURL, 'string');
		for (const key of ['send', 'wait', 'receive']) assert.equal(typeof entry.timings[key], 'number', `timings.${key}`);
		const started = Date.parse(entry.startedDateTime);
		assert.ok(started >= priorStart - 1000, 'startedDateTime roughly monotonic');
		priorStart = started;
	}
	pass('HAR 1.2 structure + fields for every entry');

	const reqEntries = collectors.network.entries;
	assert.ok(reqEntries.length >= harEntries.length, 'entries getter covers HAR entries');
	log('HAR sample:');
	for (const entry of harEntries.slice(0, 8)) {
		const q = entry.request.queryString.length ? `?${entry.request.queryString.map((p) => `${p.name}=${p.value}`).join('&')}` : '';
		log(`  ${entry.request.method} ${entry.request.url.replace(srv.url, '')}${q} -> ${entry.response.status} ${entry.response.content.mimeType} ${Math.round(entry.time)}ms`);
	}

	// /api/data body through the collector API.
	const apiHar = harEntries.find((e) => e.request.url.includes('/api/data'));
	assert.ok(apiHar, '/api/data must be in the HAR');
	const apiBody = await collectors.network.getBody(apiHar._requestId);
	assert.equal(typeof apiBody.text, 'string', '/api/data body text');
	assert.equal(apiBody.truncated, false, '/api/data body not truncated');
	const apiJson = JSON.parse(apiBody.text);
	assert.deepEqual(apiJson, { ok: true, items: [1, 2, 3], ts: 'fixture' });
	log(`/api/data body via getBody: ${apiBody.text} (size=${apiBody.size} truncated=${apiBody.truncated})`);

	// HAR itself embeds that body as text.
	assert.equal(apiHar.response.content.text, apiBody.text, 'HAR embeds /api/data body');
	assert.equal(apiHar.response.content.mimeType, 'application/json');

	// Binary body stays base64.
	const pngHar = harEntries.find((e) => e.request.url.includes('/img.png'));
	assert.ok(pngHar, '/img.png must be in the HAR');
	assert.equal(pngHar.response.content.encoding, 'base64', 'binary body marked base64 in HAR');
	const pngBody = await collectors.network.getBody(pngHar._requestId);
	assert.ok(pngBody.base64 && pngBody.base64.length > 20, 'binary body returned as base64');

	// Truncation cap (collector was attached with maxBodyBytes: 64KB).
	const bigHar = harEntries.find((e) => e.request.url.includes('/big'));
	assert.ok(bigHar, '/big must be in the HAR');
	assert.equal(bigHar.response.content._truncated, true, '/big body truncated at 64KB');
	const bigBody = await collectors.network.getBody(bigHar._requestId, { maxBytes: 100 });
	assert.equal(bigBody.truncated, true);
	assert.equal(bigBody.size, 100);
	assert.equal(bigBody.reason, 'maxBodyBytes');
	log(`/big: full=${bigBody.fullSize}B, capped at 100 -> size=${bigBody.size} truncated=${bigBody.truncated} reason=${bigBody.reason}`);

	// list()/stats()/404 filtering.
	const apiList = await collectors.network.list({ filter: '/api', method: 'GET' });
	assert.ok(apiList.length >= 1, 'list({filter:"/api", method:"GET"})');
	const notFound = await collectors.network.list({ status: 404 });
	assert.ok(notFound.length >= 1, 'list({status:404}) finds the missing-404 request');
	const statusClass = await collectors.network.list({ status: '4xx' });
	assert.ok(statusClass.length >= 1, 'list({status:"4xx"})');
	const stats = collectors.network.stats();
	assert.ok(stats.requests >= 4 && stats.responses >= 3, 'network stats requests/responses');
	assert.equal(typeof stats.byType, 'object', 'stats.byType');
	assert.ok(stats.bytes > 0, 'stats.bytes > 0');
	log('network stats:', JSON.stringify({ requests: stats.requests, responses: stats.responses, failures: stats.failures, bytes: stats.bytes, byType: stats.byType }));

	// Unknown requestId degrades instead of throwing.
	const unknown = await collectors.network.getBody('does-not-exist');
	assert.equal(unknown.size, 0);
	assert.equal(typeof unknown.reason, 'string');
	pass('network.list/getBody/stats + graceful unknown body');

	/* -------------------------------- console -------------------------------- */
	const consoleEntries = collectors.console.entries;
	assert.ok(consoleEntries.length >= 2, `expected >=2 console entries, got ${consoleEntries.length}`);
	assert.ok(consoleEntries.some((e) => e.text.includes('fixture ready')), 'console has "fixture ready"');
	const warnEntry = consoleEntries.find((e) => e.text.includes('fixture warning'));
	assert.ok(warnEntry, 'console has "fixture warning"');
	assert.equal(warnEntry.level, 'warning');
	assert.ok(consoleEntries.every((e) => e.kind && e.level && typeof e.text === 'string' && typeof e.timestamp === 'string'), 'console entry shape');
	const consoleAll = await collectors.console.list({ level: 'all' });
	assert.equal(consoleAll.length, consoleEntries.length, 'console.list({level:"all"}) returns everything');
	const errorList = await collectors.console.list({ level: 'error' });
	assert.ok(Array.isArray(errorList));
	const exception = consoleEntries.find((e) => e.kind === 'exception');
	assert.ok(exception, 'uncaught exception captured via Runtime.exceptionThrown');
	assert.match(exception.text, /fixture boom/, 'exception text');
	assert.ok(exception.stack && /at\s|\.js:|file:|http/.test(exception.stack), 'exception stack frames captured');
	assert.equal(exception.level, 'error', 'exception level is error');
	log(`console entries: ${consoleEntries.length} -> ${consoleEntries.map((e) => `${e.level}:${e.text.slice(0, 40)}`).join(' | ')}`);
	pass('console collector shape + level filter');

	/* -------------------------------- storage -------------------------------- */
	const storage = await collectStorage(page, { includeValues: true, maxRecords: 50 });
	const origin = storage.origins?.[0];
	assert.ok(origin, 'storage.origins[0]');
	assert.equal(origin.origin, new URL(srv.url).origin, 'storage origin matches fixture origin');
	assert.equal(origin.localStorage['omni-test'], 'hello', 'localStorage omni-test');
	assert.equal(origin.sessionStorage['omni-session'], 'world', 'sessionStorage omni-session');
	assert.ok(Array.isArray(origin.indexedDB), 'indexedDB array');
	assert.ok(origin.cacheStorage && typeof origin.cacheStorage === 'object', 'cacheStorage object');
	assert.ok(Array.isArray(origin.serviceWorkers), 'serviceWorkers array');
	assert.ok(Array.isArray(origin.cookies), 'cookies array');
	assert.equal(storage.counts.localStorage, 1);
	assert.equal(storage.counts.sessionStorage, 1);
	const cookies = await collectCookies(page, {});
	assert.ok(Array.isArray(cookies), 'collectCookies returns an array');
	log(`storage: origin=${origin.origin} localStorage=${JSON.stringify(origin.localStorage)} sessionStorage=${JSON.stringify(origin.sessionStorage)} cookies=${cookies.length} unavailable=${JSON.stringify(storage.unavailable)}`);

	const exported = await exportStorage(page, exportDir, { includeValues: true });
	assert.ok(fs.existsSync(exported.path), 'exportStorage writes storage.json');
	assert.ok(exported.bytes > 0, 'exportStorage bytes > 0');
	pass('storage collect/export (localStorage + sessionStorage verified)');

	/* ------------------------------ captureBundle ------------------------------ */
	const out = await captureBundle(page, { dir: bundleDir, name: 'fixture-home', options: {} });
	assert.ok(fs.existsSync(out.manifestPath), 'manifest.json exists');
	const manifest = JSON.parse(await fsp.readFile(out.manifestPath, 'utf8'));
	assert.equal(manifest.tool, 'omni_capture');
	assert.equal(manifest.name, 'fixture-home');
	assert.ok(manifest.options && manifest.stats, 'manifest has options + stats');
	assert.ok(out.files.length >= 8, `expected >=8 bundle files, got ${out.files.length}`);
	for (const file of out.files) {
		assert.ok(Number.isFinite(file.bytes), `file bytes recorded for ${file.path}`);
		assert.ok(fs.existsSync(file.path), `file exists: ${file.path}`);
	}

	// Files produced by already-implemented sibling modules must be present.
	const required = [
		'manifest.json', 'network.har.json', 'network.json', 'console.json', 'storage.json', 'cookies.json',
		'page.png', 'page-full.png', 'page.pdf', 'perf.json', 'resources.json',
	];
	for (const rel of required) {
		assert.ok(fs.existsSync(path.join(out.dir, rel)), `bundle file missing: ${rel}`);
	}
	pass('captureBundle core files present');

	// HAR written to disk is valid 1.2 and matches the collector.
	const harFile = JSON.parse(await fsp.readFile(path.join(out.dir, 'network.har.json'), 'utf8'));
	assert.equal(harFile.log.version, '1.2');
	assert.equal(harFile.log.entries.length, manifest.har.entries, 'manifest.har.entries matches HAR file');
	assert.ok(harFile.log.entries.length >= 4);

	// Bodies for failures: the 404 responses must have a saved body file.
	const bodiesDir = path.join(out.dir, 'bodies');
	const bodyFiles = await filesOnDisk(bodiesDir);
	assert.ok(bodyFiles.length >= 1, `expected >=1 body file under bodies/, got ${bodyFiles.length}`);
	assert.ok(manifest.bodies && manifest.bodies.ok !== false, 'manifest.bodies ok');
	assert.equal(manifest.bodies.count, bodyFiles.length, 'manifest.bodies.count matches files');
	const failedSamples = manifest.bodies.samples || [];
	assert.ok(failedSamples.some((b) => b.status === 404), `body sample has 404: ${JSON.stringify(failedSamples)}`);
	log(`bodies: ${bodyFiles.length} file(s) -> ${bodyFiles.join(', ')}`);

	// Snapshot-dependent parts may still be stubs (owner: mod-page); record, don't fail.
	const snapshotParts = ['page', 'html', 'text', 'ax'];
	const pending = snapshotParts.filter((p) => manifest[p] && !manifest[p].ok);
	for (const p of snapshotParts) {
		assert.ok(manifest[p], `manifest.${p} present`);
		const rel = { page: 'page.json', html: 'dom.html', text: 'text.txt', ax: 'ax.json' }[p];
		if (manifest[p].ok) assert.ok(fs.existsSync(path.join(out.dir, rel)), `${rel} exists when manifest.${p}.ok`);
	}
	log(pending.length ? `snapshot parts pending (stubs): ${pending.map((p) => `${p}:${String(manifest[p].error).slice(0, 50)}`).join(' | ')}` : 'snapshot parts all captured');

	assert.equal(manifest.stats.console.warnings >= 1, true, 'stats.console.warnings >= 1');
	assert.ok(manifest.stats.page.title.includes('Omni Fixture Home'), `stats.page.title = ${manifest.stats.page.title}`);
	assert.ok(manifest.stats.durationMs > 0, 'stats.durationMs > 0');
	assert.ok(Array.isArray(manifest.warnings), 'manifest.warnings is an array');

	log('captureBundle files:');
	let total = 0;
	for (const file of out.files.sort((a, b) => a.path.localeCompare(b.path))) {
		total += file.bytes;
		log(`  ${path.relative(out.dir, file.path).replace(/\\/g, '/').padEnd(28)} ${String(file.bytes).padStart(8)} B`);
	}
	log(`captureBundle dir=${out.dir} files=${out.files.length} total=${total}B (${manifest.stats.totalBytesText})`);
	log(`manifest parts: ${Object.keys(manifest).filter((k) => manifest[k] && manifest[k].ok !== undefined).map((k) => `${k}=${manifest[k].ok ? 'ok' : manifest[k].skipped ? 'skip' : 'ERR'}`).join(' ')}`);

	/* ---------------------- degradation: everything disabled ---------------------- */
	const off = {
		screenshot: false, pdf: false, har: false, bodies: false, console: false, storage: false,
		ax: false, html: false, text: false, meta: false, links: false, forms: false,
		perf: false, resources: false,
	};
	const min = await captureBundle(page, { dir: minDir, name: 'minimal', options: off });
	const minManifest = JSON.parse(await fsp.readFile(min.manifestPath, 'utf8'));
	assert.equal(minManifest.har.skipped, true, 'har skipped');
	assert.equal(minManifest.screenshot.skipped, true, 'screenshot skipped');
	assert.equal(minManifest.pdf.skipped, true, 'pdf skipped');
	assert.equal(minManifest.console.skipped, true, 'console skipped');
	assert.equal(fs.existsSync(path.join(min.dir, 'page.png')), false, 'no screenshot when disabled');
	assert.equal(fs.existsSync(path.join(min.dir, 'network.har.json')), false, 'no HAR when disabled');
	log(`degradation: minimal bundle files=${min.files.length} (${(await filesOnDisk(min.dir)).join(', ')})`);
	pass('disabled options degrade without throwing');

	/* --------------------- memory cap: maxEntries eviction --------------------- */
	const page2 = await session.newPage('about:blank');
	try {
		const small = attachCollectors(page2, { maxEntries: 3, maxBodyBytes: 16 * 1024, bodies: 'failures' });
		await page2.goto(srv.url + '/', { waitUntil: 'load', settle: 600 });
		await small.network.settle();
		const smallStats = small.network.stats();
		assert.ok(small.network.entries.length <= 3, `entries capped at 3, got ${small.network.entries.length}`);
		assert.ok(smallStats.dropped >= 1, `oldest entries dropped, got ${smallStats.dropped}`);
		const smallHar = await small.network.har();
		assert.ok(smallHar.log.entries.length <= 3, 'HAR respects maxEntries');
		log(`memory cap: maxEntries=3 -> kept=${small.network.entries.length} dropped=${smallStats.dropped} HAR=${smallHar.log.entries.length}`);
		pass('network memory cap (maxEntries) evicts oldest entries');

		/* --------------------------------- verdict --------------------------------- */
		log('ALL OK');
	} finally {
		await session.closePage(page2.targetId);
	}
} catch (err) {
	exitCode = 1;
	console.error('[capture-test] FAILED:', err && err.stack ? err.stack : err);
} finally {
	try {
		await session.stop();
	} catch (err) {
		console.error('[capture-test] session.stop:', err?.message || err);
	}
	try {
		await srv.close();
	} catch (err) {
		console.error('[capture-test] srv.close:', err?.message || err);
	}
}

process.exit(exitCode);
