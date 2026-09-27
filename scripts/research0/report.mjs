// Console report for RESEARCH-0. Contains no raw response bodies and no keys.

import { NOT_PROVIDED } from './metrics.mjs';

function usd(value) {
  return Number.isFinite(value) ? `$${value.toFixed(4)}` : NOT_PROVIDED;
}

function planLines(vendor) {
  if (vendor.plan.lines.length === 0) return [];
  const lines = [`  plan: worst case ${usd(vendor.plan.worstCaseUsd)} for the selected queries`];
  for (const line of vendor.plan.lines) {
    if (line.notSupported) lines.push(`    ${line.queryId} NOT_SUPPORTED ${line.notSupported}`);
    else if (line.dependent) lines.push(`    ${line.queryId} (dependent step, built from the previous response) ≤ ${usd(line.worstCaseUsd)}`);
    else lines.push(`    ${line.queryId} ${line.method} ${line.url} ≤ ${usd(line.worstCaseUsd)}`);
  }
  return lines;
}

function queryLine(query) {
  const parts = [`    ${query.queryId} ${query.status}`];
  if (query.reason) parts.push(`reason=${query.reason}`);
  if (Number.isFinite(query.latencyMs)) parts.push(`latency=${query.latencyMs}ms`);
  for (const call of query.calls ?? []) {
    const raw = call.reportedRaw ? ` (${call.reportedRaw})` : '';
    parts.push(`[http=${call.httpStatus ?? '-'} reported=${usd(call.reportedCostUsd)}${raw} booked=${usd(call.chargedUsd)} ${call.costBasis}]`);
  }
  if (query.metrics) {
    parts.push(`items=${query.metrics.itemCount} newest=${query.metrics.newestPublishedAt}`);
    parts.push(`provided=${query.metrics.provided.join('|') || '-'} missing=${query.metrics.missing.join('|') || '-'}`);
  }
  if (query.normalizeError) parts.push(`normalize=${query.normalizeError}`);
  return parts.join(' ');
}

export function formatReport(report) {
  const lines = [`mode: ${report.mode} at ${report.generatedAt}`];
  for (const vendor of report.vendors) {
    const key = vendor.keyPresent ? 'key present' : 'key missing';
    lines.push(`- ${vendor.label} (${vendor.id}): ${key}${vendor.blockedReason ? `, blocked: ${vendor.blockedReason}` : ''}`);
    lines.push(...planLines(vendor));
    if (vendor.balance) {
      const { beforeUsd, afterUsd, spentThisRunUsd } = vendor.balance;
      lines.push(`  vendor balance: before ${usd(beforeUsd)}, after ${usd(afterUsd)}, spent this run ${usd(spentThisRunUsd)}`);
    }
    if (vendor.usage) lines.push(`  ledger: ${vendor.usage.calls} calls, ${usd(vendor.usage.usd)} booked (all runs)`);
    for (const query of vendor.queries) if (query.status !== 'DRY_RUN') lines.push(queryLine(query));
  }
  return lines.join('\n');
}
