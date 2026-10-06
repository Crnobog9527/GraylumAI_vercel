-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local-only 0181 rollback to 0176; never restore erased bodies.
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM bill2_receipts WHERE financial_projection_version IS NOT NULL) THEN
    RAISE EXCEPTION 'ERASURE_RECEIPT_ROLLBACK_REQUIRES_FORWARD_FIX';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION public.account_erasure_scrub_receipts(
  p_profile_id uuid, p_run_id uuid, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r bill2_runs; item record; projected jsonb; processed integer := 0; remaining bigint;
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
    ORDER BY x.id LIMIT p_limit LOOP
    projected := bill2_erasure_receipt_projection(item.payload, item.call_row);
    UPDATE bill2_receipts SET payload = projected,
      financial_projection_hash = encode(sha256(convert_to(projected::text, 'utf8')), 'hex'),
      financial_projection_version = 1, financial_projected_at = clock_timestamp() WHERE id = item.id;
    processed := processed + 1;
  END LOOP;
  SELECT count(*) INTO remaining FROM bill2_receipts x JOIN bill2_calls c ON c.id = x.call_id
    WHERE c.run_id = r.id AND x.financial_projection_version IS NULL;
  RETURN jsonb_build_object('processed', processed, 'remaining', remaining);
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_receipts(uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_receipts(uuid, uuid, integer) TO service_role;
COMMIT;
