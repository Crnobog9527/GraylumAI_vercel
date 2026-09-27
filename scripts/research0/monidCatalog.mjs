// monid catalogue phase (Owner decision 2026-09-28, option a): at most 6 calls
// booked at 0.05 USD each (0.30 USD). Discover calls reveal per-tool prices;
// wallet balance reads bracket them so the real charge is measured. Any
// failure, unreadable balance or larger-than-allowed drop stops the phase.

import path from 'node:path';
import { callOnce } from './runner.mjs';
import { redactHeaders, redactText, redactUrl, refusal, requestKey, reserve, settle, writeRedactedJson } from './safety.mjs';

const BASE = 'https://api.monid.ai/v1';
export const MONID_CATALOG_LIMITS = { vendorId: 'monid', maxCalls: 6, maxUsd: 0.3 };
const WORST_CASE_USD = 0.05;

export const MONID_CATALOG_PLAN = [
  { label: 'BALANCE_0', kind: 'balance' },
  { label: 'DISCOVER_CN', kind: 'discover', query: 'Douyin Xiaohongshu Bilibili Weibo Kuaishou user profile, user posts, keyword search', limit: 40 },
  { label: 'BALANCE_1', kind: 'balance', maxDropUsd: 0.05 },
  { label: 'DISCOVER_GLOBAL', kind: 'discover', query: 'TikTok YouTube Instagram X Twitter user profile, user posts, keyword search', limit: 40 },
  { label: 'DISCOVER_WEB', kind: 'discover', query: 'general web search results', limit: 20 },
  { label: 'BALANCE_2', kind: 'balance', maxDropUsd: 0.1 },
];

function request(step, key) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  if (step.kind === 'balance') return { url: `${BASE}/wallet/balance`, init: { method: 'GET', headers } };
  return {
    url: `${BASE}/discover`,
    init: { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: step.query, limit: step.limit }) },
  };
}

function parse(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function balanceOf(json) {
  const value = json?.balance?.value;
  return typeof value === 'number' && Number.isFinite(value) && json?.balance?.currency === 'USD' ? value : null;
}

function tools(json) {
  if (!Array.isArray(json?.results)) return null;
  return json.results.map(result => ({
    provider: result?.provider,
    endpoint: result?.endpoint,
    description: typeof result?.description === 'string' ? result.description.slice(0, 160) : undefined,
    tags: Array.isArray(result?.tags) ? result.tags.slice(0, 8) : undefined,
    priceType: result?.price?.type,
    priceUsd: result?.price?.amount?.currency === 'USD' ? result?.price?.amount?.value : undefined,
    flatFeeUsd: result?.price?.flatFee?.value,
  }));
}

/** Runs the catalogue phase. Stops at the first step that cannot be verified. */
export async function runMonidCatalog({ key, fetchImpl, ledger, outDir, now = () => new Date(), timeoutMs = 60_000 }) {
  const secrets = [key];
  const report = { generatedAt: now().toISOString(), mode: 'monid-catalog', steps: [], balances: [], tools: [], stopped: null };
  let lastBalance = null;
  const runId = `${report.generatedAt}#${process.pid}`;
  for (const step of MONID_CATALOG_PLAN) {
    const { url, init } = request(step, key);
    // Discover requests are keyed by substance; balance reads are scoped to this run.
    const scope = step.kind === 'balance' ? `${step.label}@${runId}` : '';
    const stepKey = requestKey('monid', { method: init.method, url, body: init.body }, scope);
    const refused = refusal(ledger, MONID_CATALOG_LIMITS, WORST_CASE_USD, { key: stepKey });
    if (refused) {
      report.stopped = { at: step.label, reason: refused };
      break;
    }
    const record = await reserve(ledger, {
      vendor: 'monid', queryId: step.label, step: 0, at: now().toISOString(), worstCaseUsd: WORST_CASE_USD, requestKey: stepKey,
    });
    const result = await callOnce(fetchImpl, { url, init }, timeoutMs);
    const json = parse(result.body);
    const ok = result.outcome === 'ok' && json !== undefined;
    await settle(ledger, record, { outcome: ok ? 'ok' : result.outcome === 'unknown' ? 'unknown' : 'failed', reportedUsd: null });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    await writeRedactedJson(path.join(outDir, 'raw', 'monid', `${step.label}-${stamp}.json`), {
      request: { method: init.method, url: redactUrl(url, secrets), headers: redactHeaders(init.headers, secrets), body: init.body },
      response: { outcome: result.outcome, reason: result.reason, httpStatus: result.httpStatus, headers: redactHeaders(result.headers, secrets),
        body: json === undefined ? redactText(result.body ?? '', secrets) : JSON.parse(redactText(JSON.stringify(json), secrets)) },
      latencyMs: result.latencyMs,
    }, secrets);
    report.steps.push({ label: step.label, outcome: result.outcome, httpStatus: result.httpStatus, reason: result.reason, latencyMs: result.latencyMs });
    if (!ok) {
      report.stopped = { at: step.label, reason: result.reason ?? `HTTP_${result.httpStatus ?? 'NONE'}_OR_UNPARSABLE` };
      break;
    }
    if (step.kind === 'balance') {
      const balance = balanceOf(json);
      if (balance === null) {
        report.stopped = { at: step.label, reason: 'BALANCE_UNREADABLE' };
        break;
      }
      const dropUsd = lastBalance === null ? null : Math.round((lastBalance - balance) * 1e6) / 1e6;
      report.balances.push({ label: step.label, balanceUsd: balance, dropSincePreviousUsd: dropUsd });
      if (dropUsd !== null && (dropUsd > step.maxDropUsd || dropUsd < 0)) {
        report.stopped = { at: step.label, reason: dropUsd < 0 ? 'BALANCE_ROSE_UNEXPECTEDLY' : 'CHARGE_ABOVE_ALLOWED' };
        break;
      }
      lastBalance = balance;
      continue;
    }
    const found = tools(json);
    if (found === null) {
      report.stopped = { at: step.label, reason: 'NO_RESULTS_ARRAY' };
      break;
    }
    report.tools.push(...found.map(tool => ({ ...tool, from: step.label })));
  }
  const first = report.balances[0]?.balanceUsd;
  const last = report.balances.at(-1)?.balanceUsd;
  report.spentUsd = Number.isFinite(first) && Number.isFinite(last) ? Math.round((first - last) * 1e6) / 1e6 : null;
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  await writeRedactedJson(path.join(outDir, `monid-catalog-${stamp}.json`), report, secrets);
  return report;
}

export function formatMonidCatalog(report) {
  const lines = [`monid catalogue: ${report.steps.length} calls, stopped: ${report.stopped ? `${report.stopped.at} ${report.stopped.reason}` : 'no'}`];
  for (const balance of report.balances) lines.push(`  ${balance.label} balance $${balance.balanceUsd} drop ${balance.dropSincePreviousUsd ?? '-'}`);
  lines.push(`  measured spend: ${report.spentUsd ?? '未提供'} USD`);
  lines.push('| 来源 | provider | endpoint | 计价方式 | 单价 USD | 固定费 USD | 标签 |', '|---|---|---|---|---|---|---|');
  for (const tool of report.tools) {
    const cells = [tool.from, tool.provider, tool.endpoint, tool.priceType, tool.priceUsd ?? '未提供', tool.flatFeeUsd ?? '未提供', (tool.tags ?? []).join(' ')];
    lines.push(`| ${cells.map(value => String(value ?? '未提供').replace(/\|/g, '\\|')).join(' | ')} |`);
  }
  return lines.join('\n');
}
