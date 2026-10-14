#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Read-only export of the off-database erasure manifest (migration 0227) for a backup restore.
// Runbook: docs/runbooks/DATA_ERASURE_BACKUP_RESTORE_REPLAY.md
//
//   node scripts/erasure-manifest-export.mjs                    # default dry run: counts only
//   node scripts/erasure-manifest-export.mjs --write out.json   # also write ids/kinds/times locally
//   node scripts/erasure-manifest-export.mjs --since 2026-10-01T00:00:00Z --write out.json
//
// Uses only Redis SCAN and MGET (no writes, no deletes, no TTL changes). Credentials come from
// UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL/KV_REST_API_TOKEN) and are
// never printed. Exits non-zero whenever the manifest cannot be read completely: do not reopen.
import { existsSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const PREFIX = 'graylum:erasure-manifest:';
export const KINDS = ['account', 'answer', 'session', 'artifact', 'content', 'library_document'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseArgs(argv) {
  const options = { write: null, since: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--write' && argv[i + 1]) options.write = argv[++i];
    else if (argv[i] === '--since' && argv[i + 1] && Number.isFinite(Date.parse(argv[i + 1]))) options.since = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${argv[i]}`);
  }
  return options;
}

export function credentials(env) {
  const pairs = [[env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN], [env.KV_REST_API_URL, env.KV_REST_API_TOKEN]];
  const pair = pairs.find(([url, token]) => url || token);
  if (!pair || !pair[0] || !pair[1]) throw new Error('Redis REST credentials are missing or incomplete');
  if (new URL(pair[0]).protocol !== 'https:') throw new Error('Redis REST URL must use https');
  return { url: pair[0].replace(/\/+$/, ''), token: pair[1] };
}

/** Only SCAN and MGET are ever sent. */
export function restClient({ url, token }, fetchImpl = fetch) {
  return async command => {
    if (!['SCAN', 'MGET'].includes(command[0])) throw new Error('Read-only client refuses this command');
    const response = await fetchImpl(url, { method: 'POST', body: JSON.stringify(command),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000) });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body || body.error || !('result' in body)) throw new Error(`Redis ${command[0]} failed (${response.status})`);
    return body.result;
  };
}

/** Validates each value strictly: exactly kind, targetId, profileId, confirmedAt. */
export function parseEntry(key, raw) {
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join() !== 'confirmedAt,kind,profileId,targetId') return null;
  const { kind, targetId, profileId, confirmedAt } = value;
  if (!KINDS.includes(kind) || !UUID.test(targetId) || !UUID.test(profileId)) return null;
  if (typeof confirmedAt !== 'string' || !Number.isFinite(Date.parse(confirmedAt))) return null;
  if (key !== `${PREFIX}${kind}:${targetId}`) return null;
  return { kind, targetId, profileId, confirmedAt };
}

/** Accounts first (they replay the full account erasure); single deletions of a closed
 * account are marked supersededByAccount, the rest follow in confirmation order. */
export function orderForReplay(entries) {
  const closed = new Set(entries.filter(e => e.kind === 'account').map(e => e.profileId));
  const time = e => Date.parse(e.confirmedAt);
  return [...entries].sort((a, b) => Number(b.kind === 'account') - Number(a.kind === 'account') || time(a) - time(b)
    || a.kind.localeCompare(b.kind) || a.targetId.localeCompare(b.targetId))
    .map(e => ({ ...e, supersededByAccount: e.kind !== 'account' && closed.has(e.profileId) }));
}

export async function readManifest(send, { since = null } = {}) {
  const keys = new Set();
  let cursor = '0';
  for (let pages = 0; ; pages++) {
    if (pages > 100000) throw new Error('SCAN did not finish');
    const [next, batch] = await send(['SCAN', cursor, 'MATCH', `${PREFIX}*`, 'COUNT', '500']);
    if (!Array.isArray(batch)) throw new Error('Unexpected SCAN response');
    for (const key of batch) keys.add(String(key));
    cursor = String(next);
    if (cursor === '0') break;
  }
  const sorted = [...keys].sort();
  const entries = [];
  let invalid = 0, vanished = 0;
  for (let i = 0; i < sorted.length; i += 100) {
    const chunk = sorted.slice(i, i + 100);
    const values = await send(['MGET', ...chunk]);
    if (!Array.isArray(values) || values.length !== chunk.length) throw new Error('Unexpected MGET response');
    values.forEach((raw, j) => {
      if (raw === null) { vanished++; return; }
      const entry = parseEntry(chunk[j], raw);
      if (!entry) invalid++;
      else if (!since || Date.parse(entry.confirmedAt) >= Date.parse(since)) entries.push(entry);
    });
  }
  return { entries: orderForReplay(entries), scanned: sorted.length, invalid, vanished };
}

export function summarize({ entries, scanned, invalid, vanished }) {
  const byKind = Object.fromEntries(KINDS.map(kind => [kind, entries.filter(e => e.kind === kind).length]));
  const times = entries.map(e => e.confirmedAt).sort((a, b) => Date.parse(a) - Date.parse(b));
  return { scanned, exported: entries.length, invalid, vanished, byKind,
    supersededByAccount: entries.filter(e => e.supersededByAccount).length,
    earliest: times[0] ?? null, latest: times.at(-1) ?? null };
}

/** Any key that cannot be read as a valid entry makes the export incomplete: never replay a partial list. */
export function exportProblem({ invalid, vanished }) {
  if (invalid) return 'Invalid manifest entries found; investigate before replay';
  if (vanished) return 'Manifest keys disappeared between SCAN and MGET; export is incomplete, run it again';
  return null;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await readManifest(restClient(credentials(process.env)), options);
  const summary = { mode: options.write ? 'write' : 'dry-run', since: options.since, ...summarize(result) };
  const problem = exportProblem(result);
  if (problem) {
    console.log(JSON.stringify(summary, null, 2));
    throw new Error(problem);
  }
  if (options.write) {
    if (existsSync(options.write)) throw new Error('Output file already exists; refusing to overwrite');
    writeFileSync(options.write, JSON.stringify({ format: 'graylum-erasure-manifest-v1', exportedAt: new Date().toISOString(),
      since: options.since, entries: result.entries }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`erasure manifest export failed: ${error.message}`); process.exitCode = 2; });
}
