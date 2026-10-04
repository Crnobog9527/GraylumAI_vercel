-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Derive the historical rejection notice from BILL2; do not duplicate the fact.
-- 0166 is the latest runtime_view definition. Keep its body, ACL and owner intact.
BEGIN;
DO $migration$
DECLARE definition text; source_md5 text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure);
 source_md5:=md5(definition);
 IF source_md5='e7ee4aa5d28b6984a57f4fff78e98782' THEN RETURN;END IF;
 IF source_md5<>'d08c7da6fe58eab7b19fab87fe87479a' THEN
  RAISE EXCEPTION 'PROVIDER_REJECTED_VIEW_SOURCE_MISMATCH';
 END IF;
 -- Existing explicit reasons take priority. Only a final zero-charge cancellation
 -- with no dispatched non-rejected call proves this whole turn was refused.
 definition:=replace(definition,
  $old$'unavailableReason',CASE WHEN e.unavailable_reason IS NOT NULL THEN e.unavailable_reason$old$,
  $new$'unavailableReason',CASE WHEN e.unavailable_reason IS NOT NULL THEN e.unavailable_reason
   WHEN availability.available AND e.state='cancelled'
    AND b.closed AND b.state IN ('settled','refunded') AND NOT b.conflict AND b.charged=0
    AND EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id AND c.provider_rejected)
    AND NOT EXISTS(SELECT 1 FROM bill2_calls c WHERE c.run_id=b.id
     AND c.dispatched_at IS NOT NULL AND NOT c.provider_rejected)
    THEN 'provider_rejected'$new$);
 IF md5(definition)<>'e7ee4aa5d28b6984a57f4fff78e98782' THEN
  RAISE EXCEPTION 'PROVIDER_REJECTED_VIEW_TARGET_MISMATCH';
 END IF;
 EXECUTE definition;
END $migration$;
COMMIT;
