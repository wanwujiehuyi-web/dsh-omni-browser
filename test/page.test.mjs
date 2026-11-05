// test/page.test.mjs — real-Chrome tests for lib/snapshot.js + lib/actions.js.
// Run: node test/page.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './server.mjs';
import { BrowserSession } from '../lib/cdp.js';
import {
  pageModel,
  getText,
  getHtml,
  getAxTree,
  getLinks,
  getForms,
  getMeta,
  getOutline,
  getResources,
  axRef,
  parseRef,
} from '../lib/snapshot.js';
import {
  resolveTarget,
  click,
  type,
  press,
  scroll,
  hover,
  focus,
  selectOption,
  setChecked,
  uploadFiles,
  drag,
  waitFor,
} from '../lib/actions.js';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function includes(name, haystack, needle) {
  const ok = String(haystack ?? '').includes(needle);
  check(name, ok, ok ? '' : `${JSON.stringify(String(haystack ?? '').slice(0, 200))} does not include ${JSON.stringify(needle)}`);
}

async function expectThrow(name, fn, contains) {
  try {
    await fn();
    check(name, false, 'expected an error, but it resolved');
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const ok = !contains || msg.includes(contains);
    check(name, ok, ok ? '' : `error ${JSON.stringify(msg)} lacks ${JSON.stringify(contains)}`);
  }
}

const stamp = `${Date.now()}-${process.pid}`;
const profileDir = `D:/Temp/omni-page-profile-${stamp}`;
const uploadPath = path.resolve(`D:/Temp/omni-page-upload-${stamp}.txt`);

const srv = await startServer();
const session = new BrowserSession({ port: 0, headless: true, userDataDir: profileDir, timeout: 30000 });
let exitCode = 0;
try {
  fs.mkdirSync('D:/Temp', { recursive: true });
  fs.writeFileSync(uploadPath, 'upload fixture\n');

  await session.ensure();
  const page = await session.page();
  await page.goto(srv.url + '/');
  await page.waitNetworkIdle(400, 5000);

  /* ---------------- snapshot ---------------- */

  const model = await pageModel(page);
  eq('pageModel.url', model.url, srv.url + '/');
  eq('pageModel.title', model.title, 'Omni Fixture Home');
  includes('pageModel.text has h1', model.text, 'Omni Browser Fixture');
  includes('pageModel.text has card', model.text, 'hello world');
  check('pageModel.outline starts with h1', model.outline[0] && model.outline[0].level === 1 && model.outline[0].text === 'Omni Browser Fixture', JSON.stringify(model.outline[0]));
  check('pageModel.outline contains h2', model.outline.some((h) => h.level === 2 && h.text === 'Card one'));
  eq('pageModel.meta.lang', model.meta.lang, 'zh-CN');
  eq('pageModel.meta.og.title', model.meta.og.title, 'Omni Fixture');
  eq('pageModel.meta.canonical', model.meta.canonical, 'http://127.0.0.1/canonical-home');
  check('pageModel.meta.jsonLd parsed', Array.isArray(model.meta.jsonLd) && model.meta.jsonLd[0] && model.meta.jsonLd[0]['@type'] === 'WebPage', JSON.stringify(model.meta.jsonLd));
  includes('pageModel.meta.description', model.meta.description, 'Local fixture page');
  check('pageModel.meta.favicon absolute', String(model.meta.favicon).endsWith('/favicon.ico'), model.meta.favicon);
  check('pageModel.links has absolute Page 2', model.links.some((l) => l.text === 'Page 2' && l.href === srv.url + '/page2'), JSON.stringify(model.links.slice(0, 4)));
  check('pageModel.links has external rel', model.links.some((l) => l.href === 'https://example.com/' && l.rel === 'external'));
  check('pageModel.forms one form', model.forms.length === 1, JSON.stringify(model.forms.map((f) => f.action)));
  const form = model.forms[0];
  eq('form action absolute', form.action, srv.url + '/submit');
  eq('form method', form.method, 'post');
  const emailField = form.fields.find((f) => f.name === 'email');
  check('email field shape', !!emailField, JSON.stringify(form.fields));
  eq('email type', emailField.type, 'email');
  eq('email required', emailField.required, true);
  eq('email placeholder', emailField.placeholder, 'you@example.com');
  eq('email label', emailField.label, 'Email');
  const roleField = form.fields.find((f) => f.name === 'role');
  check('select has options', roleField && roleField.type === 'select-one' && roleField.options.length === 2, JSON.stringify(roleField));
  check('pageModel.tables captured', model.tables.length === 1 && model.tables[0].headers.join(',') === 'Name,Value' && model.tables[0].rows.length === 2, JSON.stringify(model.tables));
  check('pageModel.images captured', model.images.some((i) => i.alt === 'pixel' && i.src === srv.url + '/img.png'));
  check('pageModel.counts consistent', model.counts.links === model.links.length && model.counts.forms === 1, JSON.stringify(model.counts));
  check('pageModel.capturedAt', typeof model.capturedAt === 'string' && !Number.isNaN(Date.parse(model.capturedAt)));

  const textOnly = await pageModel(page, { mode: 'text', maxChars: 500 });
  check('pageModel text mode omits meta/links', textOnly.meta === undefined && textOnly.links === undefined && textOnly.forms === undefined);
  check('pageModel text mode truncates', textOnly.text.length <= 500 && textOnly.text.includes('Omni Browser Fixture'));

  const scopedText = await getText(page, { selector: '#card-1' });
  includes('getText scoped card', scopedText, 'hello world');
  includes('getText scoped card h2', scopedText, 'Card one');
  const pageText = await getText(page);
  includes('getText page', pageText, 'Omni Browser Fixture');
  const hiddenText = await getText(page, { includeHidden: true, selector: '#card-1' });
  includes('getText includeHidden', hiddenText, 'Card one');

  const scopedHtml = await getHtml(page, { selector: '#card-1' });
  includes('getHtml scoped outer', scopedHtml, 'id="card-1"');
  includes('getHtml scoped outer content', scopedHtml, 'Card one');
  const innerHtml = await getHtml(page, { selector: '#card-1', outer: false });
  check('getHtml inner excludes wrapper', !String(innerHtml).includes('id="card-1"') && String(innerHtml).includes('Card one'), innerHtml.slice(0, 120));
  includes('getHtml document', await getHtml(page), '<html');
  await expectThrow('getHtml missing selector readable', () => getHtml(page, { selector: '#no-such-thing' }), 'getHtml 失败');

  const links = await getLinks(page);
  check('getLinks returns array', Array.isArray(links) && links.length >= 3, String(links && links.length));
  check('getLinks absolute', links.every((l) => /^https?:\/\//.test(l.href)));
  check('getLinks rel preserved', links.some((l) => l.rel === 'external'));

  const forms = await getForms(page);
  check('getForms returns form fields', forms.length === 1 && forms[0].fields.length >= 7, JSON.stringify(forms[0] && forms[0].fields.length));

  const meta = await getMeta(page);
  eq('getMeta title', meta.title, 'Omni Fixture Home');
  check('getMeta og object', meta.og && meta.og.title === 'Omni Fixture');
  check('getMeta twitter object', typeof meta.twitter === 'object' && meta.twitter !== null);

  const outline = await getOutline(page);
  check('getOutline levels ascending in document order', outline.length >= 2 && outline[0].level === 1 && outline[1].level === 2, JSON.stringify(outline));

  const resources = await getResources(page);
  check('getResources non-empty', Array.isArray(resources) && resources.length > 0, String(resources && resources.length));
  check('getResources has this page', resources.some((r) => r.url === srv.url + '/'), JSON.stringify(resources.map((r) => r.url)));
  check('getResources has mime + size fields', resources.every((r) => typeof r.mimeType === 'string' && typeof r.size === 'number' && typeof r.type === 'string'));

  const ax = await getAxTree(page);
  check('getAxTree node count', ax.nodes.length > 10 && ax.total >= ax.nodes.length, `nodes=${ax.nodes.length} total=${ax.total}`);
  const headingNode = ax.nodes.find((n) => n.role === 'heading' && n.name === 'Omni Browser Fixture');
  check('getAxTree finds h1 heading', !!headingNode, JSON.stringify(ax.nodes.filter((n) => n.role === 'heading').slice(0, 3)));
  check('getAxTree heading has ax ref', headingNode && /^ax:\d+$/.test(headingNode.ref), headingNode && headingNode.ref);
  check('getAxTree backendDOMNodeId number', headingNode && Number.isInteger(headingNode.backendDOMNodeId));
  check('getAxTree childIds wiring', ax.nodes.some((n) => n.childIds.length > 0));
  eq('axRef convention', axRef(12345), 'ax:12345');
  eq('parseRef roundtrip', parseRef(axRef(987)), 987);
  eq('parseRef invalid', parseRef('not-a-ref'), null);
  check('axRef invalid throws', (() => { try { axRef(-1); return false; } catch { return true; } })());
  const axSmall = await getAxTree(page, { maxNodes: 5 });
  check('getAxTree maxNodes truncates', axSmall.nodes.length === 5 && axSmall.truncated === true, JSON.stringify({ n: axSmall.nodes.length, truncated: axSmall.truncated }));

  /* ---------------- iframe access ---------------- */
  const frames = await page.frames();
  const frameInfo = frames.find((f) => String(f.url).includes('/frame'));
  check('page.frames finds iframe', !!frameInfo, JSON.stringify(frames.map((f) => f.url)));
  if (frameInfo) {
    const frameModel = await pageModel(page, { frameId: frameInfo.id });
    includes('pageModel(frameId) frame text', frameModel.text, 'frame content');
    includes('pageModel(frameId) frame heading', frameModel.text, 'Inside the iframe');
    eq('pageModel(frameId) keeps top url', frameModel.url, srv.url + '/');
    const frameText = await getText(page, { frameId: frameInfo.id, selector: '#frame-text' });
    includes('getText(frameId) selector', frameText, 'frame content');
    const frameOutline = await getOutline(page, { frameId: frameInfo.id });
    check('getOutline(frameId) h3', frameOutline.some((h) => h.level === 3 && h.text === 'Inside the iframe'), JSON.stringify(frameOutline));
  }

  /* ---------------- target resolution ---------------- */
  const resolved = await resolveTarget(page, '#plain-btn');
  check('resolveTarget ok', resolved.ok === true && resolved.kind === 'selector', JSON.stringify(resolved));
  check('resolveTarget visible+rect', resolved.visible === true && resolved.rect.width > 0 && resolved.rect.height > 0, JSON.stringify(resolved.rect));
  includes('resolveTarget description', resolved.description, 'button#plain-btn');
  const byText = await resolveTarget(page, { text: 'Click me' });
  check('resolveTarget by text', byText.ok === true && byText.kind === 'text', JSON.stringify(byText));
  const missing = await resolveTarget(page, '#definitely-not-here', { timeout: 300 });
  check('resolveTarget missing returns ok:false', missing.ok === false && /未找到选择器/.test(String(missing.error)), JSON.stringify(missing));
  eq('resolveTarget missing attempts > 1', missing.attempts > 1, true);
  await expectThrow('click missing readable', () => click(page, '#definitely-not-here', { timeout: 300 }), 'click失败');
  await expectThrow('resolve invalid readable', () => click(page, { nonsense: 1 }, { timeout: 100 }), '无效的目标');

  /* ---------------- click: real trusted input ---------------- */
  await page.evaluate(`(() => {
    window.__clickTrusted = [];
    const btn = document.getElementById('plain-btn');
    btn.addEventListener('click', (e) => window.__clickTrusted.push(e.isTrusted));
    document.getElementById('clicked').textContent = 'not clicked';
    return true;
  })()`);
  const clicked = await click(page, '#plain-btn');
  eq('click reports ok', clicked.ok, true);
  eq('click changes DOM', await page.evaluate(`document.getElementById('clicked').textContent`), 'clicked!');
  const trustedClicks = await page.evaluate('window.__clickTrusted');
  check('click uses trusted input events', Array.isArray(trustedClicks) && trustedClicks.length === 1 && trustedClicks[0] === true, JSON.stringify(trustedClicks));

  // click via AX ref
  await page.evaluate(`document.getElementById('clicked').textContent = 'not clicked'`);
  await page.enableDomains({ dom: true });
  const { root: domRoot } = await page.send('DOM.getDocument', { depth: -1 });
  const { nodeId: btnNodeId } = await page.send('DOM.querySelector', { nodeId: domRoot.nodeId, selector: '#plain-btn' });
  const { node: btnNode } = await page.send('DOM.describeNode', { nodeId: btnNodeId });
  const ref = axRef(btnNode.backendNodeId);
  const byRef = await resolveTarget(page, { ref });
  check('resolveTarget by ref', byRef.ok === true && byRef.backendNodeId === btnNode.backendNodeId, JSON.stringify(byRef));
  await click(page, { ref });
  eq('click by ax ref works', await page.evaluate(`document.getElementById('clicked').textContent`), 'clicked!');

  // click at an explicit point (element center)
  await page.evaluate(`document.getElementById('clicked').textContent = 'not clicked'`);
  const rect = await page.evaluate(`(() => { const r = document.getElementById('plain-btn').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await click(page, rect);
  eq('click by point works', await page.evaluate(`document.getElementById('clicked').textContent`), 'clicked!');
  check('click trusted count grew', (await page.evaluate('window.__clickTrusted.length')) === 3, String(await page.evaluate('window.__clickTrusted.length')));

  // double click
  await page.evaluate(`(() => { window.__dbl = 0; document.getElementById('plain-btn').addEventListener('dblclick', () => window.__dbl++); return true; })()`);
  await click(page, '#plain-btn', { clickCount: 2 });
  eq('click clickCount:2 fires dblclick', await page.evaluate('window.__dbl'), 1);

  /* ---------------- type ---------------- */
  await page.evaluate(`(() => { window.__inputTrusted = []; const el = document.getElementById('email'); el.addEventListener('input', (e) => window.__inputTrusted.push(e.isTrusted)); return true; })()`);
  const typed = await type(page, '#email', 'a@b.c');
  eq('type email value', await page.evaluate(`document.getElementById('email').value`), 'a@b.c');
  eq('type reports value', typed.value, 'a@b.c');
  await type(page, '#email', 'z@y.x');
  eq('type replaces by default (clear)', await page.evaluate(`document.getElementById('email').value`), 'z@y.x');
  await type(page, '#email', 'q@w.e', { clear: false });
  eq('type clear:false appends', await page.evaluate(`document.getElementById('email').value`), 'z@y.xq@w.e');
  await type(page, '#notes', 'multi', { delayMs: 25 });
  eq('type with delayMs', await page.evaluate(`document.getElementById('notes').value`), 'multi');
  const inputTrusted = await page.evaluate('window.__inputTrusted');
  check('type uses trusted input events', inputTrusted.length >= 3 && inputTrusted.every(Boolean), JSON.stringify(inputTrusted));
  await type(page, '#notes', 'line1\nline2');
  eq('type newline via Enter', await page.evaluate(`document.getElementById('notes').value`), 'line1\nline2');
  await page.evaluate(`document.getElementById('email').value = ''`);
  await type(page, '#email', 'ref@test.io', { submit: false });
  eq('type after external clear', await page.evaluate(`document.getElementById('email').value`), 'ref@test.io');

  /* ---------------- press ---------------- */
  await page.evaluate(`document.getElementById('notes').focus()`);
  await press(page, 'End');
  await press(page, 'Backspace');
  eq('press Backspace deletes char', await page.evaluate(`document.getElementById('notes').value`), 'line1\nline2'.slice(0, -1));
  await press(page, 'Enter');
  eq('press Enter inserts newline', await page.evaluate(`document.getElementById('notes').value`), 'line1\nline2'.slice(0, -1) + '\n');
  await expectThrow('press unknown key readable', () => press(page, 'NotAKey'), 'press失败');

  /* ---------------- focus / hover ---------------- */
  const focused = await focus(page, '#email');
  eq('focus reports focused', focused.focused, true);
  eq('focus actual activeElement', await page.evaluate(`document.activeElement.id`), 'email');
  await page.evaluate(`document.activeElement.blur()`);
  const hovered = await hover(page, '#card-1');
  eq('hover ok', hovered.ok, true);
  check('hover coordinates within viewport', hovered.x > 0 && hovered.y > 0, JSON.stringify(hovered));

  /* ---------------- selectOption ---------------- */
  const selByLabel = await selectOption(page, '#role', 'Product');
  eq('selectOption by label value', selByLabel.value, 'pm');
  eq('selectOption by label label', selByLabel.label, 'Product');
  eq('selectOption DOM value', await page.evaluate(`document.getElementById('role').value`), 'pm');
  const selByValue = await selectOption(page, '#role', 'dev');
  eq('selectOption by value', selByValue.value, 'dev');
  await expectThrow('selectOption unknown readable', () => selectOption(page, '#role', 'nope'), 'selectOption失败');

  /* ---------------- setChecked ---------------- */
  const checked1 = await setChecked(page, '#agree', true);
  eq('setChecked true', await page.evaluate(`document.getElementById('agree').checked`), true);
  eq('setChecked reports changed', checked1.changed, true);
  const checked2 = await setChecked(page, '#agree', true);
  eq('setChecked idempotent', checked2.changed, false);
  await setChecked(page, '#agree', false);
  eq('setChecked false', await page.evaluate(`document.getElementById('agree').checked`), false);
  await focus(page, '#agree');
  await press(page, 'Space');
  eq('press Space toggles checkbox', await page.evaluate(`document.getElementById('agree').checked`), true);
  await expectThrow('setChecked non-checkbox readable', () => setChecked(page, '#email', true), 'setChecked失败');

  /* ---------------- uploadFiles ---------------- */
  await page.evaluate(`(() => { const i = document.createElement('input'); i.type = 'file'; i.id = 'up'; i.style.position = 'fixed'; i.style.left = '10px'; i.style.top = '10px'; i.style.zIndex = '9999'; document.body.appendChild(i); return true; })()`);
  const uploaded = await uploadFiles(page, '#up', [uploadPath]);
  eq('uploadFiles ok', uploaded.ok, true);
  eq('uploadFiles count', uploaded.count, 1);
  eq('uploadFiles name', await page.evaluate(`document.getElementById('up').files[0].name`), path.basename(uploadPath));
  await expectThrow('uploadFiles missing path readable', () => uploadFiles(page, '#up', ['D:/Temp/definitely-missing-omni-file.txt']), '文件不存在');
  await expectThrow('uploadFiles non-file target readable', () => uploadFiles(page, '#email', [uploadPath]), 'uploadFiles失败');

  /* ---------------- drag ---------------- */
  await page.evaluate(`(() => {
    for (const id of ['drag-a', 'drag-b']) { const old = document.getElementById(id); if (old) old.remove(); }
    const a = document.createElement('div');
    a.id = 'drag-a';
    a.style.cssText = 'position:fixed;left:20px;top:320px;width:80px;height:40px;background:#1a73e8;z-index:9999';
    const b = document.createElement('div');
    b.id = 'drag-b';
    b.style.cssText = 'position:fixed;left:320px;top:320px;width:80px;height:40px;background:#fbbc04;z-index:9999';
    document.body.appendChild(a); document.body.appendChild(b);
    window.__drag = { down: 0, move: 0, up: 0, trusted: [] };
    a.addEventListener('mousedown', (e) => { window.__drag.down++; window.__drag.trusted.push(e.isTrusted); });
    document.addEventListener('mousemove', (e) => { if (e.buttons === 1) window.__drag.move++; });
    document.addEventListener('mouseup', (e) => { window.__drag.up++; window.__drag.trusted.push(e.isTrusted); });
    return true;
  })()`);
  const dragged = await drag(page, '#drag-a', '#drag-b');
  eq('drag ok', dragged.ok, true);
  check('drag steps', dragged.steps >= 2, JSON.stringify(dragged));
  const dragState = await page.evaluate('window.__drag');
  check('drag dispatches real mousedown/mousemove/mouseup', dragState.down >= 1 && dragState.move >= 2 && dragState.up >= 1, JSON.stringify(dragState));
  check('drag events trusted', dragState.trusted.length >= 2 && dragState.trusted.every(Boolean), JSON.stringify(dragState.trusted));

  /* ---------------- scroll ---------------- */
  await page.goto(srv.url + '/page3');
  // page3 is short at this viewport; append a tall block so scrolling is real.
  await page.evaluate(`(() => {
    const tall = document.createElement('div');
    tall.id = 'tall-block';
    tall.style.height = '3000px';
    tall.style.background = 'linear-gradient(#fff,#eee)';
    document.body.appendChild(tall);
    return true;
  })()`);
  const s1 = await scroll(page, { dy: 800 });
  check('scroll dy moves page', (await page.evaluate('window.scrollY')) > 0 && s1.deltaY === 800, JSON.stringify(s1));
  const sTop = await scroll(page, { toTop: true });
  eq('scroll toTop', sTop.y, 0);
  const sBottom = await scroll(page, { toBottom: true });
  check('scroll toBottom', (await page.evaluate('window.scrollY')) > 0 && sBottom.deltaY === 0, JSON.stringify(sBottom));
  const sTarget = await scroll(page, { target: 'h1' });
  check('scroll target ok', sTarget.ok === true && sTarget.y >= 0, JSON.stringify(sTarget));
  await page.goto(srv.url + '/');
  await page.waitNetworkIdle(300, 5000);

  /* ---------------- waitFor ---------------- */
  const w1 = await waitFor(page, { selector: '#main-title' });
  eq('waitFor selector ok', w1.ok, true);
  const w2 = await waitFor(page, { text: 'hello world' });
  eq('waitFor text ok', w2.ok, true);
  const w3 = await waitFor(page, { functionText: '() => !!window.__apiData' }, { timeout: 5000 });
  eq('waitFor functionText ok', w3.ok, true);
  const w4 = await waitFor(page, { ms: 60 });
  check('waitFor ms ok', w4.ok && w4.elapsedMs >= 50, JSON.stringify(w4));
  await expectThrow('waitFor timeout readable', () => waitFor(page, { selector: '#never-appears' }, { timeout: 400 }), '等待超时');
  await expectThrow('waitFor empty conditions readable', () => waitFor(page, {}), '未提供等待条件');

  /* ---------------- click a real link navigates ---------------- */
  await page.waitNetworkIdle(300, 5000);
  await click(page, 'a[href="/page2"]');
  await page.waitNetworkIdle(300, 8000);
  await waitFor(page, { urlIncludes: '/page2' }, { timeout: 8000 });
  check('click link navigates', String(await page.evaluate('location.pathname')).endsWith('/page2'), await page.evaluate('location.pathname'));
  eq('navigated title', await page.evaluate('document.title'), 'Fixture Page 2');
  await waitFor(page, { selector: '#btn2' });
  const w5 = await waitFor(page, { networkIdle: 400, selector: '#btn2' }, { timeout: 8000 });
  eq('waitFor networkIdle combined', w5.ok, true);

  // snapshot still works after navigation
  const model2 = await pageModel(page);
  eq('pageModel after nav title', model2.title, 'Fixture Page 2');
  check('pageModel after nav links', model2.links.some((l) => l.href === srv.url + '/'));
} catch (err) {
  failed += 1;
  failures.push(`fatal: ${err && err.stack ? err.stack : err}`);
  console.error('FATAL', err && err.stack ? err.stack : err);
  exitCode = 1;
} finally {
  try {
    await session.stop();
  } catch {
    /* ignore */
  }
  try {
    await srv.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(uploadPath, { force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed > 0) {
  console.log('FAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  exitCode = 1;
}
process.exit(exitCode);
