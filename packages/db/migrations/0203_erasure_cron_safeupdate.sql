-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Coordinator-assigned 0203: safeupdate-compatible temporary scope reset and financial review.
-- No persistent rows, money, role grants, or provider configuration are changed.
BEGIN;
DO $$
DECLARE source text; old_text text; new_text text;
BEGIN
 source:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
 old_text:='DELETE FROM pg_temp.erasure_scope;';
 new_text:='TRUNCATE TABLE pg_temp.erasure_scope;';
 IF position(new_text IN source)=0 THEN
  IF length(source)-length(replace(source,old_text,''))<>length(old_text) THEN
   RAISE EXCEPTION 'ERASURE_SCOPE_RESET_SOURCE_MISMATCH';
  END IF;
  EXECUTE replace(source,old_text,new_text);
 END IF;
 -- Financial uncertainty needs a visible review date even after body projection is complete.
 -- It never authorizes zero-cost settlement, a refund, or Auth deletion.
 source:=pg_get_functiondef('public.account_erasure_local_cleanup(uuid,boolean)'::regprocedure);
 old_text:='CASE WHEN manual>0 THEN ARRAY[''ERASURE_FINANCIAL_EVIDENCE_REVIEW'']||errors ELSE errors END';
 new_text:='CASE WHEN manual>0 THEN ARRAY[''ERASURE_FINANCIAL_EVIDENCE_REVIEW'']||errors'
  ||' WHEN (proof->>''financialPending'')::bigint>0 THEN ARRAY[''ERASURE_FINANCIAL_PENDING_REVIEW'']||errors ELSE errors END';
 IF position('ERASURE_FINANCIAL_PENDING_REVIEW' IN source)=0 THEN
  IF length(source)-length(replace(source,old_text,''))<>length(old_text) THEN
   RAISE EXCEPTION 'ERASURE_FINANCIAL_REVIEW_SOURCE_MISMATCH';
  END IF;
  source:=replace(source,old_text,new_text);
  old_text:='next_review_at=CASE WHEN manual>0 OR auth_delete_started_at IS NOT NULL AND auth_deleted_at IS NULL';
  new_text:='next_review_at=CASE WHEN manual>0 OR (proof->>''financialPending'')::bigint>0'
   ||' OR auth_delete_started_at IS NOT NULL AND auth_deleted_at IS NULL';
  IF length(source)-length(replace(source,old_text,''))<>length(old_text) THEN
   RAISE EXCEPTION 'ERASURE_FINANCIAL_REVIEW_DATE_SOURCE_MISMATCH';
  END IF;
  EXECUTE replace(source,old_text,new_text);
 END IF;
END $$;
COMMIT;
