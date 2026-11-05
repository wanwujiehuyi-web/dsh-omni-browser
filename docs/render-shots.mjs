// Renders docs/shot-*.html into docs/shot-*.png with the plugin's own CDP driver.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BrowserSession } from '../lib/cdp.js'

const HERE = import.meta.dirname
const session = new BrowserSession({
  port: 0,
  headless: true,
  userDataDir: path.join('D:/Temp', `omni-docs-${Date.now()}`),
})

try {
  await session.ensure()
  const page = await session.page()
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
  for (const name of ['shot-tools', 'shot-bundle']) {
    const file = path.join(HERE, `${name}.html`)
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const shot = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 1600, height: 1000, scale: 1 },
    })
    const out = path.join(HERE, `${name}.png`)
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
    console.log(`${out}  ${(fs.statSync(out).size / 1024).toFixed(1)} KiB`)
  }
} finally {
  await session.stop()
}
