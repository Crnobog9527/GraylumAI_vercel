#!/usr/bin/env node

// RESEARCH-0 third-party search vendor comparison (Master Plan v12 §3.7).
// Standalone: not imported by application code and not part of any build.
//
// Dry run (default, sends nothing):
//   node scripts/research0-vendor-comparison.mjs
// Create the ledger once before the first paid run (paid runs refuse without it):
//   node scripts/research0-vendor-comparison.mjs --init-ledger
// Paid run, keys loaded from the Owner's file without printing it:
//   node --env-file-if-exists="$HOME/.graylum/secrets/research0.env" \
//     scripts/research0-vendor-comparison.mjs --confirm-paid-calls [--vendors tikhub] [--queries Q01,Q02]
// Recompute metrics from saved responses (offline, sends nothing):
//   node scripts/research0-vendor-comparison.mjs --reanalyze [--markdown]
// monid catalogue phase only (Owner option a; add --confirm-paid-calls to send):
//   node scripts/research0-vendor-comparison.mjs --monid-catalog

import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reanalyze } from './research0/analyze.mjs';
import { formatMarkdown } from './research0/markdown.mjs';
import { MONID_CATALOG_PLAN, formatMonidCatalog, runMonidCatalog } from './research0/monidCatalog.mjs';
import { runMonidResults } from './research0/monidResults.mjs';
import { QUERIES } from './research0/queries.mjs';
import { formatReport } from './research0/report.mjs';
import { runComparison } from './research0/runner.mjs';
import { TOTAL_CAP_USD, VENDOR_CAP_USD, acquireLock, initLedger, loadLedger } from './research0/safety.mjs';
import { VENDORS } from './research0/vendors.mjs';
import { aisaAlternates } from './research0/vendors/aisa.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_DIR = path.join(os.homedir(), '.graylum', 'research0');

function pick(all, csv, label) {
  if (csv === null) return all;
  const wanted = csv.split(',').map(value => value.trim()).filter(Boolean);
  // An empty selector must never widen a paid run to everything.
  if (wanted.length === 0) throw new Error(`RESEARCH0_EMPTY_${label.toUpperCase()}_SELECTOR`);
  const unknown = wanted.filter(id => !all.some(item => item.id === id));
  if (unknown.length > 0) throw new Error(`Unknown ${label}: ${unknown.join(', ')}`);
  return all.filter(item => wanted.includes(item.id));
}

export function parseArgs(argv) {
  const args = {
    live: false, reanalyze: false, markdown: false, monidCatalog: false, initLedger: false, aisaAlternates: false, monidResults: false,
    vendors: null, queries: null, outDir: DEFAULT_OUT_DIR,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm-paid-calls') args.live = true;
    else if (arg === '--reanalyze') args.reanalyze = true;
    else if (arg === '--markdown') args.markdown = true;
    else if (arg === '--monid-catalog') args.monidCatalog = true;
    else if (arg === '--init-ledger') args.initLedger = true;
    else if (arg === '--aisa-alternates') args.aisaAlternates = true;
    else if (arg === '--monid-results') args.monidResults = true;
    else if (arg === '--vendors') args.vendors = value(argv, ++index, arg);
    else if (arg === '--queries') args.queries = value(argv, ++index, arg);
    else if (arg === '--out') args.outDir = path.resolve(value(argv, ++index, arg));
    else throw new Error(`Unknown argument: ${arg}`);
  }
  // Modes with a fixed call plan ignore selectors; accepting them would silently widen a paid run.
  if ((args.monidResults || args.monidCatalog) && (args.vendors !== null || args.queries !== null)) {
    throw new Error('RESEARCH0_SELECTORS_NOT_SUPPORTED_IN_THIS_MODE');
  }
  if (args.aisaAlternates && args.vendors !== null) throw new Error('RESEARCH0_SELECTORS_NOT_SUPPORTED_IN_THIS_MODE');
  return args;
}

function value(argv, index, flag) {
  const found = argv[index];
  if (typeof found !== 'string' || found.trim() === '' || found.startsWith('--')) {
    throw new Error(`RESEARCH0_MISSING_VALUE_FOR_${flag.slice(2).toUpperCase()}`);
  }
  return found;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Resolves symlinks through the nearest existing ancestor; a not-yet-created tail is appended as is. */
async function canonical(target) {
  let existing = path.resolve(target);
  const tail = [];
  for (;;) {
    try {
      return path.join(await realpath(existing), ...tail);
    } catch (error) {
      if (error?.code !== 'ENOENT' || path.dirname(existing) === existing) throw new Error('RESEARCH0_OUT_DIR_UNRESOLVABLE');
      tail.unshift(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
}

/** Raw responses and the ledger must never land inside the repository, also not through a symlink. */
export async function assertOutsideRepository(outDir, root = REPOSITORY_ROOT) {
  if (inside(root, path.resolve(outDir)) || inside(await realpath(root), await canonical(outDir))) {
    throw new Error('RESEARCH0_OUT_DIR_INSIDE_REPOSITORY');
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const args = parseArgs(argv);
  // Result retrieval only follows runs that were already paid; it has no dry-run meaning.
  if (args.monidResults && !args.live) throw new Error('RESEARCH0_MONID_RESULTS_NEEDS_CONFIRMATION');
  await assertOutsideRepository(args.outDir);
  // --aisa-alternates swaps the vendor list for AIsa's second-round alternate endpoints only.
  const vendors = args.aisaAlternates ? [aisaAlternates] : pick(VENDORS, args.vendors, 'vendor');
  const queries = pick(QUERIES, args.queries, 'query');
  if (args.live && args.reanalyze) throw new Error('RESEARCH0_REANALYZE_IS_OFFLINE_ONLY');
  if (args.reanalyze) {
    const offline = await reanalyze({ vendors, queries, outDir: args.outDir });
    log(args.markdown ? formatMarkdown(offline, queries) : formatReport(offline));
    return offline;
  }
  const ledgerFile = path.join(args.outDir, 'ledger.json');
  if (args.initLedger) {
    await initLedger(ledgerFile);
    log(`RESEARCH-0 ledger created at ${ledgerFile}`);
    return null;
  }
  if (!args.live) {
    // A dry run never reads, writes or locks the ledger.
    if (args.monidCatalog) return monidCatalogPlan(log);
    log(`RESEARCH-0 DRY RUN (nothing is sent); caps ${VENDOR_CAP_USD} USD/vendor, ${TOTAL_CAP_USD} USD total`);
    const report = await runComparison({ vendors, queries, env, live: false, fetchImpl, ledger: { file: ledgerFile, entries: [] }, outDir: args.outDir });
    log(args.markdown ? formatMarkdown(report, queries) : formatReport(report));
    return report;
  }
  if ((args.monidCatalog || args.monidResults) && !(typeof env.MONID_API_KEY === 'string' && env.MONID_API_KEY.length > 0)) {
    throw new Error('RESEARCH0_MONID_KEY_MISSING');
  }
  return withLock(args.outDir, log, async () => {
    // Read only after the lock is held; a missing or unreadable ledger refuses the paid run.
    const ledger = await loadLedger(ledgerFile, { requireExisting: true });
    if (args.monidResults) {
      const webQuery = QUERIES.find(query => query.id === 'Q01').webQuery;
      const results = await runMonidResults({ key: env.MONID_API_KEY, fetchImpl, ledger, outDir: args.outDir, webQuery });
      for (const step of results.steps) log(`  ${step.label} ${step.status} http=${step.httpStatus ?? '-'} ${step.reason ?? ''}`);
      return results;
    }
    if (args.monidCatalog) {
      const catalogue = await runMonidCatalog({ key: env.MONID_API_KEY, fetchImpl, ledger, outDir: args.outDir });
      log(formatMonidCatalog(catalogue));
      return catalogue;
    }
    log(`RESEARCH-0 PAID RUN; caps ${VENDOR_CAP_USD} USD/vendor, ${TOTAL_CAP_USD} USD total`);
    const report = await runComparison({ vendors, queries, env, live: true, fetchImpl, ledger, outDir: args.outDir });
    log(args.markdown ? formatMarkdown(report, queries) : formatReport(report));
    return report;
  });
}

/** The lock is released only after a clean finish; an aborted run leaves it for a person. */
async function withLock(outDir, log, run) {
  const lock = await acquireLock(outDir);
  let result;
  try {
    result = await run();
  } catch (error) {
    log(`RESEARCH0_RUN_ABORTED: lock kept at ${lock.file}; reconcile the ledger before deleting it`);
    throw error;
  }
  await lock.release();
  return result;
}

function monidCatalogPlan(log) {
  log('monid catalogue DRY RUN (nothing is sent); planned calls, each booked at $0.05:');
  for (const step of MONID_CATALOG_PLAN) log(`  ${step.label} ${step.kind === 'balance' ? 'GET /v1/wallet/balance' : `POST /v1/discover "${step.query}"`}`);
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Only our own error codes are printed; library errors may echo request data.
    const message = typeof error?.message === 'string' && /^(RESEARCH0_|Unknown )/.test(error.message) ? error.message : 'RESEARCH0_FAILED';
    console.error(message);
    process.exitCode = 1;
  });
}
