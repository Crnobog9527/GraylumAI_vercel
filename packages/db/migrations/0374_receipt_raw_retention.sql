-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ARCH-FIX G2 (Owner 2026-10-25: 「收据原始输出保留 30 天，计费字段按 3 年」).
-- Provider raw output in a receipt is removed 30 days after the receipt was written, once its run has
-- finished. Billing fields, hashes and identities stay under T_fin (DATA-ERASURE: 3 years from the end
-- of the transaction year); this migration adds no deletion of ledger rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.bill2_evidence_immutable()'::regprocedure)
    NOT IN ('86b16510311b1b2c7e7d6e5ead95e297', 'c1a850d8cce723c50a8eb3cf32e47a9c') THEN
    RAISE EXCEPTION 'RECEIPT_RETENTION_SOURCE_MISMATCH';
  END IF;
END $$;

ALTER TABLE public.bill2_receipts ADD COLUMN IF NOT EXISTS raw_scrubbed_at timestamptz;
-- The daily scan only visits receipts that still carry raw output.
CREATE INDEX IF NOT EXISTS bill2_receipts_raw_pending ON public.bill2_receipts(created_at)
  WHERE raw_scrubbed_at IS NULL AND financial_projection_version IS NULL;

-- Raw output only: the response text, the wire copy inside transport, and the parsed SDK response.
-- Everything else (cost, usage token counts, provider/request ids, every hash, transport status) stays.
CREATE OR REPLACE FUNCTION public.bill2_receipt_raw_scrub(e jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT (e - 'rawBody')
    || CASE WHEN jsonb_typeof(e->'transport') = 'object'
         THEN jsonb_build_object('transport', (e->'transport') - ARRAY['rawBody', 'rawBodyBase64']) ELSE '{}' END
    || CASE WHEN jsonb_typeof(e->'usage') = 'object'
         THEN jsonb_build_object('usage', (e->'usage') - 'sdkResponse') ELSE '{}' END;
$$;
REVOKE ALL ON FUNCTION public.bill2_receipt_raw_scrub(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Due: older than 30 days, not a conflicting observation, and its run is closed and settled or refunded
-- with no conflict and no unfinished Runtime execution (recovery may still replay a stored response).
CREATE OR REPLACE FUNCTION public.bill2_receipt_raw_due(x public.bill2_receipts) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT x.raw_scrubbed_at IS NULL AND x.financial_projection_version IS NULL AND NOT x.conflict
    AND x.created_at < now() - interval '30 days'
    AND EXISTS(SELECT 1 FROM bill2_calls c JOIN bill2_runs r ON r.id = c.run_id
      WHERE c.id = x.call_id AND r.closed AND r.state IN ('settled', 'refunded') AND NOT r.conflict
        AND NOT EXISTS(SELECT 1 FROM runtime_executions e
          WHERE e.billing_run_id = r.id AND e.state NOT IN ('completed', 'cancelled')));
$$;
REVOKE ALL ON FUNCTION public.bill2_receipt_raw_due(public.bill2_receipts) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bill2_evidence_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE c bill2_calls; r bill2_runs; projected jsonb;
BEGIN
  IF TG_OP <> 'UPDATE' THEN RAISE EXCEPTION 'BILL2_IMMUTABLE_EVIDENCE'; END IF;
  -- The only service entry is SECURITY DEFINER. No table privileges are added.
  IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = TG_RELID))
    OR OLD.financial_projection_version IS NOT NULL THEN
    RAISE EXCEPTION 'BILL2_IMMUTABLE_EVIDENCE';
  END IF;
  -- ARCH-FIX G2: once, a due receipt loses only its raw output; no other column changes.
  IF NEW.raw_scrubbed_at IS DISTINCT FROM OLD.raw_scrubbed_at THEN
    IF OLD.raw_scrubbed_at IS NOT NULL OR NEW.raw_scrubbed_at IS NULL OR NOT bill2_receipt_raw_due(OLD)
      OR (to_jsonb(NEW) - ARRAY['payload', 'raw_scrubbed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['payload', 'raw_scrubbed_at'])
      OR NEW.payload IS DISTINCT FROM bill2_receipt_raw_scrub(OLD.payload) THEN
      RAISE EXCEPTION 'BILL2_IMMUTABLE_EVIDENCE';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO c FROM bill2_calls WHERE id = OLD.call_id;
  SELECT * INTO r FROM bill2_runs WHERE id = c.run_id;
  IF NOT coalesce(content_erasure_financial_allowed(r.actor_id, coalesce(r.pre_deduct_id, r.id)), false) THEN
    RAISE EXCEPTION 'BILL2_IMMUTABLE_EVIDENCE';
  END IF;
  projected := bill2_erasure_receipt_projection(OLD.payload, c);
  IF (to_jsonb(NEW) - ARRAY['payload','financial_projection_hash','financial_projection_version','financial_projected_at'])
      IS DISTINCT FROM
      (to_jsonb(OLD) - ARRAY['payload','financial_projection_hash','financial_projection_version','financial_projected_at'])
    OR NEW.payload IS DISTINCT FROM projected
    OR NEW.financial_projection_version IS DISTINCT FROM 1
    OR NEW.financial_projection_hash IS DISTINCT FROM encode(sha256(convert_to(projected::text, 'utf8')), 'hex')
    OR NEW.financial_projected_at IS NULL THEN
    RAISE EXCEPTION 'BILL2_IMMUTABLE_EVIDENCE';
  END IF;
  RETURN NEW;
END $$;

-- Daily bounded batch (billing-reconcile). Skips rows another transaction holds; a later run retries them.
-- payload_hash and financial_projection_hash are untouched, so metering review hashes do not change.
CREATE OR REPLACE FUNCTION public.bill2_receipts_scrub_raw(p_limit integer DEFAULT 200)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE done integer;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'RECEIPT_RETENTION_LIMIT_INVALID' USING ERRCODE = '22023';
  END IF;
  WITH due AS (
    SELECT x.id FROM bill2_receipts x
    WHERE x.raw_scrubbed_at IS NULL AND x.financial_projection_version IS NULL
      AND x.created_at < now() - interval '30 days' AND bill2_receipt_raw_due(x)
    ORDER BY x.created_at, x.id LIMIT p_limit FOR UPDATE OF x SKIP LOCKED)
  UPDATE bill2_receipts x SET payload = bill2_receipt_raw_scrub(x.payload), raw_scrubbed_at = clock_timestamp()
  FROM due WHERE x.id = due.id;
  GET DIAGNOSTICS done = ROW_COUNT;
  RETURN jsonb_build_object('scrubbed', done, 'more', done = p_limit);
END $$;
REVOKE ALL ON FUNCTION public.bill2_receipts_scrub_raw(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bill2_receipts_scrub_raw(integer) TO service_role;
COMMIT;
