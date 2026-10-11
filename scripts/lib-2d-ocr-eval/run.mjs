// Full run: one fresh browser per engine config, all 50 pages, under the sandbox CSP + 'wasm-unsafe-eval'.
import { launch } from './browser.mjs';
import { start, leaks } from './server.mjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { score } from './metrics.mjs';
const cfg = process.argv[2];
const DESKEW = cfg.includes('+deskew');
const COLS = cfg.includes('+cols');
const throttle = Number(process.argv[3] || 1);
const manifest = JSON.parse(fs.readFileSync(process.env.MANIFEST || 'set/manifest.json', 'utf8'));
const srv = await start();
const port = srv.address().port;
const ext = await start();
const extBase = 'http://127.0.0.1:' + ext.address().port;
const rss = () => {
  try {
    return (
      execSync(`ps -A -o rss=,command= | grep -E "ms-playwright|Chrome for Testing" | grep -v grep | awk '{s+=$1} END {print s}'`).toString().trim() * 1024
    );
  } catch {
    return 0;
  }
};
const b = await launch();
const pg = await b.newPage();
const client = await pg.context().newCDPSession(pg);
if (throttle > 1) await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
await pg.goto(`http://127.0.0.1:${port}/`);
const base = rss();
let peak = base;
const timer = setInterval(() => {
  const v = rss();
  if (v > peak) peak = v;
}, 200);
const eng = cfg.startsWith('paddle') ? 'paddle' : 'tess';
if (DESKEW) console.log('deskew on');
await pg.evaluate(([e]) => harness.boot(e, 'wasm'), [eng]);
const TESS = { tess: ['4.0.0_best_int'] };
const init =
  eng === 'tess'
    ? await pg.evaluate(() =>
        harness.initTess([
          ['chi_sim', '/a/chi_sim.traineddata.gz'],
          ['eng', '/a/eng.traineddata.gz'],
        ]),
      )
    : await pg.evaluate((t) => harness.initPaddle(t), cfg.split('+')[0].split('-')[1]);
if (init.type !== 'ready') {
  console.log('init failed', init);
  process.exit(1);
}
const probe = await pg.evaluate((u) => harness.probe(u), extBase);
const rows = [];
for (const m of manifest) {
  const r = await pg.evaluate(([id, dk, c]) => harness.ocr(id, dk, c), [m.id, DESKEW, COLS]);
  const text = r.type === 'result' ? r.text : '';
  const s = score(fs.readFileSync(`set/${m.id}.txt`, 'utf8'), text);
  rows.push({ id: m.id, cat: m.cat, ms: Math.round(r.ms || 0), error: r.type === 'error' ? r.msg : undefined, ...s, text });
  rows.at(-1).angle = r.angle;
  process.stdout.write(
    `${m.id} ${m.cat} ${Math.round(r.ms)}ms a=${r.angle ?? '-'} acc=${(1 - s.edits / s.refLen).toFixed(4)} bag=${(s.bagCommon / s.refLen).toFixed(4)}\n`,
  );
}
clearInterval(timer);
await new Promise((r) => setTimeout(r, 1000));
const cspEvents = (await pg.evaluate(() => harness.events())).filter((e) => e.type === 'csp');
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync(
  `results/${process.env.MANIFEST ? 'vocab-' : ''}${cfg}${throttle > 1 ? '-x' + throttle : ''}.json`,
  JSON.stringify({ cfg, throttle, initMs: init.initMs, probe, cspEvents, leaks, rssBaseline: base, rssPeak: peak, rows }, null, 1),
);
console.log('initMs', init.initMs, 'rss base MB', (base / 1e6).toFixed(0), 'peak MB', (peak / 1e6).toFixed(0), 'leaks', leaks.length);
await b.close();
srv.close();
ext.close();
