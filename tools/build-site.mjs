// Assembles the static GitHub Pages site in ./_site from the built bundles and checks that
// every repository-relative path the page needs is present.
//   node build.mjs && node tools/build-site.mjs
//
//   _site/index.html        the minified self-contained app (the live demo)
//   _site/scenery.html      readable standalone bundle, for download
//   _site/scenery.min.html  minified standalone bundle, for download
//   _site/media/            optional soundtrack, loaded relative to the page
//   _site/docs/             social preview and hero images
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '_site');
const PAGES_FILE_LIMIT = 100 * 1024 * 1024;

const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const copy = (from, to = from) => {
  const src = path.join(root, from);
  if (!fs.existsSync(src)) { problems.push(`missing ${from}`); return; }
  fs.mkdirSync(path.dirname(path.join(out, to)), { recursive: true });
  fs.copyFileSync(src, path.join(out, to));
};

copy('scenery.min.html', 'index.html');
copy('scenery.html');
copy('scenery.min.html');
for (const f of fs.readdirSync(path.join(root, 'media'))) copy(`media/${f}`);
// Only the images that pages and link previews load; the README gallery stays in the repo.
for (const f of ['social-preview.png', 'hero.png']) copy(`docs/${f}`);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// The deployed page must be the bundled app, not the module-loading dev page.
const index = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
need(!/<script[^>]+src=/.test(index), 'index.html still loads external scripts; run npm run build');
need(index.includes('navigator.gpu'), 'index.html does not contain the renderer');
for (const id of ['moon', 'moon-aristarchus', 'moon-hadley', 'moon-tycho', 'moon-orientale']) {
  need(index.includes(`'${id}'`) || index.includes(`"${id}"`), `lunar scene ${id} missing from the bundle`);
}
need((index.match(/SLDEM2015/g) || []).length >= 5, 'embedded lunar elevation assets missing from the bundle');

// Every relative asset the app or its metadata references must ship with the site.
const refs = new Set();
for (const m of index.matchAll(/['"`](media\/[^'"`]+)['"`]/g)) refs.add(m[1]);
for (const m of index.matchAll(/<(?:meta|link)[^>]+(?:content|href)="https:\/\/jfayling\.github\.io\/fayling-web-scenery-pictureframe\/([^"]*)"/g)) {
  if (m[1]) refs.add(m[1]);
}
need([...refs].some((r) => r.startsWith('media/')), 'no media references found in the bundle');
for (const r of refs) need(fs.existsSync(path.join(out, r)), `referenced asset missing from site: ${r}`);

// Root-absolute paths break under the /fayling-web-scenery-pictureframe/ project prefix.
for (const m of index.matchAll(/(?:src|href)="(\/[^/"][^"]*)"/g)) problems.push(`root-absolute path breaks on Pages: ${m[1]}`);

let total = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const size = fs.statSync(p).size;
    total += size;
    need(size < PAGES_FILE_LIMIT, `${path.relative(out, p)} exceeds the 100 MB Pages file limit`);
  }
};
walk(out);

if (problems.length) {
  console.error('Site check failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`_site ready: ${(total / 1048576).toFixed(1)} MB, assets checked: ${[...refs].join(', ')}`);
