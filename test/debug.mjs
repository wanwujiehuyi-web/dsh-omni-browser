// Temporary repro for pageModel + selectOption failures.
import { BrowserSession } from '../lib/cdp.js'
import { startServer } from './server.mjs'
import { pageModel, getLinks } from '../lib/snapshot.js'
import { selectOption, setChecked } from '../lib/actions.js'

const server = await startServer({ port: 0 })
const session = new BrowserSession({ port: 0, headless: true, userDataDir: `D:/Temp/omni-debug-${Date.now()}` })
try {
  await session.ensure()
  const page = await session.page()
  await page.goto(server.url + '/', { waitUntil: 'load' })
  for (const [label, fn] of [
    ['getLinks', () => getLinks(page)],
    ['pageModel', () => pageModel(page)],
    ['selectOption', () => selectOption(page, { selector: '#role' }, 'pm')],
    ['setChecked', () => setChecked(page, { selector: '#agree' }, true)],
  ]) {
    try {
      const value = await fn()
      console.log(`[ok] ${label}`, JSON.stringify(value).slice(0, 260))
    } catch (err) {
      console.log(`[fail] ${label}:`, err.message)
    }
  }
} finally {
  await session.stop()
  await server.close()
}
