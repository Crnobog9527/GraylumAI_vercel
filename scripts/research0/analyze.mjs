// Offline re-analysis of saved (already redacted) raw responses. Lets field
// mappings be corrected without sending another paid request. Strictly
// read-only: no network, no lock, no ledger write. Call metadata is rebuilt
// from every saved record; the ledger is only read for booked totals.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { summarize } from './metrics.mjs';
import { loadLedger, vendorUsage } from './safety.mjs';

export const OFFLINE_NOT_APPLICABLE = '离线重算不适用';

async function recordsFor(dir, queryId) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  // File names end in an ISO timestamp; within a query, later steps and runs sort last.
  const matches = names.filter(name => name.startsWith(`${queryId}-step`) && name.endsWith('.json')).sort();
  return Promise.all(matches.map(async name => JSON.parse(await readFile(path.join(dir, name), 'utf8'))));
}

/** One call as the live run would have recorded it, rebuilt from its saved record. */
function callFrom(vendor, query, record) {
  const response = record.response ?? {};
  const body = response.body && typeof response.body === 'object' ? response.body : undefined;
  let outcome = response.outcome ?? 'unknown';
  // 202 = an async run was accepted (monid); its result is fetched by a later step.
  if (outcome === 'ok' && response.httpStatus === 202) outcome = 'accepted';
  else if (outcome === 'ok' && (body === undefined || vendor.isFailure?.(body, query))) outcome = 'failed';
  const reported = body === undefined ? null : vendor.reportedCostUsd?.(body, response.headers ?? {}) ?? null;
  return {
    outcome, httpStatus: response.httpStatus, reason: response.reason, latencyMs: record.latencyMs,
    reportedCostUsd: Number.isFinite(reported) ? reported : null,
    reportedRaw: body === undefined ? null : vendor.reportedRaw?.(body, response.headers ?? {}) ?? null,
  };
}

export async function reanalyze({ vendors, queries, outDir }) {
  const report = { generatedAt: new Date().toISOString(), mode: 'reanalyze', vendors: [] };
  let ledger = null;
  try {
    ledger = await loadLedger(path.join(outDir, 'ledger.json'), { requireExisting: true });
  } catch {
    ledger = null;
  }
  for (const vendor of vendors) {
    const entry = { id: vendor.id, label: vendor.label, keyPresent: false, blockedReason: vendor.blockedReason ?? null,
      plan: { lines: [], worstCaseUsd: 0 }, queries: [], usage: ledger ? vendorUsage(ledger, vendor.id) : null, balance: null };
    report.vendors.push(entry);
    for (const query of queries) {
      const records = await recordsFor(path.join(outDir, 'raw', vendor.id), query.id);
      if (records.length === 0) {
        entry.queries.push({ queryId: query.id, status: 'NO_SAVED_RESPONSE' });
        continue;
      }
      const calls = records.map(record => callFrom(vendor, query, record));
      const record = records.at(-1);
      const body = record.response?.body;
      const last = calls.at(-1);
      if (last.outcome === 'accepted') {
        entry.queries.push({ queryId: query.id, status: 'ACCEPTED_NO_RESULT', calls });
        continue;
      }
      if (last.outcome !== 'ok') {
        entry.queries.push({ queryId: query.id, status: 'SAVED_FAILURE', reason: record.response?.reason ?? record.response?.httpStatus, calls });
        continue;
      }
      const kind = vendor.kind(query);
      let items = [];
      let normalizeError;
      try {
        items = vendor.normalize(body, query);
      } catch {
        normalizeError = 'SHAPE_NOT_RECOGNIZED';
      }
      entry.queries.push({ queryId: query.id, status: 'OK', latencyMs: record.latencyMs, kind, metrics: summarize(kind, items), normalizeError, calls });
    }
  }
  return report;
}
