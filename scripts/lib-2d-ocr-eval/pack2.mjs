// Copies step-2 ground truth, manifests and raw OCR outputs from set/ and results/ into data/ for rescoring.
import fs from 'node:fs';
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const manifest = read('set/manifest-2.json');
const gt = Object.fromEntries(manifest.map((m) => [m.id, fs.readFileSync(`set/${m.id}.txt`, 'utf8')]));
fs.writeFileSync('data/ground-truth-2.json', JSON.stringify(gt, null, 1));
fs.writeFileSync('data/manifest-2.json', JSON.stringify(manifest, null, 1));
const outputs = {};
for (const f of fs.readdirSync('results').filter((x) => x.endsWith('.json')).sort()) {
  const j = read(`results/${f}`);
  outputs[f.replace(/\.json$/, '')] = {
    initMs: j.initMs, rssPeakDelta: j.rssPeak - j.rssBaseline, leaks: j.leaks.length,
    ms: Object.fromEntries(j.rows.map((r) => [r.id, r.ms])), text: Object.fromEntries(j.rows.map((r) => [r.id, r.text])),
    flipped: j.rows.filter((r) => r.flipped).map((r) => r.id),
  };
}
fs.writeFileSync('data/outputs-2.json', JSON.stringify(outputs));
console.log('packed', Object.keys(outputs).join(' '));
