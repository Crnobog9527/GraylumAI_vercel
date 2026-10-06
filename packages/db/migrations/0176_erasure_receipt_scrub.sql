-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE B2b first slice: historical receipt bodies only. No automatic execution.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = 'public.bill2_evidence_immutable()'::regprocedure)
    NOT IN ('6aeb3220677648ac25d75a7c3af5e399', 'fc2d44d5793dabff99f5e8cd6a605f22') THEN
    RAISE EXCEPTION 'ERASURE_RECEIPT_SOURCE_MISMATCH';
  END IF;
END $$;


-- Projection is the same financial contract used for receipts arriving after closure.
-- A mismatching model remains a conflict, without retaining arbitrary model text.
CREATE OR REPLACE FUNCTION public.bill2_erasure_receipt_projection(e jsonb, c public.bill2_calls)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF e->>'provider' IS DISTINCT FROM c.provider
    OR e->>'account' IS DISTINCT FROM c.account_namespace
    OR e->>'protocol' IS DISTINCT FROM c.payload->>'protocol' THEN
    RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';
  END IF;
  IF e->>'model' IS DISTINCT FROM c.model THEN
    e := jsonb_set(e, '{model}', 'null'::jsonb);
  END IF;
  RETURN bill2_financial_projection(e);
END $$;
REVOKE ALL ON FUNCTION public.bill2_erasure_receipt_projection(jsonb, public.bill2_calls)
  FROM PUBLIC, anon, authenticated, service_role;

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
  SELECT * INTO c FROM bill2_calls WHERE id = OLD.call_id;
  SELECT * INTO r FROM bill2_runs WHERE id = c.run_id;
  IF NOT coalesce(bill2_erasure_closed(r.actor_id, coalesce(r.pre_deduct_id, r.id)), false) THEN
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

-- One original run per transaction, bounded batches, same run -> calls -> receipts -> profile lock order.
-- Existing record/close/recovery serialize on the run; no session lock or supplier request is needed.
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
