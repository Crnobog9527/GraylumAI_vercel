/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Offline only: emit a catalog-only READ ONLY query, or compare its saved result. No credentials/network access.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareStructure, snapshotObjects } from '../packages/db/tests/baseline/staging-comparison.mjs';

export function captureSql() {
  const sql = readFileSync(new URL('../packages/db/tests/baseline/fingerprint.sql', import.meta.url), 'utf8');
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSET LOCAL search_path = public;\n${sql.split('-- FINAL')[0]}
SELECT jsonb_build_object('format','graylum-structure-v2','searchPath',current_setting('search_path'),
 'objectCount',count(*),'objects',jsonb_object_agg(k,d ORDER BY k)) AS snapshot FROM grouped;\nCOMMIT;\n`;
}
export function parseSnapshot(text) {
  const data = JSON.parse(text);
  const snapshot = data.rows ? (data.rows.length === 1 ? data.rows[0].snapshot : null) : data;
  snapshotObjects(snapshot);
  return snapshot;
}
function main() {
  const [command, snapshotPath, builtPath, ...extra] = process.argv.slice(2);
  if (command === 'sql' && !snapshotPath) return process.stdout.write(captureSql());
  if (command !== 'compare-staging' || !snapshotPath || !builtPath || extra.length) {
    throw new Error('Usage: staging-structure.mjs sql | compare-staging <snapshot.json> <built-fingerprint.json>');
  }
  const snapshot = parseSnapshot(readFileSync(resolve(snapshotPath), 'utf8'));
  const built = JSON.parse(readFileSync(resolve(builtPath), 'utf8'));
  const result = compareStructure(built.objects, snapshot, { hashed: true, stagingTestPermissions: true });
  console.log(JSON.stringify(result, null, 2));
  if (result.unexpected.length) process.exitCode = 1;
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
