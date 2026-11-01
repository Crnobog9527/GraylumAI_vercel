/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure parts of the CORE-PATH-V2 100-user acceptance (plan 3.2) and its pass line (plan 3.1, last row): the stage plan, the user mix,
// the think time, the stream parser, the per-stage summary, the wait-event summary and the verdict. No network, no clock, no files.

export const STAGES = [30, 50, 75, 100, 50, 100]; // 3.2 item 4: 30 -> 50 -> 75 -> 100 -> 50 (regression) -> 100 (retest)
export const STAGE_MS = 150_000; // 2.5 minutes including the ramp
export const RAMP_MS = 10_000;
export const COOLDOWN_MS = 600_000; // between stages: Micro burst credit and swap recover
export const THINK_S = [7, 22]; // after a reply
export const MIX = { chat: 5, coach: 3, library: 2 }; // 10-25 rhythm
export const BASELINE_DRIFT = 0.1; // a batch whose 30-user baseline differs from the last batch's by more than this is void

// Plan 3.1 last row: 100 users on Micro with the stub model.
export const PASS_LINE = { failures: 0, statementTimeouts: 0, p95OverReplySeconds: 2, cpuMeanPercent: 60, lockManagerPercent: 2 };

export const kindsOf = (vus, mix = MIX) => {
  const wheel = Object.entries(mix).flatMap(([kind, weight]) => Array(weight).fill(kind));
  return Array.from({ length: vus }, (_, i) => wheel[i % wheel.length]);
};

export const thinkMs = (random = Math.random) => (THINK_S[0] + random() * (THINK_S[1] - THINK_S[0])) * 1000;

export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

// One Server-Sent Events body (plan 2.2: `opened`, `text`..., then exactly one `result` or `error`).
export function parseSse(text) {
  const events = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const name = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (!name || data === undefined) continue;
    try { events.push({ type: name, ...JSON.parse(data) }); } catch { events.push({ type: 'malformed' }); }
  }
  return events;
}

// A turn outcome from its events: ok only with a `result` and no `error`.
export function outcomeOf(events) {
  const error = events.find(e => e.type === 'error');
  const result = events.find(e => e.type === 'result');
  return { ok: Boolean(result) && !error, code: error?.code ?? (result ? null : 'NO_RESULT'), replay: Boolean(events.find(e => e.type === 'opened')?.replay) };
}

// records: [{ op: 'chat.turn' | 'coach.turn' | ..., ok, ms, firstByteMs?, code? }]. Only turn operations count as turns.
export function summarizeStage(records) {
  const turns = records.filter(r => /\.turn$/.test(r.op));
  const ms = turns.filter(r => r.ok).map(r => r.ms);
  const first = turns.filter(r => r.ok && Number.isFinite(r.firstByteMs)).map(r => r.firstByteMs);
  const codes = {};
  for (const r of records.filter(r => !r.ok)) codes[r.code ?? 'UNKNOWN'] = (codes[r.code ?? 'UNKNOWN'] ?? 0) + 1;
  return { turns: turns.length, failedTurns: turns.filter(r => !r.ok).length, failedOther: records.filter(r => !r.ok && !/\.turn$/.test(r.op)).length,
    p50Ms: percentile(ms, 50), p95Ms: percentile(ms, 95), firstByteP95Ms: percentile(first, 95), codes };
}

// samples: [{ t, waits: { 'LWLock:LockManager': 2, 'Client:ClientRead': 5, ... }, active, locks: { relation: n, tuple: n, ... } }]
export function summarizeWaits(samples) {
  const total = {};
  let waiting = 0;
  const locks = {};
  for (const s of samples) {
    for (const [name, n] of Object.entries(s.waits ?? {})) { total[name] = (total[name] ?? 0) + n; waiting += n; }
    for (const [type, n] of Object.entries(s.locks ?? {})) locks[type] = Math.max(locks[type] ?? 0, n);
  }
  const share = name => (waiting ? (100 * (total[name] ?? 0)) / waiting : 0);
  return { samples: samples.length, waitingBackends: waiting, lockManagerPercent: Number(share('LWLock:LockManager').toFixed(2)),
    tuplePercent: Number(share('Lock:tuple').toFixed(2)), maxLocks: locks,
    top: Object.entries(total).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => ({ name, percent: Number(share(name).toFixed(1)) })) };
}

// metrics: { cpuMeanPercent, swapStartMb, swapEndMb } from the Supabase report (the operator reads it; nothing here fetches it).
export function judgeStage({ summary, waits, metrics, replySeconds }, line = PASS_LINE) {
  const check = (name, value, ok, limit) => ({ name, value, limit, ok: value === null ? false : ok, known: value !== null });
  const p95s = summary.p95Ms === null ? null : summary.p95Ms / 1000;
  const swap = metrics && Number.isFinite(metrics.swapStartMb) && Number.isFinite(metrics.swapEndMb) ? metrics.swapEndMb - metrics.swapStartMb : null;
  return [
    check('failed turns', summary.failedTurns + summary.failedOther, summary.failedTurns + summary.failedOther <= line.failures, line.failures),
    check('57014 statement timeouts', summary.codes['57014'] ?? summary.codes.TURN_STATEMENT_TIMEOUT ?? 0,
      (summary.codes['57014'] ?? summary.codes.TURN_STATEMENT_TIMEOUT ?? 0) <= line.statementTimeouts, line.statementTimeouts),
    check('turn p95 seconds', p95s, p95s !== null && p95s <= replySeconds + line.p95OverReplySeconds, replySeconds + line.p95OverReplySeconds),
    check('database CPU mean %', metrics?.cpuMeanPercent ?? null, (metrics?.cpuMeanPercent ?? Infinity) < line.cpuMeanPercent, line.cpuMeanPercent),
    check('swap growth MB', swap, swap !== null && swap <= 0, 0),
    check('LWLock:LockManager %', waits ? waits.lockManagerPercent : null, (waits?.lockManagerPercent ?? Infinity) < line.lockManagerPercent,
      line.lockManagerPercent),
  ];
}

// 3.2 item 4: the 30-user baseline of a batch against the previous batch's. Void when it moved more than BASELINE_DRIFT.
export function baselineValid(previousP95Ms, currentP95Ms, drift = BASELINE_DRIFT) {
  if (!Number.isFinite(previousP95Ms) || !Number.isFinite(currentP95Ms) || previousP95Ms <= 0) return { valid: null, drift: null };
  const moved = Math.abs(currentP95Ms - previousP95Ms) / previousP95Ms;
  return { valid: moved <= drift, drift: Number(moved.toFixed(3)) };
}

// How many users a stage can hold when the pass line is missed: the largest stage that passed, with the gap written out, never "made it".
export function capacityWords(stages) {
  const passed = stages.filter(s => s.checks.every(c => c.ok));
  const best = passed.length ? Math.max(...passed.map(s => s.vus)) : 0;
  const missed = c => `${c.name} ${c.known ? c.value : 'unknown'} (limit ${c.limit})`;
  const failing = stages.filter(s => !s.checks.every(c => c.ok)).map(s => `${s.vus} users: ${s.checks.filter(c => !c.ok).map(missed).join(', ')}`);
  return { bestPassedUsers: best, failing };
}
