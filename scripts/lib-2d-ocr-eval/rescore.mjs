// Recomputes every number in the report from the committed ground truth and raw OCR outputs. No dependencies.
import fs from 'node:fs';
import { score } from './metrics.mjs';
const read = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
const gt = read('./data/ground-truth.json');
const outputs = read('./data/outputs.json');
const cats = Object.fromEntries(read('./data/manifest.json').map((m) => [m.id, m.cat]));
fs.mkdirSync('results-rescored', { recursive: true });
const files = [];
for (const [cfg, run] of Object.entries(outputs)) {
  const rows = Object.entries(run.text).map(([id, text]) => ({ id, cat: cats[id], ms: run.ms[id], ...score(gt[id], text) }));
  const file = `results-rescored/${cfg}.json`;
  fs.writeFileSync(file, JSON.stringify({ cfg, throttle: 1, initMs: run.initMs, rssBaseline: 0, rssPeak: run.rssPeakDelta, rows }));
  files.push(file);
}
console.log('rescored', files.length, 'runs; summarize with: node summarize.mjs results-rescored/<cfg>.json ...');
