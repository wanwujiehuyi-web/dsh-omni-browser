// test/media.test.mjs — real-Chrome test for lib/shots.js, lib/pdf.js, lib/perf.js, lib/downloads.js
// Run from the plugin dir:  node test/media.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './server.mjs';
import { BrowserSession } from '../lib/cdp.js';
import { screenshot, captureFullPage, startScreencast, record } from '../lib/shots.js';
import { printToPdf } from '../lib/pdf.js';
import { metrics, trace, coverage, resourceSummary } from '../lib/perf.js';
import { setDownloadDir, waitForDownload, listDownloads } from '../lib/downloads.js';

const stamp = Date.now();
const ROOT = `D:/Temp/omni-media-test-${stamp}`;
const PROFILE = `D:/Temp/omni-media-profile-${stamp}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
let failures = 0;

function check(name, cond, detail = '') {
  checks += 1;
  if (cond) {
    console.log(`[ok] ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures += 1;
    console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function fileBytes(file) {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function exists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

const srv = await startServer();
const session = new BrowserSession({
  port: 0,
  headless: true,
  windowSize: '1000,500',
  userDataDir: PROFILE,
  timeout: 20000,
});

console.log('[media] fixture:', srv.url, 'output:', ROOT);
try {
  const st = await session.ensure();
  console.log('[media] browser:', st.browser, '| profile:', PROFILE);
  const page = await session.page();
  await page.goto(srv.url + '/');
  const vpMeta = await page.evaluate('({w: innerWidth, h: innerHeight, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, dpr: devicePixelRatio})');
  console.log('[media] viewport:', JSON.stringify(vpMeta));

  /* ---------------- screenshots ---------------- */
  const shotsDir = path.join(ROOT, 'shots');
  const vp = await screenshot(page, { mode: 'viewport', dir: shotsDir, filename: 'viewport.png' });
  const vpBuf = fileBytes(vp.path);
  check('viewport png bytes > 1000', vp.bytes > 1000, `bytes=${vp.bytes} ${vp.width}x${vp.height} pixel=${vp.pixelWidth}x${vp.pixelHeight}`);
  check('viewport png magic', !!vpBuf && vpBuf.readUInt32BE(0) === 0x89504e47, `path=${vp.path}`);
  check('viewport format png', vp.format === 'png');
  check('viewport file exists', exists(vp.path));

  const jpg = await screenshot(page, { mode: 'viewport', format: 'jpeg', quality: 70, dir: shotsDir, filename: 'viewport.jpg' });
  const jpgBuf = fileBytes(jpg.path);
  check('viewport jpeg bytes > 1000', jpg.bytes > 1000, `bytes=${jpg.bytes} ${jpg.width}x${jpg.height} pixel=${jpg.pixelWidth}x${jpg.pixelHeight}`);
  check('viewport jpeg magic ffd8', !!jpgBuf && jpgBuf[0] === 0xff && jpgBuf[1] === 0xd8, `path=${jpg.path}`);

  const dft = await screenshot(page, { mode: 'viewport', dir: path.join(ROOT, 'shots-default') });
  check(
    'default filename shot-<timestamp>',
    /^shot-\d{8}-\d{6}-\d{3}\.png$/.test(path.basename(dft.path)),
    `filename=${path.basename(dft.path)}`,
  );

  const full = await captureFullPage(page, { dir: shotsDir, filename: 'fullpage.png' });
  const fullBuf = fileBytes(full.path);
  check(
    'fullpage height > viewport height',
    full.height > vp.height,
    `fullpage=${full.width}x${full.height} (pixel ${full.pixelWidth}x${full.pixelHeight}) vs viewport=${vp.width}x${vp.height}`,
  );
  check('fullpage png magic', !!fullBuf && fullBuf.readUInt32BE(0) === 0x89504e47, `bytes=${full.bytes} path=${full.path}`);
  check('fullpage matches document height', Math.abs(full.height - vpMeta.sh) <= 2, `layout=${vpMeta.sh} captured=${full.height}`);

  const el = await screenshot(page, { mode: 'element', selector: '#card-1', dir: shotsDir, filename: 'card.png' });
  const elBuf = fileBytes(el.path);
  check(
    'element #card-1 size sane',
    el.width > 100 && el.width < 1000 && el.height > 40 && el.height < 500,
    `${el.width}x${el.height} pixel=${el.pixelWidth}x${el.pixelHeight}`,
  );
  check('element png magic', !!elBuf && elBuf.readUInt32BE(0) === 0x89504e47, `bytes=${el.bytes} path=${el.path}`);

  const cl = await screenshot(page, { mode: 'clip', clip: { x: 20, y: 10, width: 300, height: 200 }, dir: shotsDir, filename: 'clip.png' });
  check('clip size 300x200', cl.width === 300 && cl.height === 200 && cl.pixelWidth === 300 && cl.pixelHeight === 200, `${cl.pixelWidth}x${cl.pixelHeight}`);

  /* ---------------- pdf ---------------- */
  const pdf = await printToPdf(page, { dir: path.join(ROOT, 'pdf'), filename: 'page.pdf' });
  const pdfBuf = fileBytes(pdf.path);
  const pdfHead = pdfBuf ? pdfBuf.subarray(0, 8).toString('latin1') : '';
  check('pdf starts with %PDF', pdfHead.startsWith('%PDF-'), `head=${JSON.stringify(pdfHead)} bytes=${pdf.bytes} pageCount=${pdf.pageCount}`);

  /* ---------------- screencast ---------------- */
  await page.evaluate(`(() => {
    window.__omniAnim = { i: 0, timer: setInterval(() => {
      const el = document.getElementById('main-title');
      if (el) el.style.color = 'hsl(' + ((window.__omniAnim.i += 7) % 360) + ',80%,40%)';
      document.body.style.background = 'hsl(' + ((window.__omniAnim.i * 3) % 360) + ',70%,92%)';
    }, 25) };
    return true;
  })()`);
  const screencastDir = path.join(ROOT, 'screencast');
  const rec = await record(page, { durationMs: 1500, dir: screencastDir, format: 'jpeg', quality: 60, maxWidth: 800 });
  await page.evaluate('clearInterval(window.__omniAnim.timer)');
  const frameFiles = fs.existsSync(path.join(screencastDir, 'frames')) ? fs.readdirSync(path.join(screencastDir, 'frames')) : [];
  const firstFrame = rec.frames[0] ? fileBytes(rec.frames[0].path) : null;
  check('record 1.5s frameCount >= 3', rec.frameCount >= 3, `frameCount=${rec.frameCount} files=${frameFiles.length} durationMs=${rec.durationMs}`);
  check('record frames are jpeg', !!firstFrame && firstFrame[0] === 0xff && firstFrame[1] === 0xd8, `first=${rec.frames[0] && rec.frames[0].bytes}B ${rec.frames[0] && rec.frames[0].timestamp}`);
  check('record manifest written', exists(rec.manifestPath), `manifest=${rec.manifestPath}`);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(rec.manifestPath, 'utf8'));
  } catch {
    /* handled by next check */
  }
  check(
    'screencast.json manifest consistent',
    !!manifest && manifest.frameCount === rec.frameCount && Array.isArray(manifest.frames) && manifest.frames.every((f) => exists(f.path)),
    `frames=${manifest && manifest.frames.length}`,
  );

  const sc = await startScreencast(page, { dir: path.join(ROOT, 'screencast2'), format: 'jpeg', quality: 50, maxWidth: 640 });
  await page.evaluate(`document.getElementById('main-title').style.background = 'red'`);
  await sleep(700);
  const scRes = await sc.stop();
  const scRes2 = await sc.stop();
  check('startScreencast().stop() returns manifest', scRes.frameCount >= 1 && exists(scRes.manifestPath), `frames=${scRes.frameCount} duration=${scRes.durationMs}ms`);
  check('stop() is idempotent', scRes2.manifestPath === scRes.manifestPath && scRes2.frameCount === scRes.frameCount);

  /* ---------------- perf ---------------- */
  const met = await metrics(page);
  check('metrics has JSHeapUsedSize', Number(met.metrics.JSHeapUsedSize) > 0, `JSHeapUsedSize=${met.metrics.JSHeapUsedSize} nodes=${met.metrics.Nodes} docs=${met.metrics.Documents} names=${met.names.length}`);
  check('metrics names include ScriptDuration', Number.isFinite(met.metrics.ScriptDuration), `ScriptDuration=${met.metrics.ScriptDuration}`);

  await page.evaluate(`window.__traceTimer = setInterval(() => { document.body.dataset.tick = String(Date.now()); }, 10)`);
  const tr = await trace(page, { durationMs: 1200, dir: path.join(ROOT, 'perf'), filename: 'trace.json' });
  await page.evaluate('clearInterval(window.__traceTimer)');
  let traceFile = null;
  try {
    traceFile = JSON.parse(fs.readFileSync(tr.path, 'utf8'));
  } catch {
    /* handled by next check */
  }
  check('trace collected events', tr.events > 0 && !!traceFile && traceFile.traceEvents.length === tr.events, `events=${tr.events} bytes=${tr.bytes} durationMs=${tr.durationMs}`);
  check('trace file is valid json', !!traceFile && Array.isArray(traceFile.traceEvents) && !!traceFile.metadata, `path=${tr.path}`);

  // Start coverage, then reload while it is recording so real script executions are captured.
  const covPromise = coverage(page, { durationMs: 1200 });
  await sleep(250);
  await page.reload();
  const cov = await covPromise;
  check(
    'coverage js array non-empty (with reload)',
    Array.isArray(cov.js) && cov.js.length > 0,
    `scripts=${cov.js.length} css=${cov.css.length} jsSupported=${cov.jsSupported} cssSupported=${cov.cssSupported} unsupported=${JSON.stringify(cov.unsupported)}`,
  );
  check('coverage js entry has url + ranges', !cov.js[0] || (typeof cov.js[0].url === 'string' && Array.isArray(cov.js[0].functions)), `first=${cov.js[0] && cov.js[0].url}`);
  check('coverage css is array', Array.isArray(cov.css), `rules=${cov.css.length} used=${cov.cssUsed || 0}`);
  check('coverage duration honored', cov.durationMs === 1200, `durationMs=${cov.durationMs}`);

  const res = await resourceSummary(page);
  const resTypes = Object.keys(res.byType || {});
  check('resourceSummary count > 3', res.count > 3, `count=${res.count} totalBytes=${res.totalBytes} types=${JSON.stringify(res.byType)}`);
  check('resourceSummary has img.png', res.entries.some((e) => e.url.endsWith('/img.png')), `entries=${res.entries.length}`);
  check('resourceSummary byType has Document', resTypes.includes('Document'), `types=${resTypes.join(',')}`);

  /* ---------------- downloads ---------------- */
  const dlDir = path.join(ROOT, 'downloads');
  const sd = await setDownloadDir(page, dlDir);
  check('setDownloadDir ok', sd.dir === path.resolve(dlDir) && sd.eventsEnabled === true, `dir=${sd.dir} eventsEnabled=${sd.eventsEnabled}`);
  await page.goto(srv.url + '/download');
  await page.evaluate(`document.getElementById('dl').click()`);
  const dl = await waitForDownload(page, { timeout: 20000 });
  const dlBuf = fileBytes(dl.path);
  check('download completed', dl.state === 'completed', `guid=${dl.guid} file=${dl.suggestedFilename} state=${dl.state} bytes=${dl.bytes}`);
  check('download file on disk', !!dlBuf && exists(dl.path), `path=${dl.path}`);
  check(
    'download content correct',
    !!dlBuf && dlBuf.toString('utf8').includes('omni download fixture') && dl.bytes === dlBuf.length,
    `bytes=${dl.bytes} content=${JSON.stringify(dlBuf ? dlBuf.toString('utf8') : '')}`,
  );
  const list = await listDownloads(page);
  check('listDownloads includes completed download', list.length >= 1 && list.some((d) => d.guid === dl.guid && d.state === 'completed' && d.path === dl.path), `count=${list.length}`);
  check('download path inside requested dir', dl.path && path.resolve(dl.path).startsWith(path.resolve(dlDir)), `path=${dl.path}`);
} catch (err) {
  failures += 1;
  console.error('[media] FATAL:', err && err.stack ? err.stack : err);
} finally {
  try {
    await session.stop();
  } catch (err) {
    console.error('[media] session.stop error:', err.message);
  }
  try {
    await srv.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* chrome may still hold profile files */
  }
  console.log(`[media] checks=${checks} failures=${failures} output=${ROOT}`);
  if (fs.existsSync(ROOT)) {
    const walk = (dir, depth = 0) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (depth < 1) walk(full, depth + 1);
        } else {
          console.log(`[media]   ${path.relative(ROOT, full)}  ${fs.statSync(full).size}B`);
        }
      }
    };
    walk(ROOT);
  }
  console.log(failures === 0 ? '[media] ALL OK' : '[media] FAILED');
  process.exit(failures === 0 ? 0 : 1);
}
