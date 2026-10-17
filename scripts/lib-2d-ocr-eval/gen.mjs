// Generates 50 synthetic "scanned" pages + ground truth. Deterministic (seeded).
import fs from 'node:fs';
import path from 'node:path';
import { ZH, MIXED, TITLES, TABLE } from './textbank.mjs';
import { rng, renderPage, degrade } from './pagekit.mjs';

const OUT = path.resolve(process.argv[2] || 'set');
fs.mkdirSync(OUT, { recursive: true });

const FONTS = ['PingFang SC', 'Songti SC', 'Hiragino Sans GB', 'STHeiti'];
// category -> count; layout + degradation recipe
const PLAN = [
  ['clean', 8],
  ['rotated', 6],
  ['blur', 5],
  ['noise_jpeg', 6],
  ['phone_photo', 7],
  ['two_column', 6],
  ['table', 6],
  ['mixed_zh_en', 6],
];
const VOCAB = process.argv[3] === 'vocab';
const pages = [];
let n = 0;
if (VOCAB)
  for (let i = 0; i < 4; i++) {
    n++;
    pages.push({ id: `v${String(n).padStart(2, '0')}`, cat: 'vocab', seed: 5000 + n });
  }
else
  for (const [cat, count] of PLAN)
    for (let i = 0; i < count; i++) {
      n++;
      pages.push({ id: `p${String(n).padStart(2, '0')}`, cat, seed: 1000 + n });
    }
// GB2312 level-1 (3,755 common hanzi), shuffled once, split across the 4 vocab pages
const GB1 = [];
{
  const dec = new TextDecoder('gb2312');
  for (let hi = 0xb0; hi <= 0xd7; hi++)
    for (let lo = 0xa1; lo <= 0xfe; lo++) {
      if (hi === 0xd7 && lo > 0xf9) break;
      GB1.push(dec.decode(new Uint8Array([hi, lo])));
    }
}
{
  const r = rng(42);
  for (let i = GB1.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [GB1[i], GB1[j]] = [GB1[j], GB1[i]];
  }
}

const W = 1654,
  H = 2339; // A4 at 200 dpi

function buildSpec(p) {
  const r = rng(p.seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const font = FONTS[p.seed % FONTS.length];
  const title = pick(TITLES);
  const sentencePool = p.cat === 'mixed_zh_en' ? null : ZH;
  const nextSentence = () => {
    if (p.cat === 'mixed_zh_en') return r() < 0.45 ? pick(MIXED) : pick(ZH);
    return pick(sentencePool);
  };
  // pre-draw a long stream; the page script consumes until full
  let stream = Array.from({ length: 160 }, nextSentence);
  if (p.cat === 'vocab') {
    const k = Number(p.id.slice(1)) - 1,
      part = GB1.slice(Math.floor((k * GB1.length) / 4), Math.floor(((k + 1) * GB1.length) / 4));
    stream = [];
    for (let i = 0; i < part.length;) {
      const len = 6 + Math.floor(r() * 9);
      stream.push(part.slice(i, i + len).join('') + (r() < 0.5 ? '，' : '。'));
      i += len;
    }
  }
  const paraBreaks = Array.from({ length: 160 }, () => r() < 0.22);
  let table = null;
  if (p.cat === 'table') {
    const rows = 10 + Math.floor(r() * 5);
    table = [TABLE.header];
    for (let k = 0; k < rows; k++) {
      const m = 1 + Math.floor(r() * 12),
        d = 1 + Math.floor(r() * 28);
      table.push([
        pick(TABLE.items),
        pick(TABLE.people),
        `2026-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
        (Math.floor(r() * 900) * 100 + 1000).toLocaleString('en-US'),
        pick(TABLE.states),
      ]);
    }
  }
  const fontSize = p.cat === 'two_column' ? 30 : p.cat === 'vocab' ? 28 : 33;
  return { font, title, stream, paraBreaks, table, fontSize };
}

// Degradation recipes, executed in the browser on a canvas.
function recipe(cat, r) {
  const u = (a, b) => a + (b - a) * r();
  const sgn = r() < 0.5 ? -1 : 1;
  switch (cat) {
    case 'clean':
      return { rot: 0, blur: 0, noise: 4, sp: 0, light: 0, scale: 1, q: 0.9 };
    case 'rotated':
      return { rot: sgn * u(0.8, 3.0), blur: 0, noise: 5, sp: 0, light: 0, scale: 1, q: 0.85 };
    case 'blur':
      return { rot: 0, blur: u(1.0, 1.6), noise: 4, sp: 0, light: 0, scale: u(0.75, 0.85), q: 0.8 };
    case 'noise_jpeg':
      return { rot: sgn * u(0, 0.6), blur: 0, noise: u(18, 28), sp: 0.003, light: 0, scale: 1, q: u(0.4, 0.55) };
    case 'phone_photo':
      return { rot: sgn * u(1, 4), blur: u(0.6, 1.0), noise: 10, sp: 0, light: u(0.35, 0.55), scale: u(0.68, 0.78), q: 0.7, tint: true };
    default:
      return { rot: sgn * u(0, 0.6), blur: 0, noise: 8, sp: 0, light: 0, scale: 1, q: 0.8 };
  }
}

const browser = await (await import('./browser.mjs')).launch();
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
await page.setContent('<html><body style="margin:0"></body></html>');
const manifest = [];
for (const p of pages) {
  const spec = buildSpec(p);
  const gt = await page.evaluate(renderPage, { spec, cat: p.cat, W, H });
  await page.evaluate(() => document.fonts.ready);
  const png = (await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } })).toString('base64');
  const d = recipe(p.cat, rng(p.seed * 7));
  const out = await page.evaluate(degrade, { png, d, seed: p.seed * 13 });
  fs.writeFileSync(path.join(OUT, `${p.id}.jpg`), Buffer.from(out.jpg, 'base64'));
  fs.writeFileSync(path.join(OUT, `${p.id}.txt`), gt);
  manifest.push({
    id: p.id,
    cat: p.cat,
    font: spec.font,
    w: out.w,
    h: out.h,
    degrade: Object.fromEntries(Object.entries(d).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v])),
    gtChars: gt.replace(/\s/g, '').length,
  });
  process.stdout.write(`${p.id} ${p.cat} ${manifest.at(-1).gtChars}\n`);
}
fs.writeFileSync(path.join(OUT, VOCAB ? 'manifest-vocab.json' : 'manifest.json'), JSON.stringify(manifest, null, 1));
// Determinism check against the committed ground truth (fonts or browser differences show up here).
const ref = JSON.parse(fs.readFileSync(new URL('./data/ground-truth.json', import.meta.url), 'utf8'));
const diff = pages.filter((p) => ref[p.id] !== fs.readFileSync(path.join(OUT, `${p.id}.txt`), 'utf8')).map((p) => p.id);
console.log(diff.length ? `ground truth differs from data/ground-truth.json on: ${diff.join(' ')}` : 'ground truth matches data/ground-truth.json');
await browser.close();
