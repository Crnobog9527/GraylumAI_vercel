-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read-only structure fingerprint of the public schema (columns, constraints, triggers, function
-- bodies and ACLs) used to prove the DATA-ERASURE B1a rollback restores the exact prior state.
SELECT md5(string_agg(line, E'\n' ORDER BY line)) FROM (
  SELECT 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
    || CASE WHEN a.attnotnull THEN ' NN' ELSE '' END AS line
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL SELECT 'con ' || conrelid::regclass || ' ' || conname || ' ' || pg_get_constraintdef(oid)
  FROM pg_constraint WHERE connamespace = 'public'::regnamespace
  UNION ALL SELECT 'trg ' || pg_get_triggerdef(oid) FROM pg_trigger
  WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace)
  UNION ALL SELECT 'fn ' || p.oid::regprocedure || ' ' || md5(pg_get_functiondef(p.oid)) || ' ' || coalesce(p.proacl::text, '')
  FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
) x;
