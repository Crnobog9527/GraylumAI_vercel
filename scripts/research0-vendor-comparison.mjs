#!/usr/bin/env node

// RESEARCH-0 third-party search vendor comparison (Master Plan v12 §3.7).
// Standalone: not imported by application code and not part of any build.
//
// Dry run (default, sends nothing):
//   node scripts/research0-vendor-comparison.mjs
// Paid run, keys loaded from the Owner's file without printing it:
//   node --env-file-if-exists="$HOME/.graylum/secrets/research0.env" \
//     scripts/research0-vendor-comparison.mjs --confirm-paid-calls [--vendors tikhub] [--queries Q01,Q02]

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUERIES } from './research0/queries.mjs';
import { formatReport } from './research0/report.mjs';
import { runComparison } from './research0/runner.mjs';
import { TOTAL_CAP_USD, VENDOR_CAP_USD, loadLedger } from './research0/safety.mjs';
import { VENDORS } from './research0/vendors.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_OUT_DIR = path.join(os.homedir(), '.graylum', 'research0');

function pick(all, csv, label) {
  if (!csv) return all;
  const wanted = csv.split(',').map(value => value.trim()).filter(Boolean);
  const unknown = wanted.filter(id => !all.some(item => item.id === id));
  if (unknown.length > 0) throw new Error(`Unknown ${label}: ${unknown.join(', ')}`);
  return all.filter(item => wanted.includes(item.id));
}

export function parseArgs(argv) {
  const args = { live: false, vendors: null, queries: null, outDir: DEFAULT_OUT_DIR };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--confirm-paid-calls') args.live = true;
    else if (arg === '--vendors') args.vendors = argv[++index];
    else if (arg === '--queries') args.queries = argv[++index];
    else if (arg === '--out') args.outDir = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

/** Raw responses and the ledger must never land inside the repository. */
export function assertOutsideRepository(outDir, root = REPOSITORY_ROOT) {
  const relative = path.relative(root, path.resolve(outDir));
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw new Error('RESEARCH0_OUT_DIR_INSIDE_REPOSITORY');
  }
}

export async function main(argv = process.argv.slice(2), { env = process.env, fetchImpl = globalThis.fetch, log = console.log } = {}) {
  const args = parseArgs(argv);
  assertOutsideRepository(args.outDir);
  const vendors = pick(VENDORS, args.vendors, 'vendor');
  const queries = pick(QUERIES, args.queries, 'query');
  const ledger = await loadLedger(path.join(args.outDir, 'ledger.json'));
  log(`RESEARCH-0 ${args.live ? 'PAID RUN' : 'DRY RUN (nothing is sent)'}; caps ${VENDOR_CAP_USD} USD/vendor, ${TOTAL_CAP_USD} USD total`);
  const report = await runComparison({ vendors, queries, env, live: args.live, fetchImpl, ledger, outDir: args.outDir });
  log(formatReport(report));
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Only our own error codes are printed; library errors may echo request data.
    const message = typeof error?.message === 'string' && /^(RESEARCH0_|Unknown )/.test(error.message) ? error.message : 'RESEARCH0_FAILED';
    console.error(message);
    process.exitCode = 1;
  });
}
