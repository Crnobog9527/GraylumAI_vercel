#!/usr/bin/env node

// PostgREST re-runs a whole call whose function fails with SQLSTATE 40001 (serialization failure) instead of answering. That is
// only right for a conflict a re-run can clear (a lock race). A refusal of out-of-date input never clears by itself: the request
// hangs, and a re-run that comes after the data has gone back to the old state goes through (#1716 acceptance step 10 lost another
// tab's content pillar this way; docs/validation/PAY_COMMON_CHANNEL_CONFLICT.md is the same case). Such a refusal uses PT409 (HTTP
// 409). The functions raising 40001 today are listed below; the list may only get shorter. Reads the generated files in
// packages/db/functions (the database built from every migration).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FUNCTIONS_DIR = 'packages/db/functions';
const RETRY_CODE = /ERRCODE\s*=\s*'(?:40001|serialization_failure)'|\bSQLSTATE\s+'40001'/i;

/** Known before this check; each still to be checked for a refusal that a re-run cannot clear. */
export const ALLOWED = new Set([
  'erasure/content_erasure_confirm.sql',
  'other/billing_provider_prices_swap.sql',
  'pay/pay_common_save_catalog.sql',
  'pay/pay_dispute_match.sql',
  'pay/pay_dispute_receive.sql',
  'pay/pay_dispute_stop_confirm.sql',
  'publish/publish_monitor_publish_manual_resolve.sql',
  'publish/publish_monitor_publish_record.sql',
  'publish/publish_monitor_publish_release.sql',
  'runtime/runtime_session_result_edit.sql',
  'turn/turn_call_begin.sql',
]);

/** `files`: Map of path (relative to FUNCTIONS_DIR) → text. Returns the new ones raising 40001 and the listed ones that no longer do. */
export function checkRetryCodes(files) {
  const raising = [...files].filter(([, text]) => RETRY_CODE.test(text)).map(([file]) => file).sort();
  return { added: raising.filter(file => !ALLOWED.has(file)), gone: [...ALLOWED].filter(file => !raising.includes(file)).sort() };
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = new Map();
  for (const entry of await readdir(path.join(root, FUNCTIONS_DIR), { recursive: true })) {
    if (entry.endsWith('.sql')) files.set(entry.split(path.sep).join('/'), await readFile(path.join(root, FUNCTIONS_DIR, entry), 'utf8'));
  }
  const { added, gone } = checkRetryCodes(files);
  for (const file of added) console.error(`${FUNCTIONS_DIR}/${file}: raises SQLSTATE 40001, which PostgREST re-runs instead of answering. `
    + 'Use PT409 for a refusal (see scripts/check-function-retry-codes.mjs).');
  for (const file of gone) console.error(`${FUNCTIONS_DIR}/${file} no longer raises 40001: remove it from ALLOWED in scripts/check-function-retry-codes.mjs.`);
  if (added.length || gone.length) process.exit(1);
  console.log(`Function retry codes passed: ${ALLOWED.size} known`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
