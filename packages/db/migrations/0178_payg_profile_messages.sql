-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Owner 2026-10-05: allow measured 128-message profiles; keep old frozen caps.
-- No tables, grants or stored run updates. Apply only after separate staging handoff.
-- Recovery: disable new PAYG admissions; let existing frozen runs finish.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE
 definition text:=pg_get_functiondef('public.bill2_payg_validate_quote(bill2_runs,jsonb)'::regprocedure);
 old_bound text:='least((q->>''maxMessages'')::int,32)';
 new_bound text:='least((q->>''maxMessages'')::int,128)';
BEGIN
 -- Normalize only our one edit: exact predecessor or already-applied target, never arbitrary drift.
 IF md5(replace(definition,new_bound,old_bound))<>'33d989f4d2852bdac363ce1af4b28d90' THEN
  RAISE EXCEPTION 'PAYG_MESSAGES_SOURCE_MISMATCH';
 END IF;
 EXECUTE replace(definition,old_bound,new_bound);
END $migration$;
COMMIT;
