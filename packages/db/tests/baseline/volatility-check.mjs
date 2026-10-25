/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// MAINT-P1 (audit A1, #1398/0390): a function declared STABLE or IMMUTABLE must not write or lock rows.
// PostgREST runs STABLE/IMMUTABLE RPCs in a read-only transaction, so FOR UPDATE / INSERT / UPDATE inside
// them raises "cannot execute ... in a read-only transaction" on the real API while a local psql test
// (read-write superuser session) stays green. Run on the finished empty-database build.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ALLOW_FILE = 'packages/db/tests/baseline/volatility-allow.json';

// SQL comments are removed first. String literals are not: dynamic SQL (EXECUTE '...') that writes counts,
// and a harmless literal that happens to contain these words goes into volatility-allow.json.
const WRITE_WORDS = String.raw`\m(for\s+(no\s+key\s+)?(update|share|key\s+share)|insert\s+into|update\s+[a-z_"]|delete\s+from|truncate\s|merge\s+into|do\s+update\s+set)`;

export const volatilityViolationsSql = () => `
WITH f AS (
  SELECT p.oid, n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
         p.provolatile AS vol,
         lower(regexp_replace(regexp_replace(p.prosrc, '--[^\\n]*', '', 'g'), '/\\*.*?\\*/', '', 'g')) AS src
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE p.provolatile IN ('s', 'i')
     AND p.prokind = 'f'
     AND p.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('plpgsql', 'sql'))
     AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
)
SELECT sig || ' [' || CASE vol WHEN 's' THEN 'STABLE' ELSE 'IMMUTABLE' END || '] ' ||
       (regexp_match(src, '${WRITE_WORDS}'))[1]
  FROM f
 WHERE src ~ '${WRITE_WORDS}'
 ORDER BY sig;`;

// Keys are function signatures; the list may only shrink (scripts/tests/local-suites.test.mjs).
export function loadAllow(root) {
  return JSON.parse(readFileSync(resolve(root, ALLOW_FILE), 'utf8'));
}

// Returns the violations that are not allowed, plus allowed entries that no longer occur.
export function judgeVolatility(rows, allow) {
  const keyOf = row => row.slice(0, row.indexOf(' ['));
  const found = new Set(rows.map(keyOf));
  const unexpected = rows.filter(row => !(keyOf(row) in allow.functions));
  const stale = Object.keys(allow.functions).filter(key => !found.has(key));
  return [
    ...unexpected.map(row => `STABLE/IMMUTABLE function writes or locks rows: ${row}`),
    ...stale.map(key => `allow-list entry no longer occurs (remove it): ${key}`),
  ];
}
