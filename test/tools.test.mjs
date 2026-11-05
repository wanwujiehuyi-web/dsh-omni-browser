// Integration test for the registered omni_* tools, without the DSH host.
// Registers the plugin against a fake ctx, then calls tools directly.
//   node test/tools.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startServer } from './server.mjs'
import * as plugin from '../index.js'

const OUT = path.join('D:/Temp', `omni-tools-${Date.now()}`)
const profile = path.join('D:/Temp', `omni-tools-profile-${Date.now()}`)
const registered = new Map()

const ctx = {
  tools: {
    register: (spec) => {
      registered.set(spec.name, spec)
      return () => registered.delete(spec.name)
    },
  },
  effect: () => {},
  on: () => {},
}

plugin.apply(ctx, { headless: true, port: 0, userDataDir: profile, outputDir: OUT })

const results = []
function step(name, fn) {
  return async () => {
    const started = Date.now()
    try {
      const value = await fn()
      results.push({ name, ok: true, ms: Date.now() - started })
      console.log(`[ok] ${name} (${Date.now() - started}ms)`)
      return value
    } catch (err) {
      results.push({ name, ok: false, ms: Date.now() - started, error: err.message })
      console.log(`[FAIL] ${name}: ${err.message}`)
      return null
    }
  }
}

const call = async (name, args = {}) => {
  const spec = registered.get(name)
  if (!spec) throw new Error(`tool ${name} is not registered`)
  const value = await spec.execute(args, { cwd: process.cwd() })
  if (value && value.ok === false) throw new Error(`${name} returned ok:false — ${value.error}`)
  return value
}

const srv = await startServer()
assert.equal(registered.size, 16, `expected 16 tools, got ${registered.size}: ${[...registered.keys()].join(', ')}`)
console.log('[tools]', [...registered.keys()].join(', '))

let bundle = null
try {
  await step('omni_status launch', async () => {
    const r = await call('omni_status', { action: 'launch' })
    assert.equal(r.running, true)
  })()

  await step('omni_open', async () => {
    const r = await call('omni_open', { url: srv.url + '/', waitUntil: 'load', settle: 800 })
    assert.equal(r.ok, true)
    assert.match(r.title, /Omni Fixture Home/)
  })()

  await step('omni_page snapshot', async () => {
    const r = await call('omni_page', { mode: 'snapshot', maxChars: 4000 })
    assert.equal(r.ok, true)
    assert.ok(r.title, 'title missing')
    assert.ok((r.links || []).length >= 3, `links: ${(r.links || []).length}`)
    assert.ok((r.forms || []).length >= 1, 'forms missing')
    assert.ok((r.text || '').includes('Card one'), 'text missing body')
  })()

  await step('omni_page ax', async () => {
    const r = await call('omni_page', { mode: 'ax', maxItems: 400 })
    assert.ok((r.nodes || []).length > 10, `ax nodes: ${(r.nodes || []).length}`)
  })()

  await step('omni_act click', async () => {
    await call('omni_act', { action: 'click', selector: '#plain-btn' })
    const txt = await call('omni_eval', { expression: "document.getElementById('clicked').textContent" })
    assert.equal(txt.result, 'clicked!')
  })()

  await step('omni_act type', async () => {
    await call('omni_act', { action: 'type', selector: '#email', text: 'hello@omni.dev' })
    const v = await call('omni_eval', { expression: "document.getElementById('email').value" })
    assert.equal(v.result, 'hello@omni.dev')
  })()

  await step('omni_act select/check', async () => {
    await call('omni_act', { action: 'select', selector: '#role', value: 'pm' })
    await call('omni_act', { action: 'check', selector: '#agree' })
    const v = await call('omni_eval', { expression: "document.getElementById('role').value + '/' + document.getElementById('agree').checked" })
    assert.equal(v.result, 'pm/true')
  })()

  await step('omni_screenshot fullpage', async () => {
    const r = await call('omni_screenshot', { mode: 'fullpage', dir: path.join(OUT, 'shots') })
    assert.ok(fs.existsSync(r.file), 'screenshot file missing')
    assert.ok(r.bytes > 1000)
  })()

  await step('omni_network list', async () => {
    const r = await call('omni_network', { mode: 'list', limit: 100 })
    assert.ok(r.count >= 2, `network entries: ${r.count}`)
  })()

  await step('omni_network har', async () => {
    const r = await call('omni_network', { mode: 'har', dir: path.join(OUT, 'net') })
    assert.ok(fs.existsSync(r.file), 'har file missing')
    const har = JSON.parse(fs.readFileSync(r.file, 'utf8'))
    assert.ok(har.log.entries.length >= 2)
  })()

  await step('omni_console', async () => {
    const r = await call('omni_console', { mode: 'list' })
    const text = (r.entries || []).map((e) => e.text).join('\n')
    assert.ok(text.includes('fixture ready'), `console text: ${text.slice(0, 200)}`)
  })()

  await step('omni_storage all', async () => {
    const r = await call('omni_storage', { mode: 'all' })
    const local = JSON.stringify(r.origins || [])
    assert.ok(local.includes('omni-test'), `localStorage not captured: ${local.slice(0, 200)}`)
  })()

  await step('omni_pdf', async () => {
    const r = await call('omni_pdf', { dir: path.join(OUT, 'pdf') })
    const head = fs.readFileSync(r.file).subarray(0, 4).toString()
    assert.equal(head, '%PDF')
  })()

  await step('omni_perf metrics', async () => {
    const r = await call('omni_perf', { mode: 'metrics' })
    assert.ok(r.metrics, 'metrics missing')
  })()

  await step('omni_record', async () => {
    const r = await call('omni_record', { seconds: 1.5, dir: path.join(OUT, 'rec') })
    assert.ok(r.frameCount >= 1, `frames: ${r.frameCount}`)
  })()

  await step('omni_capture bundle', async () => {
    bundle = await call('omni_capture', { name: 'fixture-home', dir: path.join(OUT, 'bundle') })
    assert.ok(fs.existsSync(bundle.manifestPath), 'manifest missing')
    const names = fs.readdirSync(bundle.dir)
    for (const want of ['manifest.json', 'page.json', 'page.png', 'page-full.png', 'network.har.json', 'console.json', 'storage.json', 'ax.json', 'dom.html', 'text.txt', 'perf.json']) {
      assert.ok(names.includes(want), `bundle missing ${want}: ${names.join(', ')}`)
    }
    console.log('[bundle]', bundle.fileCount, 'files,', bundle.totalBytesText, '->', bundle.dir)
  })()

  await step('omni_harvest', async () => {
    const r = await call('omni_harvest', { startUrl: srv.url + '/', maxPages: 2, maxDepth: 1, dir: path.join(OUT, 'harvest'), delayMs: 100 })
    assert.ok(r.captured >= 2, `captured: ${r.captured}`)
  })()

  await step('omni_tabs list', async () => {
    const r = await call('omni_tabs', { action: 'list' })
    assert.ok(r.tabs.length >= 1)
  })()

  await step('omni_status close', async () => {
    const r = await call('omni_status', { action: 'close' })
    assert.equal(r.closed, true)
  })()
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log('\n==== summary ====')
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.ms}ms${r.error ? `  — ${r.error}` : ''}`)
  console.log(`${results.length - failed.length}/${results.length} passed`)
  console.log('artifacts:', OUT)
  await srv.close()
  setTimeout(() => process.exit(failed.length ? 1 : 0), 500)
}
