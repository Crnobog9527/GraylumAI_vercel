/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure parts of the Vercel-side connection measurement (CORE-PATH-V2 final 100-user validation): the summary of the per-second
// pg_stat_activity samples, the pass lines against the database's own limits, and the reading of the fixed per-turn overhead from
// a one-user calibration. No network, no clock, no files.

// Pass lines for connections. Plan 3.1 has none; these are the ones the run plan states (docs/validation/core-path-v2/vercel-run-plan.md).
export const CONNECTION_LINE = {
  totalOfUsablePercent: 75, // peak client connections / (max_connections - superuser_reserved_connections): leaves room for admin, migrations and auth
  idleInTransactionSeconds: 5, // no session may sit idle inside an open transaction longer than this
  postgrestAssumedPool: 8, // the staging db_pool when the management API could not be read
};
export const POSTGREST_ROLE = 'authenticator';

// sample: { t, rows: [{ usename, application_name, state, backend_type, n }], idleInTxMaxSeconds }; limits: { maxConnections, reserved, ... }
const clientRows = sample => (sample.rows ?? []).filter(r => r.backend_type === 'client backend');
const totalOf = rows => rows.reduce((sum, r) => sum + Number(r.n), 0);

export function summarizeConnections(samples, limits = {}) {
  let peakTotal = 0, peakActive = 0, idleInTxMax = 0;
  const peakByRole = {}, peakByApp = {};
  for (const sample of samples) {
    const rows = clientRows(sample);
    peakTotal = Math.max(peakTotal, totalOf(rows));
    peakActive = Math.max(peakActive, totalOf(rows.filter(r => r.state === 'active')));
    idleInTxMax = Math.max(idleInTxMax, Number(sample.idleInTxMaxSeconds) || 0);
    const role = {}, app = {};
    for (const r of rows) {
      role[r.usename ?? '?'] = (role[r.usename ?? '?'] ?? 0) + Number(r.n);
      const key = `${r.usename ?? '?'}/${r.application_name || '-'}`;
      app[key] = (app[key] ?? 0) + Number(r.n);
    }
    for (const [k, v] of Object.entries(role)) peakByRole[k] = Math.max(peakByRole[k] ?? 0, v);
    for (const [k, v] of Object.entries(app)) peakByApp[k] = Math.max(peakByApp[k] ?? 0, v);
  }
  return { samples: samples.length, peakTotal, peakActive, idleInTxMaxSeconds: Number(idleInTxMax.toFixed(1)), peakByRole, peakByApp, limits };
}

// Unknown values are not passes: a missing sample or limit makes the line fail with known:false.
export function judgeConnections(summary, line = CONNECTION_LINE) {
  const { maxConnections, reserved = 0, postgrestPool } = summary.limits ?? {};
  const usable = Number.isFinite(maxConnections) ? maxConnections - reserved : null;
  const measured = summary.samples > 0;
  const check = (name, value, ok, limit) => ({ name, value, limit, ok: value === null || value === undefined ? false : ok, known: value !== null && value !== undefined });
  const pool = Number.isFinite(postgrestPool) ? postgrestPool : line.postgrestAssumedPool;
  const postgrest = summary.peakByRole[POSTGREST_ROLE];
  return [
    check(`peak client connections vs ${line.totalOfUsablePercent}% of usable`, measured && usable ? summary.peakTotal : null,
      usable !== null && summary.peakTotal <= (usable * line.totalOfUsablePercent) / 100, usable === null ? null : Math.floor((usable * line.totalOfUsablePercent) / 100)),
    check(`PostgREST (${POSTGREST_ROLE}) peak vs db_pool${Number.isFinite(postgrestPool) ? '' : ' (assumed)'}`, measured ? postgrest ?? 0 : null, (postgrest ?? 0) <= pool, pool),
    check('idle in transaction seconds', measured ? summary.idleInTxMaxSeconds : null, summary.idleInTxMaxSeconds <= line.idleInTransactionSeconds, line.idleInTransactionSeconds),
  ];
}

// One-user calibration (no contention): what a turn costs on its own beyond the stub's own reply time.
// stubSeconds: first byte + chunks x interval of the stub (6 s for chat). Thresholds follow the 11-01 report (fixed ~9 s, line = reply + 2 s).
export function classifyFixedOverhead({ p50Ms, stubSeconds, lineSeconds = 2, roundTripMs = null }) {
  if (!Number.isFinite(p50Ms)) return { overheadSeconds: null, reading: 'not measured' };
  const overheadSeconds = Number((p50Ms / 1000 - stubSeconds).toFixed(2));
  const reading = overheadSeconds <= lineSeconds ? 'within the line: the 11-01 fixed ~9 s was the local round trip, not the app'
    : overheadSeconds <= 5 ? 'between the line and 5 s: partly the local round trip, partly app work; run a staged re-measure before deciding'
      : 'above 5 s with one user: not concurrency and not the driver\'s distance; it is serial work inside the turn (needs app-side timing)';
  return { overheadSeconds, reading, roundTripMs };
}
