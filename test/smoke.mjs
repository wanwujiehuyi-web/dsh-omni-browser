// Smoke test for lib/cdp.js — run from the plugin dir:
//   node test/smoke.mjs
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { BrowserSession } from '../lib/cdp.js';

const profile = path.join('D:/Temp', `omni-smoke-${Date.now()}`);
const session = new BrowserSession({
  port: 0,
  headless: true,
  userDataDir: profile,
  timeout: 20000,
});

const log = (...a) => console.log('[smoke]', ...a);
let ok = true;
try {
  const st = await session.ensure();
  log('browser:', st.browser, 'port:', st.endpoint, 'pid:', st.chromePid, 'launched:', st.launchedByPlugin);
  log('pages after ensure:', JSON.stringify(st.pages));

  const page = await session.page();
  log('active page:', page.targetId, page.sessionId);

  const nav = await page.goto('https://example.com', { timeout: 25000, waitUntil: 'load' });
  log('navigated:', nav.url);
  log('title:', await page.title());
  log('1+1 =', await page.evaluate('1+1'));
  log('h1:', await page.evaluate('document.querySelector("h1")?.textContent'));
  log('frames:', JSON.stringify(await page.frames()));
  log('url():', await page.url());

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  const shotPath = path.join('D:/Temp', `omni-smoke-${Date.now()}.png`);
  fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  log('screenshot bytes:', shot.data.length, '->', shotPath);

  const metrics = await page.layoutMetrics();
  log('contentSize:', JSON.stringify(metrics.cssContentSize || metrics.contentSize));

  // network capture sanity: enable + listen, then navigate again
  const seen = [];
  const off = page.on('Network.responseReceived', (e) => seen.push(e.params.response.url));
  await page.goto('https://example.com/?x=1', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1200));
  off();
  log('network responses seen:', seen.length, seen.slice(0, 3));

  // second tab
  const page2 = await session.newPage('https://example.com/?tab=2');
  await new Promise((r) => setTimeout(r, 1500));
  log('tab2 title:', await page2.title());
  log('pages now:', JSON.stringify(await session.listPages()));
  await session.closePage(page2.targetId);

  log('status ok');
} catch (err) {
  ok = false;
  console.error('[smoke] FAILED:', err && err.stack ? err.stack : err);
} finally {
  try {
    await session.stop();
  } catch (e) {
    console.error('[smoke] stop error:', e.message);
  }
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* chrome may still hold files */
  }
  log(ok ? 'ALL OK' : 'FAILED');
  process.exit(ok ? 0 : 1);
}
