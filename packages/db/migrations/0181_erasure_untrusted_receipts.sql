-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE B2b: skip unprojectable historical receipts without starving valid rows.
-- Rejected evidence stays unchanged, restricted and included in remaining/manualReview.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.bill2_evidence_immutable()'::regprocedure)
      IS DISTINCT FROM 'fc2d44d5793dabff99f5e8cd6a605f22'
    OR (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.bill2_erasure_receipt_projection(jsonb,public.bill2_calls)'::regprocedure)
      IS DISTINCT FROM '28c1455c7a48f825219503a2458a3b42'
    OR (SELECT md5(prosrc) FROM pg_proc
      WHERE oid = 'public.account_erasure_scrub_receipts(uuid,uuid,integer)'::regprocedure)
      NOT IN ('33be25d367075e18f1c77e32f25ded66', 'bc9e3e3ec79b729f9d597cbf4b85c02f') THEN
    RAISE EXCEPTION 'ERASURE_RECEIPT_SOURCE_MISMATCH';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.account_erasure_scrub_receipts(
  p_profile_id uuid, p_run_id uuid, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r bill2_runs; item record; projected jsonb; processed integer := 0; remaining bigint; manual_review bigint := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'ERASURE_BATCH_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO r FROM bill2_runs WHERE id = p_run_id AND actor_id = p_profile_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE = '42501'; END IF;
  PERFORM id FROM bill2_calls WHERE run_id = r.id ORDER BY id FOR UPDATE;
  PERFORM x.id FROM bill2_receipts x JOIN bill2_calls c ON c.id = x.call_id
    WHERE c.run_id = r.id ORDER BY x.id FOR UPDATE OF x;
  PERFORM id FROM profiles WHERE id = p_profile_id FOR UPDATE;
  IF NOT coalesce(bill2_erasure_closed(p_profile_id, coalesce(r.pre_deduct_id, r.id)), false) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;
  FOR item IN SELECT x.id, x.payload, c AS call_row FROM bill2_receipts x
    JOIN bill2_calls c ON c.id = x.call_id WHERE c.run_id = r.id AND x.financial_projection_version IS NULL
    ORDER BY x.id LOOP
    -- Classify every remaining row: an invalid early row must not starve later batches.
    -- The existing run-wide locks are unchanged; p_limit bounds successful writes.
    BEGIN
      projected := bill2_erasure_receipt_projection(item.payload, item.call_row);
    EXCEPTION
      WHEN raise_exception THEN
        IF SQLERRM NOT IN ('BILL2_UNTRUSTED_RECEIPT', 'BILL2_INVALID_FINANCIAL_PROJECTION',
            'BILL2_INVALID_COVERAGE', 'BILL2_INVALID_DECIMAL') THEN RAISE; END IF;
        manual_review := manual_review + 1;
        CONTINUE;
      WHEN invalid_datetime_format OR datetime_field_overflow
        OR invalid_time_zone_displacement_value OR invalid_parameter_value THEN
        manual_review := manual_review + 1;
        CONTINUE;
    END;
    IF processed >= p_limit THEN CONTINUE; END IF;
    -- Writes stay outside the handler: unexpected faults roll back the entire batch.
    UPDATE bill2_receipts SET payload = projected,
      financial_projection_hash = encode(sha256(convert_to(projected::text, 'utf8')), 'hex'),
      financial_projection_version = 1, financial_projected_at = clock_timestamp() WHERE id = item.id;
    processed := processed + 1;
  END LOOP;
  SELECT count(*) INTO remaining FROM bill2_receipts x JOIN bill2_calls c ON c.id = x.call_id
    WHERE c.run_id = r.id AND x.financial_projection_version IS NULL;
  RETURN jsonb_build_object('processed', processed, 'remaining', remaining, 'manualReview', manual_review);
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_receipts(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_receipts(uuid, uuid, integer) TO service_role;
COMMIT;
