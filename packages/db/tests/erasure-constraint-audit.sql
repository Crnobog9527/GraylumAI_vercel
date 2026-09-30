-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Read-only DATA-ERASURE audit: every table with erased_at must have a guard trigger carrying an
-- erasure allow-list, and no NOT NULL / CHECK on an allow-listed column may block an erased row.
-- Sentinel columns ('col=erased:...') keep their NOT NULL and CHECKs by design. Expected: 0 rows.
WITH marked AS (
  SELECT c.oid, c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attname = 'erased_at'
    AND NOT a.attisdropped
), guards AS (
  SELECT t.tgrelid, unnest(string_to_array(rtrim(encode(t.tgargs, 'escape'), '\000'), '\000')) AS spec
  FROM pg_trigger t JOIN marked m ON m.oid = t.tgrelid
  WHERE t.tgnargs > 0 AND t.tgfoid IN ('public.artifact_immutable()'::regprocedure,
    'public.artifact_chat_history_immutable()'::regprocedure, 'public.artifact_round_identity()'::regprocedure,
    'public.erased_row_guard()'::regprocedure)
), cols AS (
  SELECT DISTINCT g.tgrelid, split_part(g.spec, '=', 1) AS col, g.spec LIKE '%=erased:%' AS sentinel FROM guards g
  WHERE g.spec <> 'marker-only'
)
SELECT m.relname, 'no_guard' AS problem, NULL AS detail FROM marked m
WHERE NOT EXISTS (SELECT 1 FROM guards g WHERE g.tgrelid = m.oid)
UNION ALL
-- Marker-only is valid only for the dependency table, with no unlisted content columns.
SELECT m.relname, 'invalid_marker_only', g.spec FROM guards g JOIN marked m ON m.oid = g.tgrelid
WHERE g.spec = 'marker-only' AND (m.relname <> 'runtime_history_dependencies'
  OR EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = g.tgrelid AND a.attnum > 0
    AND NOT a.attisdropped AND a.attname NOT IN ('execution_id', 'dependency_id', 'erased_at'))
  OR EXISTS (SELECT 1 FROM guards other WHERE other.tgrelid = g.tgrelid AND other.spec <> 'marker-only'))
UNION ALL
SELECT m.relname, 'not_null_blocks_erasure', c.col FROM cols c JOIN marked m ON m.oid = c.tgrelid
JOIN pg_attribute a ON a.attrelid = c.tgrelid AND a.attname = c.col
WHERE a.attnotnull AND NOT c.sentinel
UNION ALL
SELECT m.relname, 'check_not_erasure_aware', con.conname FROM pg_constraint con
JOIN marked m ON m.oid = con.conrelid
WHERE con.contype = 'c' AND pg_get_constraintdef(con.oid) NOT LIKE '%erased_at%'
  AND EXISTS (SELECT 1 FROM cols c JOIN pg_attribute a ON a.attrelid = c.tgrelid AND a.attname = c.col
    WHERE c.tgrelid = con.conrelid AND NOT c.sentinel AND a.attnum = ANY (con.conkey))
UNION ALL
SELECT m.relname, 'allow_list_column_missing', c.col FROM cols c JOIN marked m ON m.oid = c.tgrelid
WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.tgrelid AND a.attname = c.col AND NOT a.attisdropped)
ORDER BY 1, 2, 3;
