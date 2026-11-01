/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Reads the single-machine results (scripts/loadtest/single-machine.mjs, one JSON per level) and prints the part of the report that is arithmetic
// (CORE-PATH-V2 plan 3.3.3): k per level and whether it holds within +-15%, the lock-wait share per level, WAL and rows per turn, and the capacity
// table by size as orders of magnitude, with the uncertainties written under it. It decides nothing about 100 users on Micro; that is the
// staging run. Usage: node scripts/loadtest/extrapolate.mjs <result.json> <result.json> ... [--rhythm load|human]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { K_TOLERANCE, UNCERTAINTIES, kStable, waitsFlat, capacityTable, magnitude } from './lib/extrapolate.mjs';

export function report(results, rhythm = 'load') {
  const levels = results.filter(r => r.rhythm === rhythm).sort((a, b) => a.users - b.users)
    .map(r => ({ users: r.users, k: r.k, waitPercent: r.waits.lockManagerPercent + r.waits.tuplePercent, r }));
  // A level with no completed turn has no k: it is listed (with its failures) and left out of the stability and capacity arithmetic.
  const valid = levels.filter(l => Number.isFinite(l.k));
  const missing = levels.filter(l => !Number.isFinite(l.k)).map(l => `${l.users} users: ${l.r.failed} failed, no completed turn`);
  if (valid.length < 2) {
    const head = `Need at least two levels with rhythm "${rhythm}" that completed turns (have ${valid.length} of ${levels.length}).`;
    return [head, ...missing.map(m => `- ${m}`)].join('\n');
  }
  const k = kStable(valid), flat = waitsFlat(valid), first = levels[0].r;
  const line = ({ users, k: kk, r }) => `| ${[users, r.turns, r.turnsPerUserMinute, Number.isFinite(kk) ? kk.toFixed(4) : 'n/a', r.statementMsPerTurn,
    r.walBytesPerTurn, r.rowsWrittenPerTurn, `${r.waits.lockManagerPercent}% / ${r.waits.tuplePercent}%`, r.failed].join(' | ')} |`;
  const usable = levels.every(l => l.r.failed === 0);
  return [
    `### k and waits by level (${rhythm} rhythm; ${first.cpus} cores, ${first.memory}, shared_buffers ${first.sharedBuffers}, pool ${first.pool})`, '',
    '| users | turns | turns/user/min | k (core-s/turn) | statement ms/turn | WAL bytes/turn | rows written/turn | LockManager / tuple wait | failed |',
    '|---|---|---|---|---|---|---|---|---|', ...levels.map(line), '',
    `- k across ${levels[0].users} -> ${levels.at(-1).users}: spread ${k.spread === null ? 'unknown' : `${(k.spread * 100).toFixed(1)}%`} of the mean `
      + `(limit ${K_TOLERANCE * 100}%) -> ${k.stable === null ? 'not decidable' : k.stable ? 'holds' : 'DOES NOT HOLD'}.`,
    `- Lock waits: highest ${flat.max ?? 'n/a'}% -> ${flat.flat === null ? 'not decidable' : flat.flat ? 'flat and under 2%' : 'NOT FLAT'}.`,
    ...(usable ? [] : ['- Some turns failed in this run; k is per completed turn and the failures must be explained before the numbers are used.']), '',
    ...missing.map(m => `- ${m} (k n/a, left out of the arithmetic)`),
    `### Capacity at k = ${k.mean.toFixed(4)} core-s/turn and 60% CPU (order of magnitude)`,
    '', 'Plan 3.3.1 multiplies k by 3 for what the database container does not see; apply it when quoting a size.', '',
    '| size | turns/min | users at load rhythm | users at human rhythm (guess) |', '|---|---|---|---|',
    ...capacityTable(k.mean).map(c => [c.size, ...[c.turnsPerMinute, c.loadRhythmUsers, c.humanRhythmUsers].map(n => `~${magnitude(n)}`)])
      .map(cells => `| ${cells.join(' | ')} |`), '',
    '### What this does not cover', '', ...UNCERTAINTIES.map(u => `- ${u}`),
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = process.argv.slice(2).filter(a => !a.startsWith('--') && a !== process.argv[process.argv.indexOf('--rhythm') + 1]);
  const rhythm = process.argv.includes('--rhythm') ? process.argv[process.argv.indexOf('--rhythm') + 1] : 'load';
  console.log(report(files.map(f => JSON.parse(readFileSync(f, 'utf8'))), rhythm));
}
