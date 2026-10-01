-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- DATA-ERASURE B2a SQL slice: numbered 0156 after #497's 0155 (staging 0154) under PR #550 controller coordination.
-- Host integration remains deferred; remote application requires separate Owner authorization.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
BEGIN
 IF md5(pg_get_functiondef('public.bill2_read(uuid,uuid)'::regprocedure)) NOT IN ('a15230d1b76e914de934909d4094a07b','b7a41ced1962f8ba453f67f4a2542e50') THEN
  RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: bill2_read(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_close(uuid,uuid,text,jsonb)'::regprocedure)) NOT IN ('d446f8c9a4cadeb4f0d1345d3dba7479','cdd624f5aba3b08481c2e9f0ddfcaad0') THEN
  RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: bill2_close(uuid,uuid,text,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_record(uuid,uuid,uuid,jsonb)'::regprocedure)) NOT IN ('87f1ca11a9519c5e7d9a5bf774c976dd','230e64de05ffe4f4e7181087d838470b') THEN
  RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: bill2_record(uuid,uuid,uuid,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.runtime_financial_recovery(uuid,uuid,boolean)'::regprocedure)) NOT IN ('97bf2f1859bc1019146cafd7e1418ae7','d24b8d6aa4eac6ccae0269dd52a73c7d') THEN
  RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: runtime_financial_recovery(uuid,uuid,boolean)';END IF;
 IF md5(pg_get_functiondef('public.bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)'::regprocedure)) NOT IN ('86107967a3d5bf30ec1737459a606eec','df0b57cbf4ad7cbb890afb056925f951') THEN
  RAISE EXCEPTION 'ERASURE_SOURCE_MISMATCH: bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)';END IF;
END $$;
-- No new admission authority: the original erasure request and pre-deduction remain authoritative.
CREATE OR REPLACE FUNCTION public.bill2_erasure_closed(a uuid, pre uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  -- A predicate, not a new grant: callers retain their original non-erasure authorization.
  RETURN a IS NOT NULL AND EXISTS (SELECT 1 FROM profiles p JOIN account_erasure_requests e ON e.profile_id = p.id
      WHERE p.id = a AND p.status = 'deleted' AND p.is_deleted = 'true')
    AND EXISTS (SELECT 1 FROM billing_history WHERE id = pre AND user_id = a AND operation_type = 'pre_deduct');
END $$;

CREATE OR REPLACE FUNCTION public.bill2_erasure_view(r public.bill2_runs, is_closed boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN is_closed THEN (bill2_public(r) - 'scope') || '{"accountClosed":true}'::jsonb
    ELSE bill2_public(r) END;
$$;

-- Reconstruct every nested object. A known key must never carry an object containing private data.
-- This projection preserves every field used by the existing monetary/conflict calculation.
CREATE OR REPLACE FUNCTION public.bill2_financial_projection(e jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE v jsonb := '{}'; k text; piece jsonb; details jsonb := '[]'; usage jsonb := '{}';
BEGIN
  IF jsonb_typeof(e) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION'; END IF;
  FOREACH k IN ARRAY ARRAY['provider','account','protocol','model','providerId','expectedProviderId',
    'source','sourceHash','observedAt','coverage','detailId','currency','cost','evidenceKind'] LOOP
    IF e ? k THEN
      IF jsonb_typeof(e->k) NOT IN ('string','null') THEN RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION'; END IF;
      v := v || jsonb_build_object(k,e->k);
    END IF;
  END LOOP;
  IF e->>'source' NOT IN ('response','lookup','transport_unknown')
    OR coalesce(e->>'sourceHash','') !~ '^[a-f0-9]{64}$'
    OR jsonb_typeof(e->'final') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION';
  END IF;
  IF coalesce(e->>'currency','') !~ '^[A-Z]{3}$'
    OR (e->>'evidenceKind' IS NOT NULL AND e->>'evidenceKind' <> 'transport_observation') THEN
    RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION';
  END IF;
  FOREACH k IN ARRAY ARRAY['providerId','expectedProviderId','detailId'] LOOP
    IF e->>k IS NOT NULL AND (length(e->>k) NOT BETWEEN 1 AND 256 OR e->>k !~ '^[A-Za-z0-9._:-]+$') THEN
      RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION';
    END IF;
  END LOOP;
  -- Reject non-timestamps, and store the typed timestamp rather than arbitrary source text.
  v := v || jsonb_build_object('observedAt',(e->>'observedAt')::timestamptz,'final',e->'final');
  IF e->>'cost' IS NOT NULL THEN PERFORM bill2_decimal(e->'cost'); END IF;
  IF jsonb_typeof(coalesce(e->'includedDetails','[]')) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'BILL2_INVALID_COVERAGE';
  END IF;
  FOR piece IN SELECT value FROM jsonb_array_elements(coalesce(e->'includedDetails','[]')) LOOP
    PERFORM bill2_decimal(piece->'cost');
    IF jsonb_typeof(piece->'currency') IS DISTINCT FROM 'string' OR piece->>'currency' !~ '^[A-Z]{3}$' THEN
      RAISE EXCEPTION 'BILL2_INVALID_FINANCIAL_PROJECTION';
    END IF;
    details := details || jsonb_build_array(jsonb_build_object('cost',piece->'cost','currency',piece->'currency'));
  END LOOP;
  FOREACH k IN ARRAY ARRAY['inputTokens','outputTokens','cachedTokens','cacheCreationTokens','webSearchCount'] LOOP
    IF jsonb_typeof(e->'usage'->k) IN ('string','number') AND e->'usage'->>k ~ '^(0|[1-9][0-9]{0,9})$' THEN
      usage := usage || jsonb_build_object(k,e->'usage'->k);
    END IF;
  END LOOP;
  v := v || jsonb_build_object('includedDetails',details,'usage',usage);
  -- Only presence affects the original conflict rule; free-form diagnostics are never retained.
  IF e->>'rejectedReason' IS NOT NULL THEN v := v || '{"rejectedReason":"erasure_rejected"}'::jsonb; END IF;
  IF e->>'costIssue' IN ('missing_cost','invalid_cost') THEN v := v || jsonb_build_object('costIssue',e->>'costIssue'); END IF;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.bill2_outcome_projection(v jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF v IS NULL OR v = 'null'::jsonb THEN RETURN NULL; END IF;
  IF jsonb_typeof(v) IS DISTINCT FROM 'object'
    OR v->>'kind' NOT IN ('usable_result','confirmed_delivery_failure')
    OR jsonb_typeof(v->'kind') IS DISTINCT FROM 'string'
    OR jsonb_typeof(v->'evidenceRef') IS DISTINCT FROM 'string'
    OR coalesce(length(v->>'evidenceRef'),0) = 0
    OR jsonb_typeof(v->'evidenceHash') IS DISTINCT FROM 'string'
    OR coalesce(v->>'evidenceHash','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'BILL2_OUTCOME_EVIDENCE_REQUIRED';
  END IF;
  RETURN jsonb_build_object('kind',v->>'kind','evidenceHash',v->>'evidenceHash',
    'evidenceRefHash',encode(sha256(convert_to(v->>'evidenceRef','utf8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION public.bill2_erasure_closed(uuid,uuid),
  public.bill2_erasure_view(public.bill2_runs,boolean), public.bill2_financial_projection(jsonb),
  public.bill2_outcome_projection(jsonb) FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.bill2_receipts ADD COLUMN IF NOT EXISTS financial_projection_hash text;
ALTER TABLE public.bill2_receipts ADD COLUMN IF NOT EXISTS financial_projection_version integer;
ALTER TABLE public.bill2_receipts ADD COLUMN IF NOT EXISTS financial_projected_at timestamptz;
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS result_financial_projection_hash text;
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS result_financial_projection_version integer;
ALTER TABLE public.bill2_receipts DROP CONSTRAINT IF EXISTS bill2_financial_projection_valid;
ALTER TABLE public.bill2_receipts ADD CONSTRAINT bill2_financial_projection_valid CHECK (
  (financial_projection_hash IS NULL AND financial_projection_version IS NULL AND financial_projected_at IS NULL)
  OR (financial_projection_hash IS NOT NULL AND financial_projection_version IS NOT NULL AND financial_projected_at IS NOT NULL
    AND financial_projection_version = 1 AND financial_projection_hash = encode(sha256(convert_to(payload::text,'utf8')),'hex')));
ALTER TABLE public.bill2_runs DROP CONSTRAINT IF EXISTS bill2_result_projection_valid;
ALTER TABLE public.bill2_runs ADD CONSTRAINT bill2_result_projection_valid CHECK (
  (result_financial_projection_hash IS NULL AND result_financial_projection_version IS NULL)
  OR (result IS NOT NULL AND result_financial_projection_hash IS NOT NULL AND result_financial_projection_version IS NOT NULL
    AND result_financial_projection_version = 1
    AND result_financial_projection_hash = encode(sha256(convert_to(result::text,'utf8')),'hex')));

CREATE OR REPLACE FUNCTION public.bill2_read(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;erasing boolean;BEGIN SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,r.pre_deduct_id);
 IF NOT erasing THEN PERFORM bill2_actor(p_actor_id);END IF;
 RETURN bill2_erasure_view(r,erasing)||jsonb_build_object('calls',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'sequence',sequence,'state',state,'providerId',provider_id,'costUsd',selected_cost_usd::text,'recoveryAttempts',recovery_attempts) ORDER BY sequence),'[]') FROM bill2_calls WHERE run_id=r.id));END $function$;

CREATE OR REPLACE FUNCTION public.bill2_close(p_actor_id uuid, p_run_id uuid, p_outcome text, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;erasing boolean;incoming jsonb;previous jsonb;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 -- Match financial writers: run -> calls/receipts -> profile. Confirmation holds only the profile.
 PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
 PERFORM x.id FROM bill2_receipts x JOIN bill2_calls bc ON bc.id=x.call_id WHERE bc.run_id=r.id ORDER BY x.id FOR UPDATE OF x;
 PERFORM id FROM profiles WHERE id=p_actor_id FOR UPDATE;
 erasing:=bill2_erasure_closed(p_actor_id,r.pre_deduct_id);
 IF r.state IN ('settled','refunded') THEN RETURN bill2_erasure_view(r,erasing);END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('delivered','confirmed_failure','cancelled','unknown') THEN RAISE EXCEPTION 'BILL2_INVALID_OUTCOME';END IF;
 incoming:=CASE WHEN erasing THEN bill2_outcome_projection(p_result) ELSE p_result END;
 previous:=CASE WHEN erasing AND r.closed AND r.outcome<>'unknown' AND r.result_financial_projection_version IS NULL
   THEN bill2_outcome_projection(r.result) ELSE r.result END;
 IF r.closed AND r.outcome<>'unknown' THEN
  IF r.outcome IS DISTINCT FROM p_outcome OR previous IS DISTINCT FROM incoming THEN
   RAISE EXCEPTION 'BILL2_CLOSE_CONFLICT';
  END IF;
  RETURN bill2_erasure_view(r,erasing);
 END IF;
 IF p_outcome IN ('delivered','confirmed_failure') AND (jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR coalesce(length(p_result->>'evidenceRef'),0)=0 OR coalesce(length(p_result->>'evidenceHash'),0)<>64
 OR p_result->>'kind' IS DISTINCT FROM CASE WHEN p_outcome='delivered' THEN 'usable_result' ELSE 'confirmed_delivery_failure' END) THEN RAISE EXCEPTION 'BILL2_OUTCOME_EVIDENCE_REQUIRED';END IF;
 IF octet_length(coalesce(p_result,'{}')::text)>262144 THEN RAISE EXCEPTION 'BILL2_RESULT_TOO_LARGE';END IF;
 UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid() WHERE run_id=r.id AND state='prepared';
 UPDATE bill2_runs SET closed=true,outcome=p_outcome,result=incoming,result_financial_projection_hash=CASE WHEN erasing AND incoming IS NOT NULL THEN encode(sha256(convert_to(incoming::text,'utf8')),'hex') END,
 result_financial_projection_version=CASE WHEN erasing AND incoming IS NOT NULL THEN 1 END,cancel_requested=cancel_requested OR p_outcome='cancelled',version=version+1,
 state=CASE WHEN p_outcome='unknown' THEN 'unknown' ELSE state END WHERE id=r.id RETURNING * INTO r;
 RETURN bill2_erasure_view(r,erasing);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_record(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;other_id uuid;h text;raw_cost numeric;cost numeric;bad boolean:=false;prior jsonb;currency text;piece jsonb;parts numeric:=0;detail_total numeric;total_observation jsonb;erasing boolean;projection_hash text;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_NOT_DISPATCHED';END IF;
 -- Match financial writers: run -> calls/receipts -> profile. Confirmation holds only the profile.
 PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
 PERFORM x.id FROM bill2_receipts x JOIN bill2_calls bc ON bc.id=x.call_id WHERE bc.run_id=r.id ORDER BY x.id FOR UPDATE OF x;
 PERFORM id FROM profiles WHERE id=p_actor_id FOR UPDATE;
 erasing:=bill2_erasure_closed(p_actor_id,r.pre_deduct_id);

 IF p_evidence->>'provider' IS DISTINCT FROM c.provider OR p_evidence->>'account' IS DISTINCT FROM c.account_namespace OR p_evidence->>'protocol' IS DISTINCT FROM c.payload->>'protocol'
 OR coalesce(p_evidence->>'sourceHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_evidence->'final') IS DISTINCT FROM 'boolean' OR coalesce(length(p_evidence->>'source'),0)=0 OR p_evidence->>'observedAt' IS NULL
 OR p_evidence->>'coverage' IS NULL OR p_evidence->>'coverage' NOT IN ('request_total','included_detail') THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
 h:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 IF EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND payload_hash=h) THEN RETURN bill2_erasure_view(r,erasing);END IF;
 IF erasing THEN
  -- Keep the conflict fact, never an arbitrary mismatching model string.
  IF p_evidence->>'model' IS DISTINCT FROM c.model THEN p_evidence:=jsonb_set(p_evidence,'{model}','null'::jsonb);END IF;
  p_evidence:=bill2_financial_projection(p_evidence);
  projection_hash:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 END IF;
 IF p_evidence->>'providerId' IS NOT NULL THEN
  IF length(p_evidence->>'providerId') NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'BILL2_INVALID_PROVIDER_ID';END IF;
  INSERT INTO bill2_provider_ids VALUES(c.provider,c.account_namespace,p_evidence->>'providerId',c.id) ON CONFLICT DO NOTHING;
  SELECT call_id INTO other_id FROM bill2_provider_ids WHERE provider=c.provider AND account_namespace=c.account_namespace AND provider_id=p_evidence->>'providerId';
  bad:=other_id<>c.id OR (c.provider_id IS NOT NULL AND c.provider_id IS DISTINCT FROM p_evidence->>'providerId');
  IF NOT bad THEN UPDATE bill2_calls SET provider_id=p_evidence->>'providerId' WHERE id=c.id;END IF;
 END IF;
 -- Transport observations preserve diagnostics/IDs but never assert cost, finality or delivery.
 IF p_evidence->>'evidenceKind'='transport_observation' THEN
  IF p_evidence->>'cost' IS NOT NULL OR p_evidence->>'final' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
  bad:=bad OR (p_evidence->>'providerId' IS NOT NULL AND p_evidence->>'expectedProviderId' IS NOT NULL AND p_evidence->>'expectedProviderId' IS DISTINCT FROM p_evidence->>'providerId');
  INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,financial_projection_version,financial_projected_at)
 VALUES(c.id,p_evidence,h,bad,projection_hash,CASE WHEN erasing THEN 1 END,CASE WHEN erasing THEN clock_timestamp() END);
  UPDATE bill2_runs SET conflict=conflict OR bad,version=version+1,
   state=CASE WHEN state IN ('settled','refunded') OR c.selected_cost_usd IS NOT NULL THEN state
    WHEN coalesce(c.provider_id,p_evidence->>'providerId') IS NULL THEN 'unknown' ELSE 'cost_pending' END
   WHERE id=r.id RETURNING * INTO r;
  RETURN bill2_erasure_view(r,erasing);
 END IF;
 bad:=bad OR p_evidence->>'model' IS DISTINCT FROM c.model OR p_evidence->>'rejectedReason' IS NOT NULL OR (p_evidence->>'expectedProviderId' IS NOT NULL AND p_evidence->>'expectedProviderId' IS DISTINCT FROM p_evidence->>'providerId');
 IF p_evidence->>'cost' IS NOT NULL THEN raw_cost:=bill2_decimal(p_evidence->'cost');END IF;
 currency:=p_evidence->>'currency';
 IF raw_cost IS NOT NULL THEN
  IF currency='USD' THEN cost:=raw_cost;
  ELSIF r.payload->'rules'->'fx' ? currency THEN cost:=raw_cost*bill2_decimal(r.payload->'rules'->'fx'->currency->'usdPerUnit');END IF;
 END IF;
 IF coalesce(jsonb_typeof(p_evidence->'includedDetails'),'array')<>'array' THEN RAISE EXCEPTION 'BILL2_INVALID_COVERAGE';END IF;
 FOR piece IN SELECT * FROM jsonb_array_elements(coalesce(p_evidence->'includedDetails','[]')) LOOP
  parts:=parts+bill2_decimal(piece->'cost');IF piece->>'currency' IS DISTINCT FROM currency THEN bad:=true;END IF;
 END LOOP;
 IF raw_cost IS NOT NULL AND parts>raw_cost THEN bad:=true;END IF;
 IF p_evidence->>'coverage'='request_total' THEN
  FOR prior IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND payload->>'coverage'='request_total' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL LOOP
   IF bill2_decimal(prior->'cost') IS DISTINCT FROM raw_cost OR prior->>'currency' IS DISTINCT FROM currency OR prior->>'model' IS DISTINCT FROM p_evidence->>'model' OR p_evidence->>'final' IS DISTINCT FROM 'true' THEN bad:=true;END IF;
  END LOOP;
  IF cost IS NOT NULL AND cost>c.upper_usd THEN bad:=true;END IF;
 END IF;
 -- Independent detail observations are scoped to the parent generation and a stable detailId.
 -- Never add them to an inline detail array; both describe portions of the same total.
 IF p_evidence->>'coverage'='included_detail' AND coalesce(length(p_evidence->>'detailId'),0) NOT BETWEEN 1 AND 128 THEN bad:=true;END IF;
 IF p_evidence->>'coverage'='included_detail' THEN
  FOR prior IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND payload->>'coverage'='included_detail' AND payload->>'detailId'=p_evidence->>'detailId' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL LOOP
   IF bill2_decimal(prior->'cost') IS DISTINCT FROM raw_cost OR prior->>'currency' IS DISTINCT FROM currency OR p_evidence->>'final' IS DISTINCT FROM 'true' THEN bad:=true;END IF;
  END LOOP;
 END IF;
 FOR total_observation IN
  SELECT payload FROM bill2_receipts WHERE call_id=c.id AND payload->>'coverage'='request_total' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL
  UNION ALL SELECT p_evidence WHERE p_evidence->>'coverage'='request_total' AND p_evidence->>'final'='true' AND raw_cost IS NOT NULL
 LOOP
  WITH observations AS (
   SELECT payload FROM bill2_receipts WHERE call_id=c.id
   UNION ALL SELECT p_evidence),
  details AS (SELECT payload->>'detailId' id,max(bill2_decimal(payload->'cost')) amount
   FROM observations WHERE payload->>'coverage'='included_detail' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL AND payload->>'detailId' IS NOT NULL
   GROUP BY payload->>'detailId')
  SELECT coalesce(sum(amount),0) INTO detail_total FROM details;
  IF detail_total>bill2_decimal(total_observation->'cost') OR EXISTS(
   SELECT 1 FROM (SELECT payload FROM bill2_receipts WHERE call_id=c.id UNION ALL SELECT p_evidence) obs
   WHERE payload->>'coverage'='included_detail' AND payload->>'cost' IS NOT NULL AND payload->>'currency' IS DISTINCT FROM total_observation->>'currency') THEN bad:=true;END IF;
 END LOOP;
 INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,financial_projection_version,financial_projected_at)
 VALUES(c.id,p_evidence,h,bad,projection_hash,CASE WHEN erasing THEN 1 END,CASE WHEN erasing THEN clock_timestamp() END);
 IF bad THEN UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=r.id RETURNING * INTO r;
 ELSE
  IF p_evidence->>'coverage'='request_total' AND p_evidence->>'final'='true' AND cost IS NOT NULL AND p_evidence->>'providerId' IS NOT NULL THEN
   UPDATE bill2_calls SET selected_cost_usd=cost,state='responded' WHERE id=c.id;
  ELSE UPDATE bill2_calls SET state=CASE WHEN selected_cost_usd IS NULL THEN 'unknown' ELSE state END WHERE id=c.id;END IF;
  IF r.state IN ('settled','refunded') THEN
   UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)=0 THEN coalesce(sum(selected_cost_usd),0) ELSE NULL END FROM bill2_calls WHERE run_id=r.id),version=version+1 WHERE id=r.id RETURNING * INTO r;
  ELSE UPDATE bill2_runs SET state=CASE WHEN p_evidence->>'providerId' IS NULL THEN 'unknown' ELSE 'cost_pending' END,version=version+1 WHERE id=r.id RETURNING * INTO r;END IF;
 END IF;
 RETURN bill2_erasure_view(r,erasing);
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;erasing boolean;terminal text;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR b.id IS NULL OR b.session_ref IS DISTINCT FROM e.session_id THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,b.pre_deduct_id);
 IF NOT erasing AND e.result IS NULL AND runtime_history_available(e.id) AND e.state NOT IN ('cancelled','cost_pending')
 AND NOT EXISTS(SELECT 1 FROM runtime_test_windows w WHERE w.id=b.test_window_id
  AND (NOT w.enabled OR clock_timestamp()>=w.expires_at OR NOT(p_actor_id=ANY(w.actor_ids)))) THEN
  RAISE EXCEPTION 'RUNTIME_EXECUTION_STILL_ALLOWED';
 END IF;
 IF p_finish THEN
  -- A winning financial outcome is authoritative even after execution content is gone.
  IF NOT erasing THEN
   IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
   ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
  ELSIF b.state NOT IN ('settled','refunded') THEN
   IF NOT b.closed OR b.outcome IS NULL OR b.outcome='unknown' THEN
    IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
    ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
   END IF;
  END IF;
  v:=bill2_finalize(p_actor_id,b.id);
  IF v->>'state' IN ('settled','refunded') THEN
   terminal:=CASE WHEN NOT erasing THEN CASE WHEN e.result IS NULL THEN 'cancelled' ELSE 'completed' END
     WHEN v->>'state'='settled' AND v->>'outcome'='delivered' THEN 'completed' ELSE 'cancelled' END;
   -- Already-erased terminal rows remain immutable; no redundant UPDATE or content write.
   IF e.state IS DISTINCT FROM terminal THEN
    UPDATE runtime_executions SET state=terminal WHERE id=e.id RETURNING * INTO e;
   END IF;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   UPDATE runtime_executions SET state='cost_pending' WHERE id=e.id RETURNING * INTO e;
  END IF;
 ELSE v:=bill2_public(b);END IF;
 IF erasing THEN v:=(v-'scope')||'{"accountClosed":true}'::jsonb;END IF;
 RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state',e.state,'billing',v);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_revoke_unstarted_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_request_hash text, p_inspect boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;eligible boolean;erasing boolean;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 erasing:=bill2_erasure_closed(p_actor_id,r.pre_deduct_id);
 IF NOT erasing THEN PERFORM bill2_actor(p_actor_id);END IF;
 IF NOT erasing AND NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR p_token IS NULL OR c.token IS DISTINCT FROM p_token
  OR p_request_hash IS NULL OR c.payload->>'requestHash' IS DISTINCT FROM p_request_hash
  OR c.provider<>'openrouter' OR c.payload->>'protocol' IS DISTINCT FROM 'openrouter-chat-v1'
 THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- Retain the original token for exact idempotent readback. Cancelled state
 -- permanently prevents rotate/dispatch; bill2_record rejects NULL dispatch.
 IF c.dispatch_revoked_at IS NOT NULL THEN RETURN jsonb_build_object('revoked',true,'eligible',false);END IF;
 eligible:=NOT r.conflict AND c.state='dispatched' AND c.dispatched_at IS NOT NULL
  AND c.provider_id IS NULL AND c.selected_cost_usd IS NULL
  AND NOT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id)
  AND NOT EXISTS(SELECT 1 FROM bill2_provider_ids WHERE call_id=c.id);
 IF p_inspect THEN RETURN jsonb_build_object('revoked',false,'eligible',eligible);END IF;
 IF NOT eligible THEN RAISE EXCEPTION 'BILL2_UNSTARTED_DISPATCH_DENIED' USING ERRCODE='42501';END IF;
 -- The dispatch timestamp represented a permission grant, not observed HTTP.
 -- Preserve it before clearing the existing possible-dispatch accounting flag.
 UPDATE bill2_calls SET dispatch_granted_at=dispatched_at,dispatch_revoked_at=clock_timestamp(),dispatched_at=NULL,state='cancelled' WHERE id=c.id;
 PERFORM bill2_cancel(p_actor_id,r.id);
 PERFORM bill2_finalize(p_actor_id,r.id);
 RETURN jsonb_build_object('revoked',true,'eligible',false);
END $function$;

COMMIT;
