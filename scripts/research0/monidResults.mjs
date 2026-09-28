// monid result retrieval (Owner approval 2026-09-28, "同意取回 monid 结果").
// The approved monid runs came back 202 (async, already charged). This phase
// reads each run's result exactly once, re-sends Q01 with the corrected
// `queryParams` input, and reads the balance once: at most 11 calls, each
// booked at 0.01 USD. Results are saved as step 1 so --reanalyze picks them up.

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { callOnce } from './runner.mjs';
import { redactHeaders, redactText, redactUrl, refusal, requestKey, reserve, settle, writeRedactedJson } from './safety.mjs';

const BASE = 'https://api.monid.ai/v1';
const WORST_CASE_USD = 0.01;
export const MONID_RESULT_LIMITS = { vendorId: 'monid', maxCalls: 29, maxUsd: 1 };
export const MONID_RESULT_MAX_CALLS = 11;
const RUN_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Run ids of accepted (202) runs, taken from the saved step-0 responses. */
export async function acceptedRuns(outDir) {
  const dir = path.join(outDir, 'raw', 'monid');
  const runs = [];
  for (const name of (await readdir(dir)).filter(file => /^Q\d\d-step0-/.test(file)).sort()) {
    const record = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
    const runId = record.response?.body?.runId;
    if (record.response?.httpStatus === 202 && typeof runId === 'string' && RUN_ID.test(runId)) {
      runs.push({ queryId: name.slice(0, 3), runId });
    }
  }
  return runs;
}

function plan(runs, webQuery) {
  const steps = runs.map(run => ({
    label: run.queryId,
    spec: { method: 'GET', url: `${BASE}/runs/${run.runId}` },
    scope: `result:${run.runId}`,
  }));
  steps.push({
    label: 'Q01',
    spec: {
      method: 'POST',
      url: `${BASE}/run`,
      body: { provider: 'tinyfish', endpoint: '/search', input: { queryParams: { query: webQuery, language: 'zh' } } },
    },
    scope: '',
  });
  steps.push({ label: 'BALANCE_RESULTS', spec: { method: 'GET', url: `${BASE}/wallet/balance` }, scope: 'balance:results' });
  return steps.slice(0, MONID_RESULT_MAX_CALLS);
}

function init(spec, key) {
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  if (spec.body === undefined) return { method: spec.method, headers };
  return { method: spec.method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(spec.body) };
}

export async function runMonidResults({ key, fetchImpl, ledger, outDir, webQuery, now = () => new Date(), timeoutMs = 90_000 }) {
  const secrets = [key];
  const steps = plan(await acceptedRuns(outDir), webQuery);
  const report = { generatedAt: now().toISOString(), mode: 'monid-results', steps: [] };
  for (const step of steps) {
    const stepKey = requestKey('monid', step.spec, step.scope);
    const refused = refusal(ledger, MONID_RESULT_LIMITS, WORST_CASE_USD, { key: stepKey });
    if (refused) {
      report.steps.push({ label: step.label, status: 'NOT_RUN', reason: refused });
      continue;
    }
    const record = await reserve(ledger, {
      vendor: 'monid', queryId: `${step.label}-result`, step: 1, at: now().toISOString(), worstCaseUsd: WORST_CASE_USD, requestKey: stepKey,
    });
    const requestInit = init(step.spec, key);
    const result = await callOnce(fetchImpl, { url: step.spec.url, init: requestInit }, timeoutMs);
    let json;
    try {
      json = JSON.parse(result.body);
    } catch {
      json = undefined;
    }
    await settle(ledger, record, { outcome: result.outcome, reportedUsd: null });
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    const name = step.label.startsWith('BALANCE') ? `${step.label}-${stamp}.json` : `${step.label}-step1-${stamp}.json`;
    const body = json === undefined ? redactText(result.body ?? '', secrets) : JSON.parse(redactText(JSON.stringify(json), secrets));
    await writeRedactedJson(path.join(outDir, 'raw', 'monid', name), {
      vendor: 'monid', queryId: step.label,
      request: {
        method: requestInit.method, url: redactUrl(step.spec.url, secrets),
        headers: redactHeaders(requestInit.headers, secrets), body: step.spec.body,
      },
      response: { outcome: result.outcome, reason: result.reason, httpStatus: result.httpStatus, headers: redactHeaders(result.headers, secrets), body },
      latencyMs: result.latencyMs,
    }, secrets);
    report.steps.push({ label: step.label, status: json?.status ?? result.outcome, httpStatus: result.httpStatus, reason: result.reason });
  }
  return report;
}
