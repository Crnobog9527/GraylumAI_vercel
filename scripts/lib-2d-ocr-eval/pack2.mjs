// Copies step-2 ground truth, manifests and raw OCR outputs from set/ and results/ into data/ for rescoring.
import fs from 'node:fs';
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const manifest = read('set/manifest-2.json');
const gt = Object.fromEntries(manifest.map((m) => [m.id, fs.readFileSync(`set/${m.id}.txt`, 'utf8')]));
fs.writeFileSync('data/ground-truth-2.json', JSON.stringify(gt, null, 1));
fs.writeFileSync('data/manifest-2.json', JSON.stringify(manifest, null, 1));
const outputs = {};
// Only the step-2 tagged runs (TAG=set1 / TAG=set2 in the README); untagged or stale step-1 files never enter
// outputs-2.json, so they cannot shadow the committed step-1 runs in rescore.mjs.
const STEP2 = /^set[12]-[a-z0-9+-]+\.json$/;
for (const f of fs.readdirSync('results').filter((x) => STEP2.test(x)).sort()) {
  const j = read(`results/${f}`);
  outputs[f.replace(/\.json$/, '')] = {
    initMs: j.initMs, rssPeakDelta: j.rssPeak - j.rssBaseline, leaks: j.leaks.length,
    ms: Object.fromEntries(j.rows.map((r) => [r.id, r.ms])), text: Object.fromEntries(j.rows.map((r) => [r.id, r.text])),
    flipped: j.rows.filter((r) => r.flipped).map((r) => r.id),
  };
}
fs.writeFileSync('data/outputs-2.json', JSON.stringify(outputs));
console.log('packed', Object.keys(outputs).join(' '));
