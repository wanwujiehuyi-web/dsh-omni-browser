// dsh-omni-browser / lib/collect.js
// Network + Console collectors built on the raw CDP events exposed by PageHandle.
//
// Zero dependencies, ESM. Every failure path degrades to a recorded field instead
// of throwing: a collector must never take down the caller.
import path from 'node:path';
import { writeJson, fileSize } from './util.js';

/** Where an attached collector bundle is remembered on the PageHandle. */
const ATTACHED = Symbol.for('dsh.omni.collectors');

const DEFAULT_NETWORK = {
	maxEntries: 3000,
	maxBodyBytes: 5 * 1024 * 1024,
	maxTotalBodyBytes: 20 * 1024 * 1024,
	bodies: 'all', // 'all' | 'failures' | false
};
const DEFAULT_CONSOLE = { maxEntries: 3000 };

/** ISO timestamp for "now" (used when CDP gives no wall clock). */
function nowIso() {
	return new Date().toISOString();
}

function toIso(wallTime) {
	if (!wallTime) return nowIso();
	try {
		return new Date(wallTime * 1000).toISOString();
	} catch {
		return nowIso();
	}
}

/** Round to 0.1 ms (HAR consumers expect numbers, not float noise). */
function roundMs(value) {
	const n = Number(value);
	if (!Number.isFinite(n)) return 0;
	return Math.round(n * 10) / 10;
}

function headerLower(headers) {
	const out = {};
	for (const [k, v] of Object.entries(headers || {})) out[String(k).toLowerCase()] = String(v);
	return out;
}

function mergeHeaders(base, extra) {
	const out = { ...(base || {}) };
	for (const [k, v] of Object.entries(extra || {})) out[String(k).toLowerCase()] = String(v);
	return out;
}

function headerValue(headers, name) {
	if (!headers) return undefined;
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return v;
	return undefined;
}

function byteLength(text) {
	if (text === undefined || text === null) return 0;
	return Buffer.byteLength(String(text), 'utf8');
}

/** Parse a `Cookie:` request header into HAR cookie objects. */
function parseRequestCookies(headers) {
	const raw = headerValue(headers, 'cookie');
	if (!raw) return [];
	const out = [];
	for (const part of String(raw).split(';')) {
		const s = part.trim();
		if (!s) continue;
		const i = s.indexOf('=');
		if (i === -1) out.push({ name: s, value: '' });
		else out.push({ name: s.slice(0, i).trim(), value: s.slice(i + 1).trim() });
	}
	return out;
}

/** Parse one or more `Set-Cookie:` header lines into HAR cookie objects. */
function parseResponseCookies(headers) {
	const raw = headerValue(headers, 'set-cookie');
	if (!raw) return [];
	const lines = String(raw).split(/\r?\n/);
	const out = [];
	for (const line of lines) {
		const s = line.trim();
		if (!s) continue;
		const parts = s.split(';');
		const first = parts.shift() || '';
		const i = first.indexOf('=');
		const cookie = { name: i === -1 ? first.trim() : first.slice(0, i).trim(), value: i === -1 ? '' : first.slice(i + 1).trim() };
		for (const attr of parts) {
			const a = attr.trim();
			const eq = a.indexOf('=');
			const key = (eq === -1 ? a : a.slice(0, eq)).trim().toLowerCase();
			const val = eq === -1 ? '' : a.slice(eq + 1).trim();
			if (key === 'path') cookie.path = val;
			else if (key === 'domain') cookie.domain = val;
			else if (key === 'expires') cookie.expires = val;
			else if (key === 'httponly') cookie.httpOnly = true;
			else if (key === 'secure') cookie.secure = true;
			else if (key === 'samesite') cookie.sameSite = val;
		}
		out.push(cookie);
	}
	return out;
}

/** Approximate HAR headersSize (request line + header lines + CRLFs). */
function estimateHeadersSize(firstLine, headers) {
	let size = byteLength(firstLine);
	for (const [k, v] of Object.entries(headers || {})) size += byteLength(`${k}: ${v}\r\n`);
	return size + 2;
}

function queryStringFor(url) {
	try {
		const parsed = new URL(url);
		const out = [];
		for (const [name, value] of parsed.searchParams) out.push({ name, value });
		return out;
	} catch {
		return [];
	}
}

/* ------------------------------------------------------------------ *
 * Console helpers
 * ------------------------------------------------------------------ */

function remoteArgText(arg) {
	if (arg === null || arg === undefined) return String(arg);
	if (typeof arg === 'object') {
		if ('value' in arg) return arg.value;
		if (arg.unserializableValue !== undefined) return String(arg.unserializableValue);
		if (arg.type === 'undefined') return 'undefined';
		if (arg.subtype === 'null') return 'null';
		return oneLine(arg.description ?? arg.className ?? arg.type ?? 'unknown');
	}
	return String(arg);
}

function oneLine(s, max = 500) {
	const text = String(s ?? '').replace(/\s+/g, ' ').trim();
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function remoteArgs(args) {
	return (args || []).map(remoteArgText);
}

function formatStack(stackTrace) {
	const frames = stackTrace?.callFrames;
	if (!Array.isArray(frames) || !frames.length) return undefined;
	return frames
		.slice(0, 40)
		.map((f) => {
			const fn = f.functionName || '<anonymous>';
			const loc = f.url ? `${f.url}:${(f.lineNumber ?? 0) + 1}:${(f.columnNumber ?? 0) + 1}` : '<native>';
			return `    at ${fn} (${loc})`;
		})
		.join('\n');
}

const CONSOLE_LEVEL = {
	log: 'info',
	info: 'info',
	debug: 'debug',
	dir: 'info',
	dirxml: 'info',
	table: 'info',
	trace: 'debug',
	startGroup: 'info',
	startGroupCollapsed: 'info',
	endGroup: 'info',
	assert: 'error',
	error: 'error',
	warning: 'warning',
};

/* ================================================================== *
 * NetworkCollector
 * ================================================================== */

export class NetworkCollector {
	constructor(page, opts = {}) {
		this.page = page;
		this.opts = { ...DEFAULT_NETWORK, ...opts };
		this._order = []; // {entry, request, startedTs, responseTs, finishTs, body, ...}
		this._records = new Map(); // requestId -> current record
		this._extraRequestHeaders = new Map(); // requestId -> headers (requestWillBeSentExtraInfo)
		this._extraResponseHeaders = new Map(); // requestId -> headers (responseReceivedExtraInfo)
		this._pending = new Set(); // in-flight body fetches
		this._unsubs = [];
		this._dropped = 0;
		this._truncated = 0;
		this._bodyCount = 0;
		this._totalBodyBytes = 0;
		this._bodiesFailed = 0;
	}

	install() {
		const on = (method, fn) => this._unsubs.push(this.page.on(method, (event) => fn(event.params || {})));
		on('Network.requestWillBeSent', (p) => this._onRequest(p));
		on('Network.requestWillBeSentExtraInfo', (p) => this._onRequestExtraInfo(p));
		on('Network.responseReceived', (p) => this._onResponse(p));
		on('Network.responseReceivedExtraInfo', (p) => this._onResponseExtraInfo(p));
		on('Network.loadingFinished', (p) => this._onFinished(p));
		on('Network.loadingFailed', (p) => this._onFailed(p));
		on('Network.requestServedFromCache', (p) => this._onServedFromCache(p));
		return this;
	}

	/* ------------------------------ bookkeeping ------------------------------ */

	get entries() {
		return this._order.filter((r) => !r.evicted).map((r) => r.entry);
	}

	get dropped() {
		return this._dropped;
	}

	_findRecord(requestId) {
		const direct = this._records.get(requestId);
		if (direct && !direct.evicted) return direct;
		for (let i = this._order.length - 1; i >= 0; i -= 1) {
			const rec = this._order[i];
			if (!rec.evicted && rec.requestId === requestId) return rec;
		}
		return null;
	}

	_pushRecord(record) {
		this._order.push(record);
		this._records.set(record.requestId, record);
		while (this._order.length > this.opts.maxEntries) {
			const old = this._order.shift();
			old.evicted = true;
			if (this._records.get(old.requestId) === old) this._records.delete(old.requestId);
			if (old.body) this._totalBodyBytes = Math.max(0, this._totalBodyBytes - old.body.length);
			this._dropped += 1;
		}
	}

	/** Await every in-flight response-body fetch (capture uses this before export). */
	async settle() {
		while (this._pending.size) {
			await Promise.allSettled([...this._pending]);
		}
	}

	/* -------------------------------- events -------------------------------- */

	_onRequest(params) {
		const { requestId, request, timestamp, wallTime, initiator, type, loaderId, documentURL, redirectResponse } = params;
		if (!requestId || !request) return;
		const previous = this._records.get(requestId);
		if (previous && !previous.evicted) {
			if (redirectResponse) {
				// Finalize the redirect hop as its own HAR entry, then start the next hop.
				this._applyResponse(previous, redirectResponse, timestamp);
				previous.finishTs = timestamp;
				previous.entry.durationMs = roundMs((timestamp - previous.startedTs) * 1000);
				previous.done = true;
				this._records.delete(requestId);
			} else if (!previous.done) {
				previous.evicted = true;
				this._records.delete(requestId);
			}
		}
		const headers = mergeHeaders(request.headers || {}, this._extraRequestHeaders.get(requestId));
		this._extraRequestHeaders.delete(requestId);
		const entry = {
			requestId,
			url: request.url || '',
			method: request.method || 'GET',
			status: 0,
			statusText: '',
			mimeType: '',
			resourceType: type || 'Other',
			startedAt: toIso(wallTime),
			durationMs: 0,
			requestHeaders: headers,
			responseHeaders: {},
			postData: request.postData ?? null,
			sizes: { encoded: 0, decoded: 0 },
			fromCache: false,
			failed: false,
			errorText: null,
			initiator: initiator
				? {
						type: initiator.type || null,
						url: initiator.url || initiator.stack?.callFrames?.[0]?.url || null,
						lineNumber: initiator.lineNumber ?? initiator.stack?.callFrames?.[0]?.lineNumber ?? null,
				  }
				: null,
		};
		const record = {
			requestId,
			entry,
			request,
			documentURL: documentURL || null,
			loaderId: loaderId || null,
			startedTs: Number(timestamp) || 0,
			wallTs: Number(wallTime) || 0,
			responseTs: 0,
			finishTs: 0,
			body: undefined,
			base64Encoded: false,
			bodyLoaded: false,
			bodyError: null,
			bodySkipped: null,
			fullSize: 0,
			truncated: false,
			done: false,
			evicted: false,
		};
		this._pushRecord(record);
		if (params.redirectResponse) entry.redirectedFrom = record.request?.url || null;
	}

	_onRequestExtraInfo(params) {
		const { requestId, headers } = params;
		if (!requestId) return;
		const record = this._records.get(requestId);
		if (record && !record.evicted) {
			record.entry.requestHeaders = mergeHeaders(record.entry.requestHeaders, headers);
		} else {
			this._extraRequestHeaders.set(requestId, headerLower(headers));
			while (this._extraRequestHeaders.size > this.opts.maxEntries * 2) {
				this._extraRequestHeaders.delete(this._extraRequestHeaders.keys().next().value);
			}
		}
	}

	_applyResponse(record, response, timestamp) {
		const entry = record.entry;
		entry.status = Number(response.status) || 0;
		entry.statusText = response.statusText || '';
		entry.mimeType = response.mimeType || headerValue(response.headers, 'content-type') || '';
		entry.fromCache = Boolean(response.fromDiskCache || response.fromPrefetchCache || response.fromServiceWorker);
		if (response.protocol) entry.httpVersion = response.protocol;
		if (response.remoteIPAddress) entry.serverIPAddress = response.remoteIPAddress;
		if (Number.isFinite(response.encodedDataLength)) entry.sizes.encoded = response.encodedDataLength;
		const headers = this._extraResponseHeaders.get(record.requestId);
		this._extraResponseHeaders.delete(record.requestId);
		entry.responseHeaders = mergeHeaders(response.headers || {}, headers || {});
		record.responseTs = Number(timestamp) || record.startedTs;
		record.done = true;
		const contentLength = Number(headerValue(entry.responseHeaders, 'content-length'));
		if (Number.isFinite(contentLength) && contentLength > 0) entry.sizes.decoded = contentLength;
	}

	_onResponse(params) {
		const record = this._records.get(params.requestId);
		if (!params.response) return;
		if (record && !record.evicted) {
			if (record.finishTs) return; // already finalized
			this._applyResponse(record, params.response, params.timestamp);
			if (record.entry.status >= 400) record.entry.isFailureStatus = true;
		} else {
			// Response without a request event (should not happen); keep headers for the next hop.
			this._extraResponseHeaders.set(params.requestId, headerLower(params.response.headers));
			while (this._extraResponseHeaders.size > this.opts.maxEntries * 2) {
				this._extraResponseHeaders.delete(this._extraResponseHeaders.keys().next().value);
			}
		}
	}

	_onResponseExtraInfo(params) {
		const { requestId, headers } = params;
		if (!requestId) return;
		const record = this._records.get(requestId);
		if (record && !record.done) {
			record.entry.responseHeaders = mergeHeaders(record.entry.responseHeaders, headers);
		} else if (record && record.done) {
			record.entry.responseHeaders = mergeHeaders(record.entry.responseHeaders, headers);
		} else {
			this._extraResponseHeaders.set(requestId, headerLower(headers));
			while (this._extraResponseHeaders.size > this.opts.maxEntries * 2) {
				this._extraResponseHeaders.delete(this._extraResponseHeaders.keys().next().value);
			}
		}
	}

	_onFinished(params) {
		const record = this._records.get(params.requestId);
		if (!record || record.evicted) return;
		record.finishTs = Number(params.timestamp) || record.startedTs;
		record.done = true;
		record.entry.durationMs = roundMs((record.finishTs - record.startedTs) * 1000);
		if (Number.isFinite(params.encodedDataLength) && params.encodedDataLength > 0) {
			record.entry.sizes.encoded = params.encodedDataLength;
		}
		if (this.opts.bodies === false) return;
		if (this.opts.bodies === 'failures' && !this._isFailure(record.entry)) return;
		const promise = this._fetchBody(record);
		this._pending.add(promise);
		promise.then(
			() => this._pending.delete(promise),
			() => this._pending.delete(promise),
		);
	}

	_isFailure(entry) {
		return Boolean(entry.failed) || Number(entry.status) >= 400;
	}

	_onFailed(params) {
		const record = this._records.get(params.requestId);
		if (!record || record.evicted) return;
		record.finishTs = Number(params.timestamp) || record.startedTs;
		record.entry.failed = true;
		record.entry.errorText = params.errorText || 'loading failed';
		if (params.blockedReason) record.entry.blockedReason = params.blockedReason;
		if (params.canceled) record.entry.canceled = true;
		record.entry.durationMs = roundMs((record.finishTs - record.startedTs) * 1000);
		record.done = true;
	}

	_onServedFromCache(params) {
		const record = this._records.get(params.requestId);
		if (record && !record.evicted) record.entry.fromCache = true;
	}

	/* ------------------------------ response body ------------------------------ */

	async _fetchBody(record) {
		if (record.bodyLoaded || record.bodySkipped) return;
		record.bodyLoaded = true;
		if (this._totalBodyBytes >= this.opts.maxTotalBodyBytes) {
			record.bodySkipped = 'total-body-budget';
			record.entry.bodyOmitted = 'total-body-budget';
			this._bodiesFailed += 1;
			return;
		}
		let result;
		try {
			result = await this.page.send('Network.getResponseBody', { requestId: record.requestId }, { timeout: 15000 });
		} catch (err) {
			record.bodyError = err?.message || String(err);
			record.entry.bodyError = record.bodyError;
			this._bodiesFailed += 1;
			return;
		}
		if (!result || typeof result.body !== 'string') {
			record.bodyError = 'empty response body';
			record.entry.bodyError = record.bodyError;
			this._bodiesFailed += 1;
			return;
		}
		const raw = result.base64Encoded ? Buffer.from(result.body, 'base64') : Buffer.from(result.body, 'utf8');
		record.base64Encoded = Boolean(result.base64Encoded);
		record.fullSize = raw.length;
		const maxBytes = Number(this.opts.maxBodyBytes) || 0;
		let body = raw;
		if (maxBytes > 0 && raw.length > maxBytes) {
			body = raw.subarray(0, maxBytes);
			record.truncated = true;
			this._truncated += 1;
		}
		record.body = body;
		this._bodyCount += 1;
		this._totalBodyBytes += body.length;
		const entry = record.entry;
		entry.sizes.decoded = raw.length;
		if (record.truncated) {
			entry.truncated = true;
			entry.fullSize = raw.length;
		}
	}

	/**
	 * Fetch a response body. Returns `{text|base64, size, truncated, reason?}`.
	 * Never throws; a missing/unfetchable body is reported via `reason`.
	 */
	async getBody(requestId, opts = {}) {
		const record = this._findRecord(requestId);
		if (!record) return { size: 0, truncated: false, reason: 'unknown requestId' };
		if (!record.body && !record.bodyError && !record.bodyLoaded) {
			// On-demand fetch (explicit user request always wins over the auto policy).
			try {
				await this._fetchBody(record);
			} catch (err) {
				record.bodyError = err?.message || String(err);
				record.entry.bodyError = record.bodyError;
			}
		}
		if (!record.body) {
			const reason = record.bodyError || record.bodySkipped || 'body not available (redirect, failed, or evicted)';
			record.entry.bodyError = record.entry.bodyError || reason;
			return { size: 0, truncated: false, reason };
		}
		const maxBytes = Number(opts.maxBytes ?? this.opts.maxBodyBytes) || 0;
		let body = record.body;
		let truncated = record.truncated;
		if (maxBytes > 0 && body.length > maxBytes) {
			body = body.subarray(0, maxBytes);
			truncated = true;
		}
		const out = {
			size: body.length,
			fullSize: record.fullSize || body.length,
			truncated,
			mimeType: record.entry.mimeType || null,
		};
		if (truncated) out.reason = 'maxBodyBytes';
		if (record.base64Encoded) out.base64 = body.toString('base64');
		else out.text = body.toString('utf8');
		return out;
	}

	/* --------------------------------- list --------------------------------- */

	async list(opts = {}) {
		const { filter, method, status, type, limit } = opts;
		let out = this.entries;
		if (filter) {
			if (filter instanceof RegExp) out = out.filter((e) => filter.test(e.url));
			else {
				const needle = String(filter).toLowerCase();
				out = out.filter((e) => e.url.toLowerCase().includes(needle));
			}
		}
		if (method) {
			const methods = (Array.isArray(method) ? method : [method]).map((m) => String(m).toUpperCase());
			out = out.filter((e) => methods.includes(String(e.method).toUpperCase()));
		}
		if (status !== undefined && status !== null) {
			if (status === 'failed' || status === 'error') out = out.filter((e) => e.failed || Number(e.status) >= 400);
			else if (typeof status === 'string' && /^[1-5]xx$/i.test(status)) out = out.filter((e) => Math.floor(Number(e.status) / 100) === Number(status[0]));
			else out = out.filter((e) => Number(e.status) === Number(status));
		}
		if (type) {
			const types = (Array.isArray(type) ? type : [type]).map((t) => String(t).toLowerCase());
			out = out.filter((e) => types.includes(String(e.resourceType).toLowerCase()));
		}
		if (limit && limit > 0) out = out.slice(-limit);
		return out;
	}

	stats() {
		const entries = this.entries;
		let bytes = 0;
		let encodedBytes = 0;
		const byType = {};
		let responses = 0;
		let failures = 0;
		for (const entry of entries) {
			const decoded = Number(entry.sizes?.decoded) || 0;
			const encoded = Number(entry.sizes?.encoded) || 0;
			bytes += decoded || encoded;
			encodedBytes += encoded;
			const t = entry.resourceType || 'Other';
			byType[t] = (byType[t] || 0) + 1;
			if (entry.status) responses += 1;
			if (entry.failed || (entry.status && entry.status >= 400)) failures += 1;
		}
		return {
			requests: entries.length,
			responses,
			failures,
			bytes,
			encodedBytes,
			byType,
			bodies: this._bodyCount,
			bodiesTruncated: this._truncated,
			bodiesFailed: this._bodiesFailed,
			dropped: this._dropped,
			totalBodyBytes: this._totalBodyBytes,
		};
	}

	/* ---------------------------------- HAR ---------------------------------- */

	async har() {
		return {
			log: {
				version: '1.2',
				creator: { name: 'dsh-omni-browser', version: '0.1.0' },
				browser: this.page?.browser?.versionInfo?.Browser ? { name: 'Chrome', version: this.page.browser.versionInfo.Browser } : undefined,
				pages: this._harPages(),
				entries: this._order.filter((r) => !r.evicted).map((r) => this._harEntry(r)),
			},
		};
	}

	_harPages() {
		const groups = new Map();
		for (const record of this._order) {
			if (record.evicted) continue;
			const id = record.loaderId || `${record.entry.url}::document`;
			if (!groups.has(id)) {
				groups.set(id, {
					startedDateTime: record.entry.startedAt || nowIso(),
					id,
					title: record.documentURL || record.entry.url || '',
					pageTimings: { onContentLoad: -1, onLoad: -1 },
				});
			}
		}
		return [...groups.values()];
	}

	_harEntry(record) {
		const entry = record.entry;
		const startedTs = record.startedTs;
		const responseTs = record.responseTs && record.responseTs >= startedTs ? record.responseTs : 0;
		const finishTs = record.finishTs && record.finishTs >= startedTs ? record.finishTs : 0;
		let time = 0;
		let wait = 0;
		let receive = 0;
		if (responseTs) {
			wait = roundMs((responseTs - startedTs) * 1000);
			if (finishTs) receive = roundMs((finishTs - responseTs) * 1000);
			time = roundMs(wait + receive);
		} else {
			time = roundMs(Number(entry.durationMs) || 0);
			wait = time;
		}
		const send = 0;
		const requestPostData = entry.postData
			? {
					mimeType: headerValue(entry.requestHeaders, 'content-type') || 'application/x-www-form-urlencoded',
					text: String(entry.postData),
			  }
			: undefined;
		const content = {
			size: record.body ? record.fullSize || record.body.length : Number(entry.sizes?.decoded) || Number(entry.sizes?.encoded) || 0,
			mimeType: entry.mimeType || 'application/octet-stream',
		};
		if (record.body) {
			if (record.base64Encoded) {
				content.text = record.body.toString('base64');
				content.encoding = 'base64';
			} else {
				content.text = record.body.toString('utf8');
			}
			if (record.truncated) {
				content._truncated = true;
				content._fullSize = record.fullSize;
			}
		}
		const har = {
			pageref: record.loaderId || undefined,
			startedDateTime: entry.startedAt || nowIso(),
			time,
			request: {
				method: entry.method || 'GET',
				url: entry.url || '',
				httpVersion: entry.httpVersion || 'HTTP/1.1',
				cookies: parseRequestCookies(entry.requestHeaders),
				headers: Object.entries(entry.requestHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
				queryString: queryStringFor(entry.url),
				postData: requestPostData,
				headersSize: estimateHeadersSize(`${entry.method || 'GET'} ${safePath(entry.url)} HTTP/1.1\r\n`, entry.requestHeaders),
				bodySize: requestPostData ? byteLength(requestPostData.text) : 0,
			},
			response: {
				status: Number(entry.status) || 0,
				statusText: entry.statusText || '',
				httpVersion: entry.httpVersion || 'HTTP/1.1',
				cookies: parseResponseCookies(entry.responseHeaders),
				headers: Object.entries(entry.responseHeaders || {}).map(([name, value]) => ({ name, value: String(value) })),
				content,
				redirectURL: headerValue(entry.responseHeaders, 'location') || '',
				headersSize: estimateHeadersSize(`${entry.httpVersion || 'HTTP/1.1'} ${Number(entry.status) || 0} ${entry.statusText || ''}\r\n`, entry.responseHeaders),
				bodySize: record.body ? record.fullSize || record.body.length : Number(entry.sizes?.decoded) || -1,
			},
			cache: {},
			timings: { send, wait, receive },
			serverIPAddress: entry.serverIPAddress || undefined,
			_resourceType: entry.resourceType,
			_requestId: entry.requestId,
		};
		if (entry.failed) har.response._error = entry.errorText || 'failed';
		return har;
	}

	/** Full JSON snapshot, optionally embedding captured response bodies. */
	async toJSON(opts = {}) {
		const includeBodies = opts.includeBodies !== false;
		const entries = this.entries.map((entry) => {
			const record = this._findRecord(entry.requestId);
			const out = { ...entry };
			if (includeBodies && record && record.body) {
				out.responseBody = {
					size: record.body.length,
					fullSize: record.fullSize || record.body.length,
					truncated: Boolean(record.truncated),
					...(record.base64Encoded ? { base64: record.body.toString('base64'), encoding: 'base64' } : { text: record.body.toString('utf8') }),
				};
			}
			return out;
		});
		return { url: this.page?.currentUrl?.() || '', capturedAt: nowIso(), stats: this.stats(), entries };
	}

	/* --------------------------------- export --------------------------------- */

	/** Write `network.har.json` into `dir`. Returns `{path, bytes, entries}`. */
	async export(dir) {
		const file = path.join(dir, 'network.har.json');
		const har = await this.har();
		await writeJson(file, har);
		return { path: file, bytes: await fileSize(file), entries: har.log.entries.length };
	}

	clear() {
		this._order = [];
		this._records.clear();
		this._extraRequestHeaders.clear();
		this._extraResponseHeaders.clear();
		this._dropped = 0;
		this._truncated = 0;
		this._bodyCount = 0;
		this._totalBodyBytes = 0;
		this._bodiesFailed = 0;
		return this;
	}

	detach() {
		for (const off of this._unsubs) {
			try {
				off();
			} catch {
				/* ignore */
			}
		}
		this._unsubs = [];
	}

	toJSON() {
		return { stats: this.stats(), entries: this.entries };
	}
}

function safePath(url) {
	try {
		const u = new URL(url);
		return `${u.pathname}${u.search}`;
	} catch {
		return '/';
	}
}

/* ================================================================== *
 * ConsoleCollector
 * ================================================================== */

export class ConsoleCollector {
	constructor(page, opts = {}) {
		this.page = page;
		this.opts = { ...DEFAULT_CONSOLE, ...opts };
		this._entries = [];
		this._unsubs = [];
		this._counts = { total: 0, errors: 0, warnings: 0, byKind: {}, byLevel: {} };
	}

	install() {
		const on = (method, fn) => this._unsubs.push(this.page.on(method, (event) => fn(event.params || {})));
		on('Runtime.consoleAPICalled', (p) => this._onConsoleApi(p));
		on('Runtime.exceptionThrown', (p) => this._onException(p));
		on('Log.entryAdded', (p) => this._onLogEntry(p));
		return this;
	}

	get entries() {
		return [...this._entries];
	}

	_push(entry) {
		this._entries.push(entry);
		this._counts.total += 1;
		if (entry.level === 'error') this._counts.errors += 1;
		if (entry.level === 'warning') this._counts.warnings += 1;
		this._counts.byKind[entry.kind] = (this._counts.byKind[entry.kind] || 0) + 1;
		this._counts.byLevel[entry.level] = (this._counts.byLevel[entry.level] || 0) + 1;
		while (this._entries.length > this.opts.maxEntries) {
			const dropped = this._entries.shift();
			this._counts.total -= 1;
			if (dropped.level === 'error') this._counts.errors -= 1;
			if (dropped.level === 'warning') this._counts.warnings -= 1;
		}
	}

	_ts(value) {
		const n = Number(value);
		if (!Number.isFinite(n) || n <= 0) return { timestamp: nowIso(), timeMs: null };
		return { timestamp: new Date(n).toISOString(), timeMs: n };
	}

	_onConsoleApi(params) {
		const { type, args, timestamp, stackTrace, executionContextId } = params;
		const level = CONSOLE_LEVEL[type] || 'info';
		const frame = stackTrace?.callFrames?.[0];
		const values = remoteArgs(args);
		const text = values
			.map((v) => (typeof v === 'string' ? v : oneLine(String(v ?? ''), 1000)))
			.join(' ');
		const entry = {
			kind: 'console-api',
			type: type || 'log',
			level,
			text,
			args: values,
			url: frame?.url || null,
			line: frame ? (frame.lineNumber ?? 0) + 1 : null,
			...(this._ts(timestamp)),
			...(executionContextId !== undefined ? { executionContextId } : {}),
		};
		const stack = formatStack(stackTrace);
		if (stack) entry.stack = stack;
		this._push(entry);
	}

	_onException(params) {
		const details = params.exceptionDetails || {};
		const description = details.exception?.description;
		const text = oneLine(description || details.text || 'Uncaught exception', 4000);
		const stack = formatStack(details.stackTrace) || (description && description.includes('\n') ? description : undefined);
		const entry = {
			kind: 'exception',
			type: 'exception',
			level: 'error',
			text,
			args: [description || details.text || 'exception'],
			url: details.url || details.stackTrace?.callFrames?.[0]?.url || null,
			line: details.lineNumber !== undefined ? details.lineNumber + 1 : details.stackTrace?.callFrames?.[0] ? details.stackTrace.callFrames[0].lineNumber + 1 : null,
			...(this._ts(params.timestamp)),
			...(details.exception?.className ? { className: details.exception.className } : {}),
			...(details.scriptId ? { scriptId: details.scriptId } : {}),
		};
		if (stack) entry.stack = stack;
		if (details.exception?.preview) entry.preview = details.exception.preview;
		this._push(entry);
	}

	_onLogEntry(params) {
		const e = params.entry || {};
		const level = e.level === 'warning' ? 'warning' : e.level === 'error' ? 'error' : e.level === 'verbose' ? 'debug' : 'info';
		const values = remoteArgs(e.args);
		const entry = {
			kind: 'log',
			type: e.source || 'log',
			level,
			text: oneLine(e.text || values.join(' '), 4000),
			args: values,
			url: e.url || null,
			line: e.lineNumber ?? null,
			...(this._ts(e.timestamp)),
			...(e.source ? { source: e.source } : {}),
			...(e.networkRequestId ? { networkRequestId: e.networkRequestId } : {}),
			...(e.workerId ? { workerId: e.workerId } : {}),
		};
		const stack = formatStack(e.stackTrace);
		if (stack) entry.stack = stack;
		this._push(entry);
	}

	async list(opts = {}) {
		const { level, kind, filter, limit } = opts;
		let out = this._entries;
		if (level && String(level).toLowerCase() !== 'all') {
			const levels = (Array.isArray(level) ? level : [level]).map((l) => String(l).toLowerCase());
			out = out.filter((e) => levels.includes(e.level));
		}
		if (kind && String(kind).toLowerCase() !== 'all') {
			const kinds = (Array.isArray(kind) ? kind : [kind]).map((k) => String(k).toLowerCase());
			out = out.filter((e) => kinds.includes(e.kind));
		}
		if (filter) {
			if (filter instanceof RegExp) out = out.filter((e) => filter.test(e.text));
			else {
				const needle = String(filter).toLowerCase();
				out = out.filter((e) => String(e.text).toLowerCase().includes(needle));
			}
		}
		if (limit && limit > 0) out = out.slice(-limit);
		return out;
	}

	stats() {
		return { ...this._counts, byKind: { ...this._counts.byKind }, byLevel: { ...this._counts.byLevel } };
	}

	clear() {
		this._entries = [];
		this._counts = { total: 0, errors: 0, warnings: 0, byKind: {}, byLevel: {} };
		return this;
	}

	/** Write `console.json` into `dir`. Returns `{path, bytes, counts}`. */
	async export(dir) {
		const file = path.join(dir, 'console.json');
		const counts = this.stats();
		await writeJson(file, { capturedAt: nowIso(), counts, entries: this._entries });
		return { path: file, bytes: await fileSize(file), counts };
	}

	detach() {
		for (const off of this._unsubs) {
			try {
				off();
			} catch {
				/* ignore */
			}
		}
		this._unsubs = [];
	}

	toJSON() {
		return { counts: this.stats(), entries: this.entries };
	}
}

/* ================================================================== *
 * attach / detach
 * ================================================================== */

/** Return the collector bundle already attached to this page, if any. */
export function getCollectors(page) {
	return page ? page[ATTACHED] || null : null;
}

/**
 * Attach network + console collectors. Safe to call before navigation.
 *
 * The CDP domains needed by both collectors are enabled in the background
 * (`bundle.ready`); `page.goto()` also enables them via `ensureCore()`.
 */
export function attachCollectors(page, opts = {}) {
	if (!page) throw new Error('attachCollectors(page): page is required');
	const existing = getCollectors(page);
	if (existing) return existing;

	const network = new NetworkCollector(page, {
		maxEntries: opts.maxEntries ?? opts.networkMaxEntries,
		maxBodyBytes: opts.maxBodyBytes,
		maxTotalBodyBytes: opts.maxTotalBodyBytes,
		bodies: opts.bodies,
	}).install();
	const consoleCollector = new ConsoleCollector(page, { maxEntries: opts.consoleMaxEntries ?? opts.maxEntries }).install();

	const bundle = {
		network,
		console: consoleCollector,
		errors: [],
		ready: null,
		detach() {
			if (page[ATTACHED] === bundle) delete page[ATTACHED];
			network.detach();
			consoleCollector.detach();
		},
	};
	bundle.ready = Promise.resolve()
		.then(() => page.enableDomains({ runtime: true, network: true, log: true }))
		.catch((err) => {
			bundle.errors.push({ part: 'enableDomains', error: err?.message || String(err) });
		});
	page[ATTACHED] = bundle;
	return bundle;
}

export default { attachCollectors, getCollectors, NetworkCollector, ConsoleCollector };
