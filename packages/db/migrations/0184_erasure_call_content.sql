-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE B2b: original call payload only; no automatic caller.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS content_erased_at timestamptz;

CREATE OR REPLACE FUNCTION public.bill2_erasure_call_payload(v jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE projected jsonb;
BEGIN
  v := v - ARRAY['modelId','multiplier'];
  IF jsonb_typeof(v->'payg') = 'object' THEN
    v := jsonb_set(v,'{payg}',(v->'payg') - ARRAY['version','admissionPath','maxBytes',
      'maxMessages','maxTools','maxSchemaBytes','purposes','expiresAt']);
  END IF;
  -- Reuse frozen policy validation; remove policy-only fields absent from the call contract.
  projected := (bill2_erasure_run_payload(jsonb_build_object('callPolicy',jsonb_build_array(v)))
    #> '{callPolicy,0}') - ARRAY['modelId','multiplier'];
  projected := projected || bill2_erasure_fields(v, $shape$
    {"phase":"id","requestHash":"hash","runtimeEpoch":"integer",
     "billingUnit":{"modelId":"uuid","multiplier":"decimal","source":"id"}}
    $shape$::jsonb);
  IF v ? 'payg' THEN
    projected := jsonb_set(projected,'{payg}',
      ((projected->'payg') - ARRAY['version','admissionPath','maxBytes','maxMessages',
        'maxTools','maxSchemaBytes','purposes','expiresAt']) || bill2_erasure_fields(v->'payg', $quote$
      {"policyVersion":"id","bytes":"integer","promptTokensUpper":"integer",
       "messages":"integer","tools":"integer","schemaBytes":"integer"}
      $quote$::jsonb));
  END IF;
  RETURN projected;
END $$;
REVOKE ALL ON FUNCTION public.bill2_erasure_call_payload(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bill2_call_erasure_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE r bill2_runs;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.content_erased_at IS NOT NULL THEN RAISE EXCEPTION 'BILL2_CALL_ERASURE_IMMUTABLE'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.content_erased_at IS NULL AND NEW.content_erased_at IS NULL THEN RETURN NEW; END IF;
  IF OLD.content_erased_at IS NULL THEN
    SELECT * INTO r FROM bill2_runs WHERE id=OLD.run_id;
    IF current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
      OR NOT coalesce(bill2_erasure_closed(r.actor_id,coalesce(r.pre_deduct_id,r.id)),false)
      OR NOT r.closed THEN RAISE EXCEPTION 'BILL2_CALL_ERASURE_DENIED'; END IF;
    IF (to_jsonb(NEW)-ARRAY['payload','content_erased_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['payload','content_erased_at'])
      OR NEW.payload IS DISTINCT FROM bill2_erasure_call_payload(OLD.payload) THEN
      RAISE EXCEPTION 'BILL2_CALL_ERASURE_IMMUTABLE';
    END IF;
  ELSIF NEW.content_erased_at IS DISTINCT FROM OLD.content_erased_at
    OR NEW.payload IS DISTINCT FROM OLD.payload OR NEW.run_id IS DISTINCT FROM OLD.run_id THEN
    RAISE EXCEPTION 'BILL2_CALL_ERASURE_IMMUTABLE';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bill2_call_erasure_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS bill2_call_erasure_guard ON public.bill2_calls;
CREATE TRIGGER bill2_call_erasure_guard BEFORE INSERT OR UPDATE ON public.bill2_calls
  FOR EACH ROW EXECUTE FUNCTION public.bill2_call_erasure_guard();

CREATE OR REPLACE FUNCTION public.account_erasure_scrub_calls(p_profile_id uuid,p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r bill2_runs; processed integer;
BEGIN
  SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_profile_id FOR UPDATE;
  IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501'; END IF;
  PERFORM bill2_payg_lock_models(r);
  PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
  PERFORM x.id FROM bill2_receipts x JOIN bill2_calls c ON c.id=x.call_id
    WHERE c.run_id=r.id ORDER BY x.id FOR UPDATE OF x;
  PERFORM id FROM profiles WHERE id=p_profile_id FOR UPDATE;
  IF NOT coalesce(bill2_erasure_closed(p_profile_id,coalesce(r.pre_deduct_id,r.id)),false) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE='42501';
  END IF;
  IF NOT r.closed THEN RETURN jsonb_build_object('processed',0,'remaining',
    (SELECT count(*) FROM bill2_calls WHERE run_id=r.id AND content_erased_at IS NULL),'reason','call_set_open'); END IF;
  -- Atomic per original run: malformed frozen facts keep the entire batch intact.
  -- Existing metering review invalidation deliberately applies when its payload evidence changes.
  UPDATE bill2_calls SET payload=bill2_erasure_call_payload(payload),content_erased_at=clock_timestamp()
    WHERE run_id=r.id AND content_erased_at IS NULL;
  GET DIAGNOSTICS processed = ROW_COUNT;
  RETURN jsonb_build_object('processed',processed,'remaining',0);
END $$;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_calls(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_calls(uuid,uuid) TO service_role;
COMMIT;
