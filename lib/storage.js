// dsh-omni-browser / lib/storage.js
// Cookies, Web Storage, IndexedDB, CacheStorage, ServiceWorkers and quota.
//
// Zero dependencies, ESM. Every section degrades to an `unavailable`/`errors`
// marker instead of throwing: a page is allowed to block any of these APIs.
import path from 'node:path';
import { writeJson, fileSize } from './util.js';

const MAX_ORIGINS = 20;
const MAX_DBS = 20;

/**
 * Read cookies via `Network.getCookies`.
 * Returns `[{name, value, domain, path, expires, httpOnly, secure, sameSite}]`.
 * Throws only when CDP itself is unusable (captureBundle records the error).
 */
export async function collectCookies(page, opts = {}) {
	await page.enableDomains({ network: true });
	const params = {};
	const urls = (opts.urls || []).filter(Boolean);
	if (urls.length) params.urls = urls;
	const result = await page.send('Network.getCookies', params);
	return (result.cookies || []).map((cookie) => ({
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		expires: cookie.expires ?? -1,
		httpOnly: Boolean(cookie.httpOnly),
		secure: Boolean(cookie.secure),
		sameSite: cookie.sameSite ?? null,
	}));
}

/**
 * Build the in-page async IIFE that reads Web Storage / IndexedDB / CacheStorage.
 * Kept as one expression so it can run through Runtime.evaluate.
 */
function storageExpression({ includeValues, maxRecords }) {
	return `(async () => {
  const MAX = ${Math.max(1, Math.floor(maxRecords) || 200)};
  const WITH_VALUES = ${includeValues ? 'true' : 'false'};
  const out = { origin: location.origin, url: location.href, capturedAt: new Date().toISOString(), unavailable: [], errors: {} };
  const failure = (section, err) => {
    const message = String((err && err.message) || err);
    out.errors[section] = message;
    if (!out.unavailable.includes(section)) out.unavailable.push(section);
    return { unavailable: message };
  };
  const readWebStorage = (name) => {
    try {
      const storage = window[name];
      if (!storage) return failure(name, name + ' is not available');
      const data = {};
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        data[key] = storage.getItem(key);
      }
      return data;
    } catch (err) {
      return failure(name, err);
    }
  };
  out.localStorage = readWebStorage('localStorage');
  out.sessionStorage = readWebStorage('sessionStorage');

  try {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      const estimate = await navigator.storage.estimate();
      out.quota = { usage: estimate.usage ?? null, quota: estimate.quota ?? null, usageDetails: estimate.usageDetails || null };
    }
  } catch (err) { out.errors.quota = String((err && err.message) || err); }

  try {
    if (typeof caches !== 'undefined' && caches && typeof caches.keys === 'function') {
      out.cacheStorage = {};
      const names = await caches.keys();
      for (const name of names) {
        try {
          const cache = await caches.open(name);
          const keys = await cache.keys();
          out.cacheStorage[name] = {
            count: keys.length,
            requests: keys.slice(0, MAX).map((request) => ({ url: request.url, method: request.method })),
          };
        } catch (err) { out.errors['cacheStorage:' + name] = String((err && err.message) || err); }
      }
    } else {
      out.cacheStorage = { unavailable: 'CacheStorage API missing' };
    }
  } catch (err) { out.cacheStorage = failure('cacheStorage', err); }

  try {
    if (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistrations === 'function') {
      const registrations = await navigator.serviceWorker.getRegistrations();
      out.serviceWorkers = registrations.map((registration) => ({
        scope: registration.scope,
        scriptURL:
          (registration.active && registration.active.scriptURL) ||
          (registration.installing && registration.installing.scriptURL) ||
          (registration.waiting && registration.waiting.scriptURL) ||
          '',
        state: (registration.active && registration.active.state) || 'unknown',
      }));
    } else {
      out.serviceWorkers = { unavailable: 'ServiceWorker API missing' };
    }
  } catch (err) { out.serviceWorkers = failure('serviceWorkers', err); }

  try {
    if (typeof indexedDB === 'undefined' || !indexedDB) {
      out.indexedDB = { unavailable: 'indexedDB missing' };
    } else if (typeof indexedDB.databases !== 'function') {
      out.indexedDB = { unavailable: 'indexedDB.databases() unsupported' };
    } else {
      out.indexedDB = [];
      const databases = await indexedDB.databases();
      for (const info of databases) {
        if (!info || !info.name) continue;
        if (out.indexedDB.length >= ${MAX_DBS}) break;
        const database = { name: info.name, version: info.version ?? null, stores: [] };
        let handle = null;
        try {
          handle = await new Promise((resolve, reject) => {
            const request = indexedDB.open(info.name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('indexedDB.open failed'));
            request.onblocked = () => reject(new Error('indexedDB.open blocked'));
            setTimeout(() => reject(new Error('indexedDB.open timed out')), 5000);
          });
          const storeNames = Array.from(handle.objectStoreNames);
          for (const storeName of storeNames) {
            const store = { name: storeName, keyPath: null, autoIncrement: false, count: 0 };
            try {
              const transaction = handle.transaction(storeName, 'readonly');
              const objectStore = transaction.objectStore(storeName);
              store.keyPath = objectStore.keyPath ?? null;
              store.autoIncrement = Boolean(objectStore.autoIncrement);
              const countRequest = objectStore.count();
              const valuesRequest = WITH_VALUES ? objectStore.getAll(null, MAX) : null;
              const toPromise = (request) => new Promise((resolve, reject) => {
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
              });
              const results = await Promise.all([
                toPromise(countRequest),
                valuesRequest ? toPromise(valuesRequest) : Promise.resolve(null),
              ]);
              store.count = results[0] || 0;
              if (WITH_VALUES && Array.isArray(results[1])) {
                store.records = results[1].map((value) => {
                  try { return JSON.parse(JSON.stringify(value)); } catch (err) { return String(value); }
                });
                store.truncated = store.count > store.records.length;
              }
            } catch (err) {
              store.error = String((err && err.message) || err);
            }
            database.stores.push(store);
          }
        } catch (err) {
          database.error = String((err && err.message) || err);
          out.unavailable.push('indexedDB:' + info.name);
        } finally {
          try { handle && handle.close(); } catch (err) { /* ignore */ }
        }
        out.indexedDB.push(database);
      }
    }
  } catch (err) { out.indexedDB = failure('indexedDB', err); }

  return out;
})()`;
}

/**
 * Collect the current document's storage state.
 *
 * → `{capturedAt, url, title, origins:[{origin, localStorage, sessionStorage,
 *     indexedDB, cacheStorage, serviceWorkers, cookies, quota, unavailable, errors}],
 *     unavailable, errors}`
 *
 * Never throws: a blocked/unreadable API is marked unavailable.
 */
export async function collectStorage(page, opts = {}) {
	const includeValues = opts.includeValues !== false;
	const maxRecords = Math.max(1, Math.min(Number(opts.maxRecords) || 200, 5000));
	const result = {
		capturedAt: new Date().toISOString(),
		url: '',
		title: '',
		origins: [],
		unavailable: [],
		errors: {},
	};

	try {
		result.url = page.currentUrl?.() || (await page.evaluate('location.href'));
	} catch {
		/* page may be mid-navigation */
	}
	try {
		result.title = await page.title();
	} catch {
		/* non-fatal */
	}

	let data;
	try {
		data = await page.evaluate(storageExpression({ includeValues, maxRecords }), { awaitPromise: true, returnByValue: true, timeout: 30000 });
	} catch (err) {
		result.errors.evaluate = err?.message || String(err);
		result.unavailable.push('page');
		return result;
	}
	if (!data || typeof data !== 'object') {
		result.errors.evaluate = 'page returned no storage data';
		result.unavailable.push('page');
		return result;
	}

	const origin = data.origin || 'null';
	const originEntry = {
		origin,
		url: data.url || result.url,
		localStorage: data.localStorage ?? null,
		sessionStorage: data.sessionStorage ?? null,
		indexedDB: data.indexedDB ?? [],
		cacheStorage: data.cacheStorage ?? null,
		serviceWorkers: data.serviceWorkers ?? [],
		cookies: [],
		...(data.quota ? { quota: data.quota } : {}),
		unavailable: Array.isArray(data.unavailable) ? data.unavailable : [],
		errors: data.errors || {},
	};

	// Cookies for this origin (best effort — never fatal).
	try {
		originEntry.cookies = await collectCookies(page, { urls: origin && origin !== 'null' ? [origin] : [] });
	} catch (err) {
		originEntry.errors.cookies = err?.message || String(err);
		if (!originEntry.unavailable.includes('cookies')) originEntry.unavailable.push('cookies');
	}

	result.origins.push(originEntry);
	if (originEntry.unavailable.length) result.unavailable.push(...originEntry.unavailable);
	result.errors = { ...result.errors, ...originEntry.errors };
	result.capturedAt = data.capturedAt || result.capturedAt;

	// Convenience aliases consumed by index.js (`omni_storage` modes all/sw).
	result.cookies = originEntry.cookies;
	result.serviceWorkers = Array.isArray(originEntry.serviceWorkers) ? originEntry.serviceWorkers : [];
	if (originEntry.quota) result.quota = originEntry.quota;
	result.counts = {
		localStorage: countKeys(originEntry.localStorage),
		sessionStorage: countKeys(originEntry.sessionStorage),
		cookies: originEntry.cookies.length,
		indexedDB: Array.isArray(originEntry.indexedDB) ? originEntry.indexedDB.length : 0,
		serviceWorkers: result.serviceWorkers.length,
	};
	return result;
}

function countKeys(value) {
	if (!value || typeof value !== 'object' || value.unavailable) return 0;
	return Object.keys(value).length;
}

/**
 * Write `storage.json` into `dir`. → `{path, bytes, data}`.
 */
export async function exportStorage(page, dir, opts = {}) {
	const includeValues = opts.includeValues !== false;
	const data = await collectStorage(page, { includeValues, maxRecords: opts.maxRecords });
	const file = path.join(dir, 'storage.json');
	await writeJson(file, data);
	return { path: file, bytes: await fileSize(file), data };
}

export default { collectCookies, collectStorage, exportStorage };
