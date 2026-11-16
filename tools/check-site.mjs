// Checks the GitHub Pages site in headless Chrome (Windows GPU, like check-scenes.mjs).
//   node tools/build-site.mjs && node tools/check-site.mjs            local _site under the Pages prefix
//   node tools/check-site.mjs https://jfayling.github.io/fayling-web-scenery-pictureframe/
// Serving _site under /fayling-web-scenery-pictureframe/ (and 404 everywhere else) catches
// root-absolute paths that would break on a project Pages site.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, '_site');
const PREFIX = '/fayling-web-scenery-pictureframe/';
const types = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.mp3': 'audio/mpeg' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let server;
let base = process.argv[2];
if (!base) {
  assert(fs.existsSync(path.join(site, 'index.html')), 'run node tools/build-site.mjs first');
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith(PREFIX)) { res.writeHead(404); res.end(); return; }
    let p = decodeURIComponent(url.pathname.slice(PREFIX.length)) || 'index.html';
    const file = path.join(site, p);
    if (!file.startsWith(site) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }).listen(8096);
  base = `http://localhost:8096${PREFIX}`;
}
if (!base.endsWith('/')) base += '/';

// Static checks: entry point, metadata, and every asset the page or its link previews load.
const html = await (await fetch(base)).text();
assert(html.includes('navigator.gpu'), 'entry point is not the bundled app');
const og = html.match(/property="og:image" content="([^"]+)"/)?.[1];
assert(og, 'missing og:image');
assert(/<link rel="canonical"/.test(html) && /name="twitter:card"/.test(html), 'missing canonical or twitter card');
const assets = ['media/track001.mp3', 'media/track002.mp3', 'scenery.html', 'scenery.min.html', 'docs/social-preview.png'];
for (const a of assets) {
  const r = await fetch(base + a, { method: 'HEAD' });
  assert.equal(r.status, 200, `${a}: HTTP ${r.status}`);
}
console.log(`Static checks passed at ${base} (og:image ${og})`);

const profile = fs.mkdtempSync(path.join(root, 'shots', 'chrome-site-'));
const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  '--disable-gpu-sandbox', '--no-first-run', '--remote-debugging-port=8097',
  `--user-data-dir=${profile}`, '--window-size=1280,720', 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let pages;
  for (let n = 0; n < 100 && !pages; n++) {
    try { pages = await (await fetch('http://localhost:8097/json')).json(); } catch { await sleep(200); }
  }
  socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map(), errors = [], failed = [];
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(msg.params.exceptionDetails));
    if (msg.method === 'Network.responseReceived' && msg.params.response.status >= 400) failed.push(`${msg.params.response.status} ${msg.params.response.url}`);
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__checkGPU = [];
    const original = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function(...args) {
      const device = await original.apply(this, args);
      device.addEventListener('uncapturederror', e => window.__checkGPU.push(e.error.message));
      return device;
    };
  ` });
  for (const scene of ['', 'pnw', 'alpine', 'canyon', 'falls', 'moon']) {
    errors.length = failed.length = 0;
    const query = scene ? `?scene=${scene}&ui=0&weather=false` : '?weather=false';
    await send('Page.navigate', { url: base + query });
    let ready = false;
    for (let n = 0; n < 180 && !ready; n++) {
      await sleep(500);
      const s = await evaluate(`({ready: !document.getElementById('loading'), error: document.getElementById('err')?.textContent, gpu: window.__checkGPU})`);
      assert(!s?.error, s?.error);
      assert.equal(s?.gpu?.length || 0, 0, JSON.stringify(s?.gpu));
      ready = s?.ready;
    }
    assert(ready, `${scene || 'tour'}: startup timed out`);
    await sleep(2500);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert.equal(failed.length, 0, failed.join('\n'));
    // Music is off by default; confirm the track the page would play is reachable from it.
    const music = await evaluate(`fetch('media/track001.mp3', {method: 'HEAD'}).then(r => r.status)`);
    assert.equal(music, 200, 'music path does not resolve relative to the page');
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, 'shots', `site-${scene || 'tour'}.png`), Buffer.from(shot.data, 'base64'));
    const label = await evaluate(`document.getElementById('scene-label')?.textContent || ''`);
    console.log(`${scene || 'tour'}: rendered, no shader, runtime, or HTTP errors; label "${label}"`);
  }
} finally {
  socket?.close();
  chrome.kill();
  server?.close();
}
