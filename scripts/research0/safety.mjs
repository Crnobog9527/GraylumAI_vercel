// RESEARCH-0 spend ledger and secret redaction. Standalone tooling: never
// imported by application code, no database, no credits, no dependencies.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Owner authorization 2026-09-28: at most 1 USD per vendor, 5 USD in total. */
export const VENDOR_CAP_USD = 1;
export const TOTAL_CAP_USD = 5;

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'apikey',
  'x-api-token',
  'x-access-token',
  'x-auth-token',
  'cookie',
  'set-cookie',
]);
const SENSITIVE_PARAMS = new Set(['key', 'api_key', 'apikey', 'api-key', 'token', 'access_token', 'auth', 'authorization']);
const MASK = '[REDACTED]';

/** Replace every occurrence of every secret. Secrets are compared literally. */
export function redactText(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) out = out.split(secret).join(MASK);
  }
  return out;
}

export function redactUrl(url, secrets) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return redactText(url, secrets);
  }
  for (const name of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_PARAMS.has(name.toLowerCase())) parsed.searchParams.set(name, MASK);
  }
  if (parsed.username || parsed.password) {
    parsed.username = '';
    parsed.password = '';
  }
  return redactText(parsed.toString(), secrets);
}

export function redactHeaders(headers, secrets) {
  const out = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    out[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? MASK : redactText(value, secrets);
  }
  return out;
}

/** Last line of defence before anything is printed or written to disk. */
export function assertNoSecret(serialized, secrets) {
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0 && serialized.includes(secret)) {
      throw new Error('RESEARCH0_SECRET_LEAK_BLOCKED');
    }
  }
  return serialized;
}

export async function writeRedactedJson(file, value, secrets) {
  const serialized = assertNoSecret(JSON.stringify(value, null, 2), secrets);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${serialized}\n`, { mode: 0o600 });
  await rename(temp, file);
}

/**
 * Persistent ledger outside the repository. Every dispatched call is recorded
 * with its worst-case charge *before* the request leaves, so a crash, timeout
 * or rerun can never forget money that may already be spent.
 */
export async function loadLedger(file, { requireExisting = false } = {}) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    // A paid run never treats a missing ledger as "nothing spent yet".
    if (error?.code === 'ENOENT' && !requireExisting) return { file, entries: [] };
    throw new Error(error?.code === 'ENOENT' ? 'RESEARCH0_LEDGER_MISSING' : 'RESEARCH0_LEDGER_UNREADABLE');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('RESEARCH0_LEDGER_UNREADABLE');
  }
  if (data?.version !== 1 || !Array.isArray(data.entries)) throw new Error('RESEARCH0_LEDGER_UNREADABLE');
  const bad = data.entries.findIndex(entry => !validEntry(entry));
  if (bad !== -1) throw new Error(`RESEARCH0_LEDGER_UNREADABLE: entry ${bad} is malformed`);
  if (!validTotal(data.entries)) throw new Error('RESEARCH0_LEDGER_UNREADABLE: total is not a finite non-negative amount');
  return { file, entries: data.entries };
}

const nonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nonEmpty = value => typeof value === 'string' && value.length > 0;

/** Every entry must carry its identity and finite, non-negative amounts, or no cap check can be trusted. */
export function validEntry(entry) {
  return Boolean(entry) && nonEmpty(entry.vendor) && nonEmpty(entry.requestKey)
    && nonNegative(entry.chargedUsd) && nonNegative(entry.worstCaseUsd)
    && (entry.state === 'dispatched' || entry.state === 'settled');
}

function validTotal(entries) {
  return nonNegative(entries.reduce((total, entry) => total + entry.chargedUsd, 0));
}

/** Creates the empty ledger once; refuses to overwrite an existing one. */
export async function initLedger(file) {
  await mkdir(path.dirname(file), { recursive: true });
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    throw new Error(error?.code === 'EEXIST' ? 'RESEARCH0_LEDGER_EXISTS' : 'RESEARCH0_LEDGER_UNWRITABLE');
  }
  try {
    await handle.writeFile(`${JSON.stringify({ version: 1, entries: [] }, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

/**
 * Exclusive run lock next to the ledger. An existing lock refuses the run;
 * the lock is removed only after a clean finish, so a crash leaves it for a
 * person to inspect (it records the pid and start time).
 */
export async function acquireLock(dir, now = () => new Date()) {
  const file = path.join(dir, 'ledger.lock');
  await mkdir(dir, { recursive: true });
  let handle;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    throw new Error(error?.code === 'EEXIST' ? `RESEARCH0_LEDGER_LOCKED: ${file}` : 'RESEARCH0_LOCK_UNWRITABLE');
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: now().toISOString() })}\n`);
  } finally {
    await handle.close();
  }
  return { file, release: () => rm(file) };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])]));
  }
  return value;
}

/**
 * Identity of a request's substance: vendor, method, URL with sorted query
 * parameters and canonical body. Renaming a query id cannot bypass it.
 * `scope` separates deliberately repeatable reads (balance per run).
 */
export function requestKey(vendorId, spec, scope = '') {
  const url = new URL(spec.url);
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAMS.has(name.toLowerCase())) url.searchParams.delete(name);
  }
  url.searchParams.sort();
  const body = spec.body === undefined ? null : canonical(typeof spec.body === 'string' ? JSON.parse(spec.body) : spec.body);
  const material = JSON.stringify([vendorId, (spec.method ?? 'GET').toUpperCase(), url.toString(), body, scope]);
  return createHash('sha256').update(material).digest('hex');
}

async function saveLedger(ledger) {
  await writeRedactedJson(ledger.file, { version: 1, entries: ledger.entries }, []);
}

export function vendorUsage(ledger, vendorId) {
  const entries = ledger.entries.filter(entry => entry.vendor === vendorId);
  return { calls: entries.length, usd: sum(entries.map(entry => entry.chargedUsd)) };
}

export function totalUsage(ledger) {
  return { calls: ledger.entries.length, usd: sum(ledger.entries.map(entry => entry.chargedUsd)) };
}

function sum(values) {
  return Math.round(values.reduce((acc, value) => acc + value, 0) * 1e6) / 1e6;
}

/**
 * Returns null when the call may be sent, otherwise the refusal reason. A zero
 * price is accepted only when the vendor documents the endpoint as free.
 */
export function refusal(ledger, limits, worstCaseUsd, { documentedFree = false, key } = {}) {
  if (typeof key !== 'string' || key.length === 0) return 'REQUEST_KEY_MISSING';
  // Re-checked here as well: an in-memory ledger with a broken amount must never pass a cap check.
  if (!validTotal(ledger.entries) || ledger.entries.some(entry => !nonNegative(entry.chargedUsd))) return 'LEDGER_TOTAL_INVALID';
  // Any earlier attempt (succeeded, failed, unknown or never settled) needs a
  // person to reconcile it; the same paid request is never sent twice.
  if (ledger.entries.some(entry => entry.requestKey === key)) return 'ALREADY_ATTEMPTED';
  if (!Number.isFinite(worstCaseUsd) || worstCaseUsd < 0) return 'PRICE_UNKNOWN';
  if (worstCaseUsd === 0 && !documentedFree) return 'PRICE_UNKNOWN';
  const used = vendorUsage(ledger, limits.vendorId);
  if (used.calls >= limits.maxCalls) return 'CALL_LIMIT_REACHED';
  if (used.usd + worstCaseUsd > Math.min(limits.maxUsd, VENDOR_CAP_USD) + 1e-9) return 'VENDOR_USD_LIMIT_REACHED';
  if (totalUsage(ledger).usd + worstCaseUsd > TOTAL_CAP_USD + 1e-9) return 'TOTAL_USD_LIMIT_REACHED';
  return null;
}

export async function reserve(ledger, entry) {
  const record = { ...entry, state: 'dispatched', chargedUsd: entry.worstCaseUsd, basis: 'worst-case-reserve' };
  ledger.entries.push(record);
  await saveLedger(ledger);
  return record;
}

/**
 * A vendor-reported cost replaces the reserve. Otherwise the worst case stays
 * booked: unknown outcomes and HTTP failures are treated as possibly charged.
 */
export async function settle(ledger, record, { outcome, reportedUsd }) {
  record.state = 'settled';
  record.outcome = outcome;
  if (Number.isFinite(reportedUsd) && reportedUsd >= 0) {
    record.chargedUsd = reportedUsd;
    record.basis = 'vendor-reported';
  } else {
    record.basis = 'estimate-worst-case';
  }
  await saveLedger(ledger);
}
