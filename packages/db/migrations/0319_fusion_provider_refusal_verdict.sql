-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved.
-- This code is proprietary and confidential.
-- FUSION-REVIEW (staging 2026-10-19): a provider refusal of a Fusion call was recorded as user_stopped. A strict
-- refusal (402 and the like) is first stored as provider_rejection_pending; 0164 then cancels and finalizes the run
-- before the lookup confirms it, so bill2_payg_finalize saw a cancelled run with provider_rejected still false and
-- took the user-stop branch. Nobody stopped anything: the call never delivered. Now a Fusion call with a refusal
-- receipt and no saved output records no_delivery, the zero-charge verdict (Owner 2026-10-04: a 402 is not charged
-- and Graylum bears the risk; total control 2026-10-20: record it as no_delivery). Account closure keeps precedence;
-- a call with a saved output is still judged by the host. Ordinary (non-Fusion) runs are untouched.
-- Repeatable guarded function patch. Rollback: restore the prior bill2_payg_finalize definition from a pre-apply schema
-- snapshot; verdicts already written stay (they are immutable) and no data restoration is needed.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ DECLARE src text; a text; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('-- 0319 provider refusal is no_delivery' IN src)=0 THEN
    a:=$x$   -- 0236 saved body waits for verdict$x$;
    IF array_length(string_to_array(src,a),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: bill2_payg_finalize 0319'; END IF;
    EXECUTE replace(src,a,$x$   -- 0319 provider refusal is no_delivery
   ELSIF NOT EXISTS(SELECT 1 FROM fusion_call_outputs WHERE call_id=c.id) AND EXISTS(SELECT 1 FROM bill2_receipts
    WHERE call_id=c.id AND payload->>'evidenceKind' IN ('provider_rejection','provider_rejection_pending')) THEN
    UPDATE bill2_calls SET fusion_verdict='no_delivery' WHERE id=c.id RETURNING * INTO c;
$x$||a);
  END IF;
END $$;
COMMIT;
