import fs from 'node:fs';
const files = process.argv.slice(2);
const sec = (x) => (x / 1000).toFixed(1);
const pct = (x) => (x * 100).toFixed(1) + '%';
const CATS = ['clean', 'rotated', 'blur', 'noise_jpeg', 'phone_photo', 'two_column', 'table', 'mixed_zh_en'];
const out = [];
const agg = (rows) => {
  const e = rows.reduce((a, r) => a + r.edits, 0),
    n = rows.reduce((a, r) => a + r.refLen, 0),
    b = rows.reduce((a, r) => a + r.bagCommon, 0);
  const enp = rows.reduce((a, r) => a + r.editsNP, 0),
    nnp = rows.reduce((a, r) => a + r.refLenNP, 0);
  return { acc: Math.max(0, 1 - e / n), accNP: Math.max(0, 1 - enp / nnp), bag: b / n };
};
out.push('| config | accuracy | no-punct | order-free | pages ≥95% | s/page median/mean/max | init | RSS peak Δ |');
out.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
const per = [];
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  const a = agg(j.rows);
  const pass = j.rows.filter((r) => 1 - r.edits / r.refLen >= 0.95).length;
  const ms = j.rows.map((r) => r.ms).sort((x, y) => x - y);
  const mean = ms.reduce((x, y) => x + y, 0) / ms.length;
  out.push(
    [`| ${j.cfg}${j.throttle > 1 ? ' (CPU ÷' + j.throttle + ')' : ''} | ${pct(a.acc)} | ${pct(a.accNP)} | ${pct(a.bag)} | ${pass}/${j.rows.length}`,
      `${sec(ms[Math.floor(ms.length / 2)])} / ${sec(mean)} / ${sec(ms.at(-1))}`, `${Math.round(j.initMs)} ms`,
      `${((j.rssPeak - j.rssBaseline) / 1e6).toFixed(0)} MB |`].join(' | '),
  );
  per.push([j.cfg, Object.fromEntries(CATS.map((c) => [c, agg(j.rows.filter((r) => r.cat === c))]))]);
}
out.push('', '| 类别 | ' + per.map((p) => p[0]).join(' | ') + ' |', '| --- |' + per.map(() => ' --- |').join(''));
for (const c of CATS) out.push(`| ${c} | ` + per.map((p) => `${pct(p[1][c].acc)}（${pct(p[1][c].bag)}）`).join(' | ') + ' |');
console.log(out.join('\n'));
