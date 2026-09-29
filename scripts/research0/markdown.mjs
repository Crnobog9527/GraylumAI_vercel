// Markdown tables for the PR from a run or reanalyze report. Only derived
// metrics: no raw bodies, no URLs with parameters, no keys.

import { markdownCell as cell } from './markdownCell.mjs';
import { NOT_PROVIDED } from './metrics.mjs';

function usd(value) {
  return Number.isFinite(value) ? `$${value.toFixed(4)}` : NOT_PROVIDED;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function statusCounts(queries) {
  const counts = {};
  for (const query of queries) counts[query.status] = (counts[query.status] ?? 0) + 1;
  return Object.entries(counts).map(([status, n]) => `${status} ${n}`).join(', ');
}

// Offline re-analysis cannot know a column: say so instead of printing 0 or "未提供".
const OFFLINE = '离线重算不适用';

function vendorRow(vendor, offline) {
  const calls = vendor.queries.flatMap(query => query.calls ?? []);
  const sent = calls.length;
  // An accepted async run (monid 202) is neither a success nor a failure; its result is a later call.
  const failed = calls.filter(call => call.outcome !== 'ok' && call.outcome !== 'accepted').length;
  const reported = calls.filter(call => Number.isFinite(call.reportedCostUsd));
  const reportsCost = sent === 0 ? NOT_PROVIDED : reported.length === sent ? '是' : reported.length === 0 ? '否' : `部分（${reported.length}/${sent}）`;
  const latency = median(calls.map(call => call.latencyMs));
  return [
    vendor.label,
    statusCounts(vendor.queries),
    sent,
    sent === 0 ? NOT_PROVIDED : `${failed}/${sent}`,
    latency === null ? NOT_PROVIDED : `${latency} ms`,
    reportsCost,
    vendor.usage ? vendor.usage.calls : offline ? OFFLINE : NOT_PROVIDED,
    vendor.usage ? usd(vendor.usage.usd) : offline ? OFFLINE : NOT_PROVIDED,
    offline ? OFFLINE : usd(vendor.balance?.spentThisRunUsd),
  ];
}

function queryCell(query) {
  if (!query) return '';
  if (query.status !== 'OK') return `${query.status}${query.reason ? `（${query.reason}）` : ''}`;
  const metrics = query.metrics;
  const parts = [`OK ${metrics.itemCount} 条`];
  if (metrics.newestPublishedAt !== NOT_PROVIDED) parts.push(`最新 ${metrics.newestPublishedAt.slice(0, 10)}`);
  else if (query.kind !== 'profile') parts.push('发布时间未提供');
  if (Number.isFinite(query.latencyMs)) parts.push(`${query.latencyMs} ms`);
  if (query.normalizeError) parts.push(query.normalizeError);
  return parts.join('，');
}

function fieldsCell(query) {
  if (!query || query.status !== 'OK') return '';
  const missing = query.metrics.missing;
  return missing.length === 0 ? '全部提供' : `未提供：${missing.join('、')}`;
}

function table(header, rows) {
  const lines = [`| ${header.map(cell).join(' | ')} |`, `|${header.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines.join('\n');
}

export function formatMarkdown(report, queries) {
  const vendors = report.vendors;
  const byQuery = id => vendors.map(vendor => vendor.queries.find(query => query.queryId === id));
  const out = [`运行模式：${report.mode}，生成时间 ${report.generatedAt}`, ''];
  out.push(table(
    ['供应商', '各查询结果', '查询调用（原始记录）', '失败或结果未知', '响应时间中位数', '响应带本次官方成本',
      '账本记录的调用（含余额和目录）', '账本累计记账（最坏情况）', '供应商余额差（本次）'],
    vendors.map(vendor => vendorRow(vendor, report.mode === 'reanalyze')),
  ));
  out.push('', table(
    ['查询', ...vendors.map(vendor => vendor.label)],
    queries.map(query => [`${query.id} ${query.platform}/${query.type}`, ...byQuery(query.id).map(queryCell)]),
  ));
  out.push('', table(
    ['查询（字段完整度）', ...vendors.map(vendor => vendor.label)],
    queries.map(query => [`${query.id} ${query.platform}/${query.type}`, ...byQuery(query.id).map(fieldsCell)]),
  ));
  return out.join('\n');
}
