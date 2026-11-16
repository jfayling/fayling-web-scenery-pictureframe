// Regenerates the README and social images from real renders in headless Chrome.
//   npm install --no-save sharp      (image encoding only; not a project dependency)
//   node tools/make-media.mjs [hero] [social] [preview]
//
//   docs/hero.png            1920x1080 frame of the hero scene
//   docs/social-preview.png  1280x640 GitHub / Open Graph card cut from the hero frame
//   docs/preview.webp        short animated flight through several regions, real flight speed
//
// Frames come from the app's screenshot mode (?shot=), which renders at a fixed 1/60 s
// step, so the animation shows the actual autopilot speed regardless of how fast the GPU is.
// CHROME_PATH overrides the Chrome executable.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shots = path.join(root, 'shots');
const docs = path.join(root, 'docs');
const PORT = 8095;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const QUIET = 'clock=false&weather=false';

const HERO = { query: 'scene=falls' };
// Each clip starts 300 frames into the flight so the terrain bake has settled.
const PREVIEW = [
  { query: 'scene=falls', seconds: 3 },
  { query: 'scene=pnw&forestDensity=0.8', seconds: 3 },
  { query: 'scene=new-england&forestDensity=1', seconds: 3 },
  { query: 'scene=alpine&forestDensity=0.6', seconds: 3 },
  { query: 'scene=coast', seconds: 3 },
  { query: 'scene=moon-tycho', seconds: 3 },
];
const PREVIEW_W = 640, PREVIEW_H = 360, PREVIEW_FPS = 10;

let sharp;
try { sharp = (await import('sharp')).default; } catch {
  console.error('sharp is required for encoding: npm install --no-save sharp');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const killTree = (child) => {
  if (process.platform === 'win32') {
    try { execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
  } else child.kill('SIGKILL');
};

async function render(name, query, { w = 1920, h = 1080, frames = 300, seq = 1, step = 1, timeoutS = 240 } = {}) {
  const done = path.join(shots, name);
  fs.rmSync(done, { force: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'scenery-media-'));
  const url = `http://localhost:${PORT}/?ui=0&${QUIET}&shot=${name}&frames=${frames}&seq=${seq}&step=${step}&w=${w}&h=${h}&${query}`;
  const chrome = spawn(CHROME, [
    '--headless=new', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=d3d11',
    '--disable-gpu-sandbox', '--no-first-run', `--user-data-dir=${profile}`, `--window-size=${w},${h}`, url,
  ], { stdio: 'ignore', windowsHide: true });
  try {
    for (let t = 0; !fs.existsSync(done); t += 0.5) {
      if (t > timeoutS) throw new Error(`timed out rendering ${name}`);
      await sleep(500);
    }
    await sleep(300);
  } finally {
    killTree(chrome);
    await sleep(500);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  if (seq === 1) return [done];
  return Array.from({ length: seq }, (_, i) => path.join(shots, name.replace('.png', `_${i}.png`)));
}

const kb = (file) => `${(fs.statSync(file).size / 1024).toFixed(0)} KB`;
const heroShot = path.join(shots, 'media-hero.png');

async function hero() {
  await render('media-hero.png', HERO.query);
  const out = path.join(docs, 'hero.png');
  await sharp(heroShot).png({ compressionLevel: 9, palette: true, quality: 95, colours: 256, dither: 0.6 }).toFile(out);
  console.log('docs/hero.png', kb(out));
}

async function social() {
  if (!fs.existsSync(heroShot)) await render('media-hero.png', HERO.query);
  const W = 1280, H = 640;
  const overlay = Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.72"/>
    </linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#g)"/>
    <text x="64" y="520" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="68" font-weight="300"
          letter-spacing="10" fill="#f7f4ee">SCENERY</text>
    <text x="68" y="572" font-family="Segoe UI, Helvetica, Arial, sans-serif" font-size="26" fill="#f7f4ee" fill-opacity="0.88">
      Real-time WebGPU aerial landscapes · procedural Earth · measured Moon</text>
  </svg>`);
  const out = path.join(docs, 'social-preview.png');
  await sharp(heroShot).resize(W, H, { fit: 'cover', position: 'centre' })
    .composite([{ input: overlay }])
    .png({ compressionLevel: 9, palette: true, quality: 90, colours: 256, dither: 0.6 })
    .toFile(out);
  console.log('docs/social-preview.png', kb(out), '(GitHub social preview must stay under 1 MB)');
}

async function preview() {
  const step = Math.round(60 / PREVIEW_FPS);
  const frames = [];
  for (const [i, clip] of PREVIEW.entries()) {
    const seq = Math.round(clip.seconds * PREVIEW_FPS);
    console.log(`clip ${i + 1}/${PREVIEW.length}: ${clip.query} (${seq} frames)`);
    const files = await render(`media-clip${i}.png`, clip.query, { w: PREVIEW_W, h: PREVIEW_H, seq, step });
    frames.push(...files);
  }
  // Animated WebP, not GIF: a 256-colour palette turns the mixed autumn canopy brown, and a
  // GIF that keeps it is more than twice the size.
  const out = path.join(docs, 'preview.webp');
  const raw = await Promise.all(frames.map((f) => sharp(f).png().toBuffer()));
  await sharp(raw, { join: { animated: true } })
    .webp({ delay: 1000 / PREVIEW_FPS, loop: 0, quality: 60, effort: 6, smartSubsample: true })
    .toFile(out);
  console.log('docs/preview.webp', kb(out), `${frames.length} frames`);
}

const jobs = { hero, social, preview };
const selected = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(jobs);
for (const name of selected) if (!jobs[name]) throw new Error(`unknown job ${name}`);

fs.mkdirSync(shots, { recursive: true });
const server = spawn(process.execPath, ['server.mjs', String(PORT)], { cwd: root, stdio: 'ignore', windowsHide: true });
try {
  await sleep(800);
  for (const name of selected) await jobs[name]();
} finally {
  server.kill();
}
