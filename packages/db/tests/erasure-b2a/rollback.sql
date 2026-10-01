-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Local-only structural rollback. Never restore erased content; refuse after first projection.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE bill2_runs, bill2_receipts IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM bill2_receipts WHERE financial_projection_version IS NOT NULL)
 OR EXISTS (SELECT 1 FROM bill2_runs WHERE result_financial_projection_version IS NOT NULL) THEN
  RAISE EXCEPTION 'ERASURE_ROLLBACK_REQUIRES_FORWARD_FIX';
 END IF;
END $$;
-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Exact Q1-verified originals, used only by local rollback tests.
CREATE OR REPLACE FUNCTION public.bill2_read(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;BEGIN PERFORM bill2_actor(p_actor_id);SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 RETURN bill2_public(r)||jsonb_build_object('calls',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'sequence',sequence,'state',state,'providerId',provider_id,'costUsd',selected_cost_usd::text,'recoveryAttempts',recovery_attempts) ORDER BY sequence),'[]') FROM bill2_calls WHERE run_id=r.id));END $function$;

CREATE OR REPLACE FUNCTION public.bill2_close(p_actor_id uuid, p_run_id uuid, p_outcome text, p_result jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.state IN ('settled','refunded') THEN RETURN bill2_public(r);END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('delivered','confirmed_failure','cancelled','unknown') THEN RAISE EXCEPTION 'BILL2_INVALID_OUTCOME';END IF;
 IF r.closed AND r.outcome<>'unknown' THEN IF r.outcome IS DISTINCT FROM p_outcome OR r.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'BILL2_CLOSE_CONFLICT';END IF;RETURN bill2_public(r);END IF;
 IF p_outcome IN ('delivered','confirmed_failure') AND (jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR coalesce(length(p_result->>'evidenceRef'),0)=0 OR coalesce(length(p_result->>'evidenceHash'),0)<>64
 OR p_result->>'kind' IS DISTINCT FROM CASE WHEN p_outcome='delivered' THEN 'usable_result' ELSE 'confirmed_delivery_failure' END) THEN RAISE EXCEPTION 'BILL2_OUTCOME_EVIDENCE_REQUIRED';END IF;
 IF octet_length(coalesce(p_result,'{}')::text)>262144 THEN RAISE EXCEPTION 'BILL2_RESULT_TOO_LARGE';END IF;
 UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid() WHERE run_id=r.id AND state='prepared';
 UPDATE bill2_runs SET closed=true,outcome=p_outcome,result=p_result,cancel_requested=cancel_requested OR p_outcome='cancelled',version=version+1,
 state=CASE WHEN p_outcome='unknown' THEN 'unknown' ELSE state END WHERE id=r.id RETURNING * INTO r;
 RETURN bill2_public(r);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_record(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;other_id uuid;h text;raw_cost numeric;cost numeric;bad boolean:=false;prior jsonb;currency text;piece jsonb;parts numeric:=0;detail_total numeric;total_observation jsonb;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_NOT_DISPATCHED';END IF;
 IF p_evidence->>'provider' IS DISTINCT FROM c.provider OR p_evidence->>'account' IS DISTINCT FROM c.account_namespace OR p_evidence->>'protocol' IS DISTINCT FROM c.payload->>'protocol'
 OR coalesce(p_evidence->>'sourceHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_evidence->'final') IS DISTINCT FROM 'boolean' OR coalesce(length(p_evidence->>'source'),0)=0 OR p_evidence->>'observedAt' IS NULL
 OR p_evidence->>'coverage' IS NULL OR p_evidence->>'coverage' NOT IN ('request_total','included_detail') THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
 h:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 IF EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND payload_hash=h) THEN RETURN bill2_public(r);END IF;
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
  INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict) VALUES(c.id,p_evidence,h,bad);
  UPDATE bill2_runs SET conflict=conflict OR bad,version=version+1,
   state=CASE WHEN state IN ('settled','refunded') OR c.selected_cost_usd IS NOT NULL THEN state
    WHEN coalesce(c.provider_id,p_evidence->>'providerId') IS NULL THEN 'unknown' ELSE 'cost_pending' END
   WHERE id=r.id RETURNING * INTO r;
  RETURN bill2_public(r);
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
 INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict) VALUES(c.id,p_evidence,h,bad);
 IF bad THEN UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=r.id RETURNING * INTO r;
 ELSE
  IF p_evidence->>'coverage'='request_total' AND p_evidence->>'final'='true' AND cost IS NOT NULL AND p_evidence->>'providerId' IS NOT NULL THEN
   UPDATE bill2_calls SET selected_cost_usd=cost,state='responded' WHERE id=c.id;
  ELSE UPDATE bill2_calls SET state=CASE WHEN selected_cost_usd IS NULL THEN 'unknown' ELSE state END WHERE id=c.id;END IF;
  IF r.state IN ('settled','refunded') THEN
   UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)=0 THEN coalesce(sum(selected_cost_usd),0) ELSE NULL END FROM bill2_calls WHERE run_id=r.id),version=version+1 WHERE id=r.id RETURNING * INTO r;
  ELSE UPDATE bill2_runs SET state=CASE WHEN p_evidence->>'providerId' IS NULL THEN 'unknown' ELSE 'cost_pending' END,version=version+1 WHERE id=r.id RETURNING * INTO r;END IF;
 END IF;
 RETURN bill2_public(r);
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid, p_execution_id uuid, p_finish boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR b.id IS NULL OR b.session_ref IS DISTINCT FROM e.session_id THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 IF e.result IS NULL AND runtime_history_available(e.id) AND e.state NOT IN ('cancelled','cost_pending')
 AND NOT EXISTS(SELECT 1 FROM runtime_test_windows w WHERE w.id=b.test_window_id
  AND (NOT w.enabled OR clock_timestamp()>=w.expires_at OR NOT(p_actor_id=ANY(w.actor_ids)))) THEN
  RAISE EXCEPTION 'RUNTIME_EXECUTION_STILL_ALLOWED';
 END IF;
 IF p_finish THEN
  IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
  ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
  v:=bill2_finalize(p_actor_id,b.id);
  IF v->>'state' IN ('settled','refunded') THEN
   UPDATE runtime_executions SET state=CASE WHEN result IS NULL THEN 'cancelled' ELSE 'completed' END WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   UPDATE runtime_executions SET state='cost_pending' WHERE id=e.id RETURNING * INTO e;
  END IF;
 ELSE v:=bill2_public(b);END IF;
 RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state',e.state,'billing',v);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_revoke_unstarted_dispatch(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_token uuid, p_request_hash text, p_inspect boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;eligible boolean;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
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

ALTER TABLE bill2_receipts DROP COLUMN financial_projection_hash,
 DROP COLUMN financial_projection_version, DROP COLUMN financial_projected_at;
ALTER TABLE bill2_runs DROP COLUMN result_financial_projection_hash, DROP COLUMN result_financial_projection_version;
DROP FUNCTION bill2_erasure_closed(uuid,uuid), bill2_erasure_view(bill2_runs,boolean),
 bill2_financial_projection(jsonb), bill2_outcome_projection(jsonb);
COMMIT;
