// LIB-2d step 2: 36 harder pages (q01–q36) closer to real scans, plus Word-embedded image crops.
// Same text bank, layout and degradation as gen.mjs, then an extra canvas pass (keystone/curl, 180°, B/W, shadow).
// Deterministic (seeded). Writes set/q*.jpg, set/q*.txt and set/manifest-2.json.
import fs from 'node:fs';
import path from 'node:path';
import { ZH, MIXED, TITLES } from './textbank.mjs';
import { rng, renderPage, degrade } from './pagekit.mjs';

const OUT = path.resolve(process.argv[2] || 'set');
fs.mkdirSync(OUT, { recursive: true });
const W = 1654;
// category, count, layout overrides, base degradation, extra pass
const PLAN = [
  ['perspective', 6, {}, 'phone', { keystone: true }],
  ['upside_down', 3, {}, 'light', { flip: true }],
  ['lowres_bw', 5, {}, 'light', { bw: true, scale: 0.5 }],
  ['shadow', 4, {}, 'light', { shadow: true }],
  ['small_font', 4, { fontSize: 22 }, 'light', {}],
  ['handwriting_font', 6, { fonts: ['Hannotate SC', 'HanziPen SC', 'Xingkai SC'] }, 'light', {}],
  ['word_embedded', 8, { H: 1100, mixed: true }, 'embed', {}],
];
const BASE_FONTS = ['PingFang SC', 'Songti SC', 'Hiragino Sans GB', 'STHeiti'];
const pages = [];
let n = 0;
for (const [cat, count, layout, base, extra] of PLAN)
  for (let i = 0; i < count; i++) {
    n++;
    pages.push({ id: `q${String(n).padStart(2, '0')}`, cat, seed: 3000 + n, layout, base, extra, i });
  }

function buildSpec(p) {
  const r = rng(p.seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const fonts = p.layout.fonts || BASE_FONTS;
  const font = p.layout.fonts ? fonts[p.i % fonts.length] : fonts[p.seed % fonts.length];
  const next = () => (p.layout.mixed && r() < 0.35 ? pick(MIXED) : pick(ZH));
  return {
    font, title: pick(TITLES), stream: Array.from({ length: 220 }, next),
    paraBreaks: Array.from({ length: 220 }, () => r() < 0.22), table: null, fontSize: p.layout.fontSize || 33,
  };
}

function recipe(base, r) {
  const u = (a, b) => a + (b - a) * r();
  const sgn = r() < 0.5 ? -1 : 1;
  if (base === 'phone')
    return { rot: sgn * u(0.5, 2.5), blur: u(0.6, 1.0), noise: 10, sp: 0, light: u(0.3, 0.5), scale: u(0.7, 0.8), q: 0.7, tint: true };
  // Word-embedded scan: small (≈ 900 px wide, about 110 dpi), heavy JPEG, as pasted into a document.
  if (base === 'embed') return { rot: sgn * u(0, 1.2), blur: u(0, 0.6), noise: 8, sp: 0, light: 0, scale: u(0.5, 0.6), q: u(0.5, 0.65) };
  return { rot: sgn * u(0, 0.8), blur: 0, noise: 6, sp: 0, light: 0, scale: 1, q: 0.8 };
}

// Runs in the page: second canvas pass for degradations gen.mjs does not have.
async function post({ jpg, e, seed }) {
  let s = seed >>> 0;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const src = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + jpg)).blob());
  const sc = e.scale || 1;
  const w = Math.round(src.width * sc), h = Math.round(src.height * sc);
  let c = new OffscreenCanvas(w, h), x = c.getContext('2d');
  x.drawImage(src, 0, 0, w, h);
  const info = {};
  if (e.keystone) {
    // Phone held at an angle: top edge narrower than the bottom (row strips), and the page bows (column strips).
    const top = 0.84 + 0.08 * r(), curl = (8 + 10 * r()) * (r() < 0.5 ? -1 : 1);
    info.keystoneTop = Math.round(top * 1000) / 1000;
    info.curlPx = Math.round(curl);
    const a = new OffscreenCanvas(w, h), ax = a.getContext('2d');
    ax.fillStyle = '#b9b2a4';
    ax.fillRect(0, 0, w, h);
    for (let y = 0; y < h; y += 2) {
      const k = top + (1 - top) * (y / h), dw = w * k;
      ax.drawImage(c, 0, y, w, 2, (w - dw) / 2, y, dw, 2);
    }
    const b = new OffscreenCanvas(w, h), bx = b.getContext('2d');
    bx.fillStyle = '#b9b2a4';
    bx.fillRect(0, 0, w, h);
    for (let xx = 0; xx < w; xx += 2) bx.drawImage(a, xx, 0, 2, h, xx, curl * Math.sin((Math.PI * xx) / w), 2, h);
    c = b;
    x = bx;
  }
  if (e.flip) {
    const f = new OffscreenCanvas(w, h), fx = f.getContext('2d');
    fx.translate(w, h);
    fx.rotate(Math.PI);
    fx.drawImage(c, 0, 0);
    c = f;
    x = fx;
  }
  if (e.shadow) {
    // Book-gutter / hand shadow on one side.
    const left = r() < 0.5, width = w * (0.15 + 0.1 * r()), dark = 0.45 + 0.15 * r();
    info.shadowSide = left ? 'left' : 'right';
    const g = x.createLinearGradient(left ? 0 : w, 0, left ? width : w - width, 0);
    const v = Math.round(255 * (1 - dark));
    g.addColorStop(0, `rgb(${v},${v},${v})`);
    g.addColorStop(1, 'rgb(255,255,255)');
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    x.globalCompositeOperation = 'source-over';
  }
  if (e.bw) {
    // Fax / office copier: hard black-and-white threshold at about 100 dpi.
    const im = x.getImageData(0, 0, w, h), p = im.data;
    for (let i = 0; i < p.length; i += 4) {
      const v = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114 < 150 ? 0 : 255;
      p[i] = p[i + 1] = p[i + 2] = v;
    }
    x.putImageData(im, 0, 0);
  }
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { jpg: btoa(bin), w, h, info };
}

const browser = await (await import('./browser.mjs')).launch();
const manifest = [];
for (const p of pages) {
  const H = p.layout.H || 2339;
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await page.setContent('<html><body style="margin:0"></body></html>');
  const spec = buildSpec(p);
  const gt = await page.evaluate(renderPage, { spec, cat: p.cat, W, H });
  await page.evaluate(() => document.fonts.ready);
  const used = await page.evaluate((f) => document.fonts.check(`33px "${f}"`), spec.font);
  const png = (await page.screenshot({ clip: { x: 0, y: 0, width: W, height: H } })).toString('base64');
  const d = recipe(p.base, rng(p.seed * 7));
  const first = await page.evaluate(degrade, { png, d, seed: p.seed * 13 });
  const out = Object.keys(p.extra).length ? await page.evaluate(post, { jpg: first.jpg, e: p.extra, seed: p.seed * 17 }) : first;
  await page.close();
  fs.writeFileSync(path.join(OUT, `${p.id}.jpg`), Buffer.from(out.jpg, 'base64'));
  fs.writeFileSync(path.join(OUT, `${p.id}.txt`), gt);
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 1000) / 1000 : v]));
  manifest.push({
    id: p.id, cat: p.cat, font: spec.font, fontAvailable: used, w: out.w, h: out.h, bytes: Buffer.from(out.jpg, 'base64').length,
    degrade: round(d), extra: { ...p.extra, ...(out.info || {}) }, gtChars: gt.replace(/\s/g, '').length,
  });
  process.stdout.write(`${p.id} ${p.cat} ${spec.font}${used ? '' : ' (FONT MISSING)'} ${manifest.at(-1).gtChars}\n`);
}
fs.writeFileSync(path.join(OUT, 'manifest-2.json'), JSON.stringify(manifest, null, 1));
const ref = new URL('./data/ground-truth-2.json', import.meta.url);
if (fs.existsSync(ref)) {
  const want = JSON.parse(fs.readFileSync(ref, 'utf8'));
  const diff = pages.filter((p) => want[p.id] !== fs.readFileSync(path.join(OUT, `${p.id}.txt`), 'utf8')).map((p) => p.id);
  console.log(diff.length ? `ground truth differs from data/ground-truth-2.json on: ${diff.join(' ')}` : 'ground truth matches data/ground-truth-2.json');
}
await browser.close();
