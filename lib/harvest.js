// dsh-omni-browser / lib/harvest.js
// Bounded site crawl where every page produces an evidence bundle.
import path from 'node:path'
import { ensureDir, makeOutputDir, writeJson, normalizeUrl, sleep, slug } from './util.js'
import { getLinks } from './snapshot.js'
import { captureBundle } from './capture.js'

const SKIP_EXT = /\.(?:pdf|zip|gz|7z|rar|png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|woff2?|ttf|otf|css|m?js|map)(?:[?#].*)?$/i

function acceptable(url, { origin, sameOriginOnly, regex }) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (sameOriginOnly && parsed.origin !== origin) return false
  if (SKIP_EXT.test(parsed.pathname)) return false
  if (regex && !regex.test(parsed.href)) return false
  return true
}

function normalizeKey(url) {
  try {
    const u = new URL(url)
    u.hash = ''
    return u.href
  } catch {
    return String(url)
  }
}

/**
 * Crawl from a seed (or an explicit URL list) and capture one bundle per page.
 * @param {import('./cdp.js').PageHandle} page
 */
export async function harvest(page, options = {}) {
  const {
    startUrl,
    urls = [],
    maxPages = 5,
    maxDepth = 1,
    sameOrigin = true,
    pattern,
    delayMs = 400,
    outDir,
    perPage = {},
    signal,
  } = options

  const seed = startUrl || page?.currentUrl?.() || ''
  let origin = ''
  try {
    origin = new URL(seed).origin
  } catch {
    origin = ''
  }
  const regex = pattern ? new RegExp(String(pattern)) : null

  const root = outDir || makeOutputDir({ name: `harvest-${slug(seed || 'site', 30)}` })
  await ensureDir(root)

  const queue = []
  const seen = new Set()
  const enqueue = (url, depth) => {
    if (!url) return
    const abs = normalizeUrl(url, seed || undefined)
    const key = normalizeKey(abs)
    if (seen.has(key)) return
    if (!acceptable(abs, { origin, sameOriginOnly: sameOrigin, regex })) return
    seen.add(key)
    queue.push({ url: abs, depth })
  }

  if (Array.isArray(urls) && urls.length) for (const u of urls) enqueue(u, 0)
  else if (seed) enqueue(seed, 0)

  const pages = []
  const startedAt = new Date().toISOString()
  let index = 0
  while (queue.length && pages.length < maxPages) {
    if (signal?.aborted) break
    const { url, depth } = queue.shift()
    index += 1
    const pageDir = path.join(root, `${String(index).padStart(2, '0')}-${slug(url, 48)}`)
    const entry = { index, url, depth, dir: pageDir, ok: false }
    try {
      await ensureDir(pageDir)
      await page.goto(url, { waitUntil: 'load', timeout: 30000, settle: 250 })

      if (depth < maxDepth) {
        try {
          const links = await getLinks(page, { maxItems: 250 })
          for (const link of links) enqueue(link.href, depth + 1)
        } catch {
          /* link discovery is best-effort */
        }
      }

      const bundle = await captureBundle(page, {
        dir: pageDir,
        name: url,
        options: {
          screenshot: perPage.screenshot !== false,
          pdf: Boolean(perPage.pdf),
          har: perPage.har !== false,
          console: perPage.console === true,
          storage: perPage.storage === true,
          ax: Boolean(perPage.ax),
          html: true,
          text: true,
          meta: true,
          links: true,
          forms: Boolean(perPage.forms),
          perf: false,
          resources: Boolean(perPage.resources),
          bodies: perPage.bodies || 'failures',
          maxChars: perPage.maxChars || 200000,
        },
      })
      entry.ok = true
      entry.files = (bundle.files || []).length
      entry.bytes = (bundle.files || []).reduce((sum, f) => sum + (f.bytes || 0), 0)
      entry.title = bundle.stats?.page?.title || ''
      entry.manifest = path.join(pageDir, 'manifest.json')
    } catch (err) {
      entry.error = err?.message || String(err)
    }
    pages.push(entry)
    if (delayMs) await sleep(delayMs)
  }

  const manifestPath = await writeJson(path.join(root, 'harvest.json'), {
    startedAt,
    finishedAt: new Date().toISOString(),
    seed,
    origin,
    options: { maxPages, maxDepth, sameOrigin, pattern: pattern || null, perPage },
    discovered: seen.size,
    captured: pages.filter((p) => p.ok).length,
    failed: pages.filter((p) => !p.ok).length,
    pages,
  })
  return { dir: root, manifestPath, pages, discovered: seen.size }
}
