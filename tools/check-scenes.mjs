// Windows GPU integration check. Starts its own server and headless Chrome.
// node tools/check-scenes.mjs (CHROME_PATH can override the executable)
// Optional arguments select named render checks; transition checks always run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MOON_DEM } from '../js/moon-data.js';
import { decodeMoonTerrain, MOON_SPAN_X, MOON_SPAN_Z } from '../js/planet-terrain.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const heights = await decodeMoonTerrain();
const raw = Buffer.alloc(heights.length * 2);
for (let i = 0; i < heights.length; i++) raw.writeInt16LE(heights[i], i * 2);
assert.equal(createHash('sha256').update(raw).digest('hex'), MOON_DEM.sha256);
// Copernicus is at 9.62 N, 339.92 E; the crop must include its rim and central peaks.
assert(MOON_DEM.south < 8 && MOON_DEM.north > 12);
assert(MOON_SPAN_X > 290000 && MOON_SPAN_Z > 300000);
console.log('Elevation decoding, checksum, and geographic bounds passed.');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
fs.mkdirSync(path.join(root, 'shots'), { recursive: true });
const profile = fs.mkdtempSync(path.join(root, 'shots', 'chrome-check-'));
const server = spawn(process.execPath, ['server.mjs', '8092'], { cwd: root, windowsHide: true });
server.stdout.on('data', (b) => process.stdout.write(b));
server.stderr.on('data', (b) => process.stderr.write(b));
const chrome = spawn(process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [
  '--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11',
  '--disable-gpu-sandbox', '--no-first-run', '--remote-debugging-port=8093',
  `--user-data-dir=${profile}`, '--window-size=1280,720', 'about:blank',
], { windowsHide: true, stdio: 'ignore' });
let socket;
try {
  let pages;
  for (let n = 0; n < 100; n++) {
    try { pages = await (await fetch('http://localhost:8093/json')).json(); break; } catch { await sleep(200); }
  }
  assert(pages?.length, 'Chrome debugging endpoint unavailable');
  socket = new WebSocket(pages.find((p) => p.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let serial = 0;
  const pending = new Map(), errors = [];
  socket.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
    if (msg.method === 'Runtime.exceptionThrown') errors.push(JSON.stringify(msg.params.exceptionDetails));
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  // Record uncaptured GPU validation errors before application startup.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__checkGPU = [];
    const original = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function(...args) {
      const device = await original.apply(this, args);
      device.addEventListener('uncapturederror', e => window.__checkGPU.push(e.error.message));
      return device;
    };
  ` });
  const waitReady = async () => {
    for (let n = 0; n < 180; n++) {
      const state = await evaluate(`({ready: !document.getElementById('loading'), error: document.getElementById('err')?.textContent, gpu: window.__checkGPU})`);
      assert(!state?.error, state?.error);
      assert.equal(state?.gpu?.length || 0, 0, JSON.stringify(state?.gpu));
      assert.equal(errors.length, 0, errors.join('\n'));
      if (state?.ready) { await sleep(1800); return; }
      await sleep(500);
    }
    throw new Error('Scene startup timed out');
  };
  const renderChecks = [
    ['moon', 'http://localhost:8092/?scene=moon&ui=0&rain=true'],
    ['moon-floor', 'http://localhost:8092/?scene=moon&ui=0&z=12000&clock=false'],
    ['moon-exit', 'http://localhost:8092/?scene=moon&ui=0&z=-34000&clock=false'],
    ...['aristarchus', 'hadley', 'tycho', 'orientale'].map((region) => [
      `moon-${region}`, `http://localhost:8092/?scene=moon-${region}&ui=0&clock=false`,
    ]),
    ['moon-hadley-rille', 'http://localhost:8092/?scene=moon-hadley&ui=0&z=0&clock=false'],
    ['moon-orientale-rings', 'http://localhost:8092/?scene=moon-orientale&ui=0&z=-166776&clock=false'],
    ['earth', 'http://localhost:8092/?scene=pnw&ui=0'],
    ['moon-offline', pathToFileURL(path.join(root, 'scenery.html')).href + '?scene=moon-hadley&ui=0'],
    ['moon-min-offline', pathToFileURL(path.join(root, 'scenery.min.html')).href + '?scene=moon-orientale&ui=0'],
  ];
  const selected = process.argv.slice(2);
  for (const name of selected) assert(renderChecks.some(([key]) => key === name), `Unknown render check: ${name}`);
  for (const [name, url] of renderChecks.filter(([name]) => !selected.length || selected.includes(name))) {
    errors.length = 0;
    await send('Page.navigate', { url });
    await sleep(800);
    await waitReady();
    const screenshot = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(root, 'shots', `check-${name}.png`), Buffer.from(screenshot.data, 'base64'));
    const trees = await evaluate('window.__trees');
    assert.equal((await evaluate('window.__checkGPU')).length, 0);
    if (name.startsWith('moon')) assert(trees?.length > 0 && trees.every((count) => count === 0));
    console.log(`${name}: rendered, no shader/runtime errors; trees=${JSON.stringify(trees)}`);
  }
  // Force a Moon-to-Earth transition through the actual Next scene button.
  await send('Page.navigate', { url: 'http://localhost:8092/?scene=moon&sceneMode=tour&ui=0' });
  await sleep(800); await waitReady();
  // Every lunar-to-lunar transition must select new terrain without reloading.
  for (const name of ['Aristarchus', 'Hadley', 'Tycho', 'Orientale']) {
    await evaluate(`document.getElementById('next-scene').click()`);
    for (let n = 0; n < 90; n++) {
      if ((await evaluate(`document.getElementById('scene-label').textContent`)).includes(name)) break;
      await sleep(500);
    }
    assert((await evaluate(`document.getElementById('scene-label').textContent`)).includes(name));
    await sleep(3000);
    assert.equal((await evaluate('window.__checkGPU')).length, 0);
    assert.equal(errors.length, 0, errors.join('\n'));
    assert((await evaluate('window.__trees')).every((count) => count === 0));
    console.log(`Transition to ${name} passed.`);
  }
  await evaluate(`document.getElementById('next-scene').click()`);
  for (let n = 0; n < 90; n++) {
    if ((await evaluate(`document.getElementById('scene-label').textContent`)).includes('Pacific Northwest')) break;
    await sleep(500);
  }
  assert((await evaluate(`document.getElementById('scene-label').textContent`)).includes('Pacific Northwest'));
  await sleep(3000);
  assert.equal((await evaluate('window.__checkGPU')).length, 0);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Moon-to-Earth transition passed.');
  // Reverse transition restores the lunar environment without reloading the page.
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', {code: 'BracketLeft'}))`);
  for (let n = 0; n < 90; n++) {
    if ((await evaluate(`document.getElementById('scene-label').textContent`)).includes('Orientale')) break;
    await sleep(500);
  }
  assert((await evaluate(`document.getElementById('scene-label').textContent`)).includes('Orientale'));
  assert.equal(await evaluate(`document.querySelector('.section[data-earth-only]').hidden`), true);
  assert.equal((await evaluate('window.__checkGPU')).length, 0);
  console.log('Earth-to-Moon transition and environment controls passed.');
  // A requested start at the route endpoint must fade and restart within the crop.
  await send('Page.navigate', { url: 'http://localhost:8092/?scene=moon&z=-52000&tourMinutes=30' });
  await sleep(800);
  for (let n = 0; n < 180; n++) {
    if ((await evaluate(`document.getElementById('fps')?.textContent || ''`)).includes('#2')) break;
    assert.equal(errors.length, 0, errors.join('\n'));
    await sleep(500);
  }
  assert((await evaluate(`document.getElementById('fps').textContent`)).includes('#2'));
  await sleep(2500);
  assert.equal((await evaluate('window.__checkGPU')).length, 0);
  console.log('Bounded route restart passed.');
} finally {
  socket?.close();
  chrome.kill();
  server.kill();
}
