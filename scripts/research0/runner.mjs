// RESEARCH-0 runner: dry run by default, one attempt per request, spend caps
// checked and booked before every dispatch.

import path from 'node:path';
import { summarize } from './metrics.mjs';
import {
  VENDOR_CAP_USD,
  redactHeaders,
  redactText,
  redactUrl,
  refusal,
  requestKey,
  reserve,
  settle,
  vendorUsage,
  writeRedactedJson,
} from './safety.mjs';

export const DEFAULT_TIMEOUT_MS = 60_000;
const STOPPING_REFUSALS = new Set(['CALL_LIMIT_REACHED', 'VENDOR_USD_LIMIT_REACHED', 'TOTAL_USD_LIMIT_REACHED']);
const UNRECONCILED = 'VENDOR_HAS_UNRECONCILED_ATTEMPT';

function describeSpec(spec, secrets) {
  return {
    method: spec.method ?? 'GET',
    url: redactUrl(spec.url, secrets),
    headers: redactHeaders(spec.headers, secrets),
    body: spec.body === undefined ? undefined : JSON.parse(redactText(JSON.stringify(spec.body), secrets)),
  };
}

/**
 * Exactly one fetch. Timeouts, aborted connections and unreadable bodies are
 * "unknown": the request may have been billed and is never re-sent.
 * Error messages are dropped because they can echo the request URL.
 */
export async function callOnce(fetchImpl, { url, init }, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'manual' });
    const body = await response.text();
    const headers = Object.fromEntries(response.headers?.entries?.() ?? []);
    const outcome = response.status >= 200 && response.status < 300 ? 'ok' : 'failed';
    return { outcome, httpStatus: response.status, body, headers, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_OR_READ_ERROR';
    return { outcome: 'unknown', reason, latencyMs: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

/** The documented variable first, then an explicitly listed alias (e.g. a lower-case name). */
export function keyFor(vendor, env) {
  for (const name of [vendor.keyEnv, ...(vendor.keyEnvAliases ?? [])]) {
    if (typeof env[name] === 'string' && env[name].length > 0) return env[name];
  }
  return undefined;
}

function keyOf(vendorId, spec, scope) {
  try {
    return requestKey(vendorId, spec, scope);
  } catch {
    return null;
  }
}

function parseJson(body) {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function stepsFor(vendor, query) {
  const steps = vendor.steps(query);
  if (!Array.isArray(steps)) return { notSupported: steps?.notSupported ?? 'NOT_SUPPORTED' };
  return { steps };
}

export function planVendor(vendor, queries, secrets = []) {
  const lines = [];
  let worstCaseUsd = 0;
  for (const query of queries) {
    const planned = stepsFor(vendor, query);
    if (planned.notSupported) {
      lines.push({ queryId: query.id, notSupported: planned.notSupported });
      continue;
    }
    for (const step of planned.steps) {
      if (typeof step === 'function') {
        lines.push({ queryId: query.id, dependent: true, worstCaseUsd: vendor.dependentWorstCaseUsd ?? null });
        worstCaseUsd += vendor.dependentWorstCaseUsd ?? 0;
      } else {
        lines.push({ queryId: query.id, ...describeSpec(step, secrets), worstCaseUsd: step.worstCaseUsd });
        worstCaseUsd += step.worstCaseUsd ?? 0;
      }
    }
  }
  // A vendor with nothing runnable sends nothing at all, balance reads included.
  const runnable = lines.some(line => !line.notSupported);
  if (runnable && vendor.balance && !vendor.blockedReason) {
    // Balance reads are real requests too, so the plan lists them where the run sends them.
    const balance = { ...describeSpec(vendor.balance.spec(), secrets), worstCaseUsd: vendor.balance.spec().worstCaseUsd };
    lines.unshift({ queryId: 'BALANCE_BEFORE', ...balance });
    lines.push({ queryId: 'BALANCE_AFTER', ...balance });
    worstCaseUsd += 2 * (balance.worstCaseUsd ?? 0);
  }
  return { vendor: vendor.id, lines, runnable, worstCaseUsd: Math.round(worstCaseUsd * 1e6) / 1e6 };
}

async function saveRaw(context, { vendor, query, stepIndex, spec, result, secrets }) {
  const stamp = context.now().toISOString().replace(/[:.]/g, '-');
  const file = path.join(context.outDir, 'raw', vendor.id, `${query.id}-step${stepIndex}-${stamp}.json`);
  const parsed = parseJson(result.body);
  const body = parsed === undefined ? redactText(result.body ?? '', secrets) : JSON.parse(redactText(JSON.stringify(parsed), secrets));
  const record = {
    vendor: vendor.id,
    queryId: query.id,
    request: describeSpec(spec, secrets),
    response: { outcome: result.outcome, reason: result.reason, httpStatus: result.httpStatus, headers: redactHeaders(result.headers, secrets), body },
    latencyMs: result.latencyMs,
  };
  await writeRedactedJson(file, record, secrets);
  return path.relative(context.outDir, file);
}

async function runQuery(context, vendor, query, key, secrets) {
  const planned = stepsFor(vendor, query);
  if (planned.notSupported) return { status: 'NOT_SUPPORTED', reason: planned.notSupported };
  const limits = { vendorId: vendor.id, maxCalls: vendor.maxCalls, maxUsd: vendor.maxUsd ?? VENDOR_CAP_USD };
  let previous;
  let last;
  let latencyMs = 0;
  const calls = [];
  for (const [index, step] of planned.steps.entries()) {
    const spec = typeof step === 'function' ? step(previous) : step;
    if (spec?.skip) return { status: 'NOT_RUN', reason: spec.skip, calls, latencyMs };
    const attemptKey = keyOf(vendor.id, spec);
    const refused = refusal(context.ledger, limits, spec.worstCaseUsd,
      { documentedFree: spec.documentedFree === true, key: attemptKey, retryConfirmedFailures: Boolean(context.retryReason) });
    if (refused === 'ALREADY_ATTEMPTED') return { status: 'NOT_RUN', reason: 'ALREADY_ATTEMPTED_NEEDS_RECONCILIATION', calls, latencyMs };
    if (refused?.startsWith(UNRECONCILED)) return { status: 'NOT_RUN', reason: refused, stopVendor: true, calls, latencyMs };
    if (refused) return { status: 'BUDGET_REFUSED', reason: refused, stopVendor: STOPPING_REFUSALS.has(refused), calls, latencyMs };
    // Booked (and written to disk) before dispatch; a failed write throws and nothing is sent.
    const record = await reserve(context.ledger, {
      vendor: vendor.id, queryId: query.id, step: index, at: context.now().toISOString(), worstCaseUsd: spec.worstCaseUsd, requestKey: attemptKey,
      // Only an actual re-send (an earlier attempt exists) consumes the one retry the switch allows.
      ...(context.retryReason && context.ledger.entries.some(entry => entry.requestKey === attemptKey)
        ? { retryReason: context.retryReason } : {}),
    });
    const result = await callOnce(context.fetchImpl, vendor.authorize(spec, key), vendor.timeoutMs ?? context.timeoutMs);
    const json = parseJson(result.body);
    let outcome = result.outcome;
    if (outcome === 'ok' && (json === undefined || vendor.isFailure?.(json, query))) outcome = 'failed';
    const reportedUsd = json === undefined ? null : vendor.reportedCostUsd?.(json, result.headers) ?? null;
    await settle(context.ledger, record, { outcome, reportedUsd });
    const rawFile = await saveRaw(context, { vendor, query, stepIndex: index, spec, result, secrets });
    latencyMs += result.latencyMs;
    const reportedRaw = json === undefined ? null : vendor.reportedRaw?.(json, result.headers) ?? null;
    calls.push({ outcome, httpStatus: result.httpStatus, reason: result.reason, latencyMs: result.latencyMs,
      reportedRaw, reportedCostUsd: reportedUsd, chargedUsd: record.chargedUsd, costBasis: record.basis, rawFile });
    // No retry and no fallback: a failed or unknown step ends this query.
    if (outcome !== 'ok') {
      // A rejected key (401/403) or an empty account (402) will reject every other request too.
      const accountRejected = [401, 402, 403].includes(result.httpStatus);
      return { status: outcome === 'unknown' ? 'UNKNOWN' : 'FAILED', reason: result.reason ?? vendor.failureReason?.(json), calls, latencyMs,
        ...(accountRejected ? { stopVendor: true, stopReason: `ACCOUNT_REJECTED_HTTP_${result.httpStatus}` } : {}) };
    }
    previous = json;
    last = json;
  }
  const kind = vendor.kind(query);
  try {
    return { status: 'OK', calls, latencyMs, kind, metrics: summarize(kind, vendor.normalize(last, query)) };
  } catch {
    // The call succeeded and is booked; only our field mapping did not fit.
    return { status: 'OK', calls, latencyMs, kind, metrics: summarize(kind, []), normalizeError: 'SHAPE_NOT_RECOGNIZED' };
  }
}

/**
 * Reads a documented-free account balance so the actual charge can be taken
 * from the vendor's own books. Booked in the ledger like any call.
 */
async function readBalance(context, vendor, key, secrets, label) {
  const spec = vendor.balance.spec();
  const limits = { vendorId: vendor.id, maxCalls: vendor.maxCalls, maxUsd: vendor.maxUsd ?? VENDOR_CAP_USD };
  // Balance reads are repeatable per run by design, so the run id scopes their key.
  const attemptKey = keyOf(vendor.id, spec, `${label}@${context.runId}`);
  if (refusal(context.ledger, limits, spec.worstCaseUsd, { documentedFree: spec.documentedFree === true, key: attemptKey })) return { value: null };
  const record = await reserve(context.ledger, {
    vendor: vendor.id, queryId: label, step: 0, at: context.now().toISOString(), worstCaseUsd: spec.worstCaseUsd, requestKey: attemptKey,
  });
  const result = await callOnce(context.fetchImpl, vendor.authorize(spec, key), vendor.timeoutMs ?? context.timeoutMs);
  const json = parseJson(result.body);
  // Only a documented-free balance read books zero; otherwise its worst case stays booked.
  await settle(context.ledger, record, { outcome: result.outcome, reportedUsd: spec.documentedFree === true ? 0 : null });
  await saveRaw(context, { vendor, query: { id: label }, stepIndex: 0, spec, result, secrets });
  // A rejected key or empty account stops the vendor before any query, like a rejected query would.
  if ([401, 402, 403].includes(result.httpStatus)) return { value: null, stopReason: `ACCOUNT_REJECTED_HTTP_${result.httpStatus}` };
  if (result.outcome !== 'ok' || json === undefined) return { value: null };
  const value = vendor.balance.read(json);
  return { value: Number.isFinite(value) ? value : null };
}

function balanceDelta(before, after) {
  if (before === null || after === null) return null;
  return Math.round((before - after) * 1e6) / 1e6;
}

/**
 * Runs the selected vendors. Without `live` nothing is sent, no ledger entry
 * is written and no file is saved; the plan is returned for printing.
 */
export async function runComparison({ vendors, queries, env, live, fetchImpl, ledger, outDir, now = () => new Date(), timeoutMs, retryReason = null }) {
  const secrets = vendors.map(vendor => keyFor(vendor, env)).filter(value => typeof value === 'string' && value.length > 0);
  const generatedAt = now().toISOString();
  const context = { fetchImpl, ledger, outDir, now, runId: `${generatedAt}#${process.pid}`, timeoutMs: timeoutMs ?? DEFAULT_TIMEOUT_MS, retryReason };
  const report = { generatedAt, mode: live ? 'live' : 'dry-run', vendors: [] };
  for (const vendor of vendors) {
    const key = keyFor(vendor, env);
    const keyPresent = typeof key === 'string' && key.length > 0;
    const plan = planVendor(vendor, queries, secrets);
    const entry = { id: vendor.id, label: vendor.label, keyPresent, blockedReason: vendor.blockedReason ?? null, plan, queries: [] };
    report.vendors.push(entry);
    let stopReason = null;
    const measureBalance = live && keyPresent && !vendor.blockedReason && vendor.balance && plan.runnable;
    const opening = measureBalance ? await readBalance(context, vendor, key, secrets, 'BALANCE_BEFORE') : { value: null };
    const before = opening.value;
    if (opening.stopReason) stopReason = opening.stopReason;
    for (const query of queries) {
      if (!live) entry.queries.push({ queryId: query.id, status: 'DRY_RUN' });
      else if (vendor.blockedReason) entry.queries.push({ queryId: query.id, status: 'NOT_RUN', reason: vendor.blockedReason });
      else if (!keyPresent) entry.queries.push({ queryId: query.id, status: 'NOT_RUN', reason: 'MISSING_KEY' });
      else if (stopReason) {
        const status = stopReason.startsWith(UNRECONCILED) || stopReason.startsWith('ACCOUNT_REJECTED') ? 'NOT_RUN' : 'BUDGET_REFUSED';
        entry.queries.push({ queryId: query.id, status, reason: stopReason });
      }
      else {
        const result = await runQuery(context, vendor, query, key, secrets);
        if (result.stopVendor) stopReason = result.stopReason ?? result.reason;
        delete result.stopVendor;
        delete result.stopReason;
        entry.queries.push({ queryId: query.id, ...result });
      }
    }
    // Once the account is known to reject requests, the closing balance read is skipped too.
    if (measureBalance && !stopReason?.startsWith('ACCOUNT_REJECTED')) {
      const after = (await readBalance(context, vendor, key, secrets, 'BALANCE_AFTER')).value;
      entry.balance = { beforeUsd: before, afterUsd: after, spentThisRunUsd: balanceDelta(before, after) };
    }
    entry.usage = live ? vendorUsage(ledger, vendor.id) : null;
  }
  if (live) {
    const stamp = now().toISOString().replace(/[:.]/g, '-');
    await writeRedactedJson(path.join(outDir, `summary-${stamp}.json`), report, secrets);
  }
  return report;
}
