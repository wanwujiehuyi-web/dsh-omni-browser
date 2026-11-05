// test/server.mjs — local fixture site for plugin tests (no internet needed).
import http from 'node:http';

const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const STYLE = `<style>
  body{font-family:system-ui,sans-serif;max-width:820px;margin:24px auto;color:#222}
  nav a{margin-right:12px} table{border-collapse:collapse} td,th{border:1px solid #bbb;padding:4px 8px}
  .card{border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0}
</style>`;

const FRAME_HTML = `<!doctype html><html><head><title>Fixture Frame</title>${STYLE}</head>
<body><h3>Inside the iframe</h3><p id="frame-text">frame content</p></body></html>`;

const HOME_HTML = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><title>Omni Fixture Home</title>
<meta name="description" content="Local fixture page for dsh-omni-browser tests">
<meta property="og:title" content="Omni Fixture">
<link rel="canonical" href="http://127.0.0.1/canonical-home">
${STYLE}
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"Omni Fixture Home"}</script>
</head><body>
<nav><a href="/page2">Page 2</a><a href="/page3">Page 3</a><a href="https://example.com/" rel="external">External</a></nav>
<h1 id="main-title">Omni Browser Fixture</h1>
<p class="lead">This page exists so every collector has something real to capture.</p>
<div class="card" id="card-1"><h2>Card one</h2><p>hello <strong>world</strong></p></div>
<ul id="list"><li>alpha</li><li>beta</li><li>gamma</li></ul>
<table id="table"><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody>
<tr><td>requests</td><td>3</td></tr><tr><td>bytes</td><td>1024</td></tr></tbody></table>
<form id="form-1" action="/submit" method="post">
  <label for="email">Email</label><input id="email" name="email" type="email" placeholder="you@example.com" required>
  <label for="pwd">Password</label><input id="pwd" name="password" type="password">
  <label for="role">Role</label><select id="role" name="role"><option value="dev">Developer</option><option value="pm">Product</option></select>
  <label><input id="agree" name="agree" type="checkbox"> I agree</label>
  <textarea id="notes" name="notes" rows="2"></textarea>
  <button id="submit-btn" type="submit">Submit</button>
  <button id="plain-btn" type="button" onclick="document.getElementById('clicked').textContent='clicked!'">Click me</button>
</form>
<p id="clicked">not clicked</p>
<iframe id="frame-1" src="/frame" width="320" height="120" title="fixture frame"></iframe>
<img id="pixel" src="/img.png" alt="pixel">
<script>
  localStorage.setItem('omni-test', 'hello');
  sessionStorage.setItem('omni-session', 'world');
  console.log('fixture ready');
  console.warn('fixture warning');
  fetch('/api/data').then(r => r.json()).then(d => { document.title = 'Omni Fixture Home'; window.__apiData = d; });
  document.getElementById('submit-btn').addEventListener('click', (e) => { e.preventDefault(); });
</script>
</body></html>`;

const PAGE2_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Page 2</title>${STYLE}</head>
<body><nav><a href="/">Home</a></nav><h1>Page Two</h1><ol><li>one</li><li>two</li></ol>
<button id="btn2" type="button">Button two</button><div id="out2"></div></body></html>`;

const PAGE3_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Page 3</title>${STYLE}</head>
<body><h1>Page Three</h1><p>${'long text '.repeat(200)}</p></body></html>`;

const DOWNLOAD_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Download</title></head>
<body><h1>Download</h1><a id="dl" href="/files/sample.txt" download="sample.txt">Download sample</a></body></html>`;

const ROUTES = {
  '/': { type: 'text/html; charset=utf-8', body: HOME_HTML },
  '/page2': { type: 'text/html; charset=utf-8', body: PAGE2_HTML },
  '/page3': { type: 'text/html; charset=utf-8', body: PAGE3_HTML },
  '/download': { type: 'text/html; charset=utf-8', body: DOWNLOAD_HTML },
  '/frame': { type: 'text/html; charset=utf-8', body: FRAME_HTML },
  '/api/data': { type: 'application/json', body: JSON.stringify({ ok: true, items: [1, 2, 3], ts: 'fixture' }) },
  '/img.png': { type: 'image/png', body: PNG_1x1 },
  '/big': { type: 'text/plain; charset=utf-8', body: 'x'.repeat(200 * 1024) },
  '/submit': { type: 'text/html; charset=utf-8', body: '<!doctype html><html><head><title>Submitted</title></head><body><h1>Form submitted</h1></body></html>' },
};

export async function startServer({ port = 0 } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, headers: req.headers });
    if (url.pathname === '/slow') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html><head><title>Slow</title></head><body><h1>Slow page</h1></body></html>`);
      }, 1200);
      return;
    }
    if (url.pathname === '/files/sample.txt') {
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': 'attachment; filename="sample.txt"',
      });
      res.end('omni download fixture\n');
      return;
    }
    const route = ROUTES[url.pathname];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>404</title></head><body><h1>404 Not Found</h1></body></html>`);
      return;
    }
    const isText = String(route.type).includes('text') || String(route.type).includes('json');
    res.writeHead(200, { 'content-type': route.type, 'cache-control': 'no-store' });
    res.end(isText ? route.body : Buffer.from(route.body));
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address();
  const base = `http://127.0.0.1:${actual.port}`;
  const baseRoutes = new Map(Object.keys(ROUTES).map((p) => [p, ROUTES[p].body]));
  return {
    url: base,
    port: actual.port,
    requests,
    baseRoutes,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

// `node test/server.mjs` keeps a fixture site alive for manual poking.
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const srv = await startServer({ port: 8899 });
  console.log('fixture site:', srv.url);
}
