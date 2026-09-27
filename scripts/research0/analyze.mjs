// Offline re-analysis of saved (already redacted) raw responses. Lets field
// mappings be corrected without sending another paid request.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { summarize } from './metrics.mjs';

async function latestRecord(dir, queryId) {
  let names;
  try {
    names = await readdir(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const matches = names.filter(name => name.startsWith(`${queryId}-step`) && name.endsWith('.json')).sort();
  if (matches.length === 0) return null;
  // File names end in an ISO timestamp, so the last one is the newest run's final step.
  return JSON.parse(await readFile(path.join(dir, matches.at(-1)), 'utf8'));
}

export async function reanalyze({ vendors, queries, outDir }) {
  const report = { generatedAt: new Date().toISOString(), mode: 'reanalyze', vendors: [] };
  for (const vendor of vendors) {
    const entry = { id: vendor.id, label: vendor.label, keyPresent: false, blockedReason: vendor.blockedReason ?? null,
      plan: { lines: [], worstCaseUsd: 0 }, queries: [] };
    report.vendors.push(entry);
    for (const query of queries) {
      const record = await latestRecord(path.join(outDir, 'raw', vendor.id), query.id);
      if (!record) {
        entry.queries.push({ queryId: query.id, status: 'NO_SAVED_RESPONSE' });
        continue;
      }
      const body = record.response?.body;
      const ok = record.response?.outcome === 'ok' && body && typeof body === 'object' && !vendor.isFailure?.(body, query);
      if (!ok) {
        entry.queries.push({ queryId: query.id, status: 'SAVED_FAILURE', reason: record.response?.reason ?? record.response?.httpStatus });
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
      entry.queries.push({ queryId: query.id, status: 'OK', latencyMs: record.latencyMs, kind, metrics: summarize(kind, items), normalizeError });
    }
  }
  return report;
}
