-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Only complete, bound OpenRouter 402 refusals gain a call-level no-charge fact.
-- Preserve dispatch timestamps, all previous costs and ambiguous holds. No remote backfill.
-- Replay accepts only the known predecessor or this migration's installed target.
-- Rollback: append a migration restoring the predecessor functions; retain the financial fact,
-- receipts and completed ledger entries. Never re-charge a released reservation.
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.bill2_record(uuid,uuid,uuid,jsonb)'::regprocedure)) NOT IN ('347c4ed918e43f9759cd040554fe091d','af7fa58b9000837c03e3e59e52ff3707') THEN
  RAISE EXCEPTION 'PROVIDER_REJECTION_SOURCE_MISMATCH: bill2_record(uuid,uuid,uuid,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure)) NOT IN ('1625da8f6a13a74250f7c454e84319ea','9ddbd0ebb4d5972fe24fa4aab4ad61dd') THEN
  RAISE EXCEPTION 'PROVIDER_REJECTION_SOURCE_MISMATCH: bill2_payg_finalize(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_finalize(uuid,uuid)'::regprocedure)) NOT IN ('4b188addd7ab9ab612d11f76ac6f82c2','5d31cead022196a89aed8e3d4d11458b') THEN
  RAISE EXCEPTION 'PROVIDER_REJECTION_SOURCE_MISMATCH: bill2_finalize(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_recovery_claim(uuid,uuid,uuid)'::regprocedure)) NOT IN ('2fe2d395ec29da937121faf957245f4c','7319df76a4ea58cb5584ee313817a74e') THEN
  RAISE EXCEPTION 'PROVIDER_REJECTION_SOURCE_MISMATCH: bill2_recovery_claim(uuid,uuid,uuid)';END IF;
END $$;
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS provider_rejected boolean NOT NULL DEFAULT false;
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS rejection_recovery_at timestamptz;

CREATE OR REPLACE FUNCTION public.bill2_record(p_actor_id uuid, p_run_id uuid, p_call_id uuid, p_evidence jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;other_id uuid;h text;raw_cost numeric;cost numeric;bad boolean:=false;prior jsonb;currency text;piece jsonb;parts numeric:=0;detail_total numeric;total_observation jsonb;erasing boolean;projection_hash text;rejection jsonb;pending_rejection boolean;lookup_audit jsonb;missing_count integer;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM bill2_payg_lock_models(r);
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_NOT_DISPATCHED';END IF;
 -- Match financial writers: run -> calls/receipts -> profile. Confirmation holds only the profile.
 PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
 PERFORM x.id FROM bill2_receipts x JOIN bill2_calls bc ON bc.id=x.call_id WHERE bc.run_id=r.id ORDER BY x.id FOR UPDATE OF x;
 PERFORM id FROM profiles WHERE id=p_actor_id FOR UPDATE;
 erasing:=bill2_erasure_closed(p_actor_id,coalesce(r.pre_deduct_id,r.id));

 IF p_evidence->>'provider' IS DISTINCT FROM c.provider OR p_evidence->>'account' IS DISTINCT FROM c.account_namespace OR p_evidence->>'protocol' IS DISTINCT FROM c.payload->>'protocol'
 OR coalesce(p_evidence->>'sourceHash','') !~ '^[a-f0-9]{64}$' OR jsonb_typeof(p_evidence->'final') IS DISTINCT FROM 'boolean' OR coalesce(length(p_evidence->>'source'),0)=0 OR p_evidence->>'observedAt' IS NULL
 OR p_evidence->>'coverage' IS NULL OR p_evidence->>'coverage' NOT IN ('request_total','included_detail') THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
 h:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 IF EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND payload_hash=h) THEN RETURN bill2_erasure_view(r,erasing);END IF;
 -- Only a server-issued claim may contribute once to the Owner-approved 404 rule.
 IF p_evidence ? 'rejectionRecovery' THEN
  IF c.provider<>'openrouter' OR c.payload->>'protocol'<>'openrouter-chat-v1'
   OR p_evidence->>'source' IS DISTINCT FROM 'lookup'
   OR p_evidence->>'expectedProviderId' IS DISTINCT FROM c.provider_id
   OR p_evidence->>'model' IS DISTINCT FROM c.model
   OR c.rejection_recovery_at IS NULL
   OR p_evidence#>'{rejectionRecovery,attempt}' IS DISTINCT FROM to_jsonb(c.recovery_attempts)
   OR (p_evidence#>>'{rejectionRecovery,claimedAt}')::timestamptz IS DISTINCT FROM c.rejection_recovery_at
   OR NOT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id
     AND NOT conflict AND payload->>'evidenceKind'='provider_rejection_pending')
   OR EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id
     AND payload#>'{rejectionRecovery,attempt}'=to_jsonb(c.recovery_attempts))
  THEN RAISE EXCEPTION 'BILL2_REJECTION_LOOKUP_DENIED';END IF;
  SELECT count(DISTINCT payload#>>'{rejectionRecovery,attempt}') INTO missing_count
   FROM bill2_receipts WHERE call_id=c.id AND NOT conflict
    AND payload->>'evidenceKind'='provider_rejection_lookup';
  lookup_audit:=jsonb_build_object('notFoundCount',missing_count+
   CASE WHEN p_evidence->>'evidenceKind'='provider_rejection_lookup' THEN 1 ELSE 0 END,
   'attempt',c.recovery_attempts,'claimedAt',c.rejection_recovery_at,
   'observedAt',clock_timestamp(),'notFound',coalesce(p_evidence->>'evidenceKind'='provider_rejection_lookup',false),
   'httpStatus',CASE WHEN p_evidence#>>'{transport,httpStatus}' ~ '^[1-5][0-9]{2}$'
    THEN (p_evidence#>>'{transport,httpStatus}')::integer END);
  IF p_evidence->>'evidenceKind'='provider_rejection_lookup' THEN
   IF p_evidence#>'{transport,httpStatus}' IS DISTINCT FROM '404'::jsonb
    OR p_evidence#>'{transport,complete}' IS DISTINCT FROM 'true'::jsonb
    OR p_evidence#>>'{transport,transportIssue}' IS NOT NULL
    OR p_evidence->>'cost' IS NOT NULL OR p_evidence->'final' IS DISTINCT FROM 'false'::jsonb
    OR p_evidence->>'providerId' IS NOT NULL
    OR p_evidence->'usage' IS NOT NULL AND p_evidence->'usage'<>'null'::jsonb
   THEN RAISE EXCEPTION 'BILL2_REJECTION_LOOKUP_DENIED';END IF;
   p_evidence:=bill2_financial_projection(p_evidence-'evidenceKind')||jsonb_build_object(
    'evidenceKind','provider_rejection_lookup','usage',NULL,'rejectionRecovery',lookup_audit);
   projection_hash:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
   INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,
    financial_projection_version,financial_projected_at)
   VALUES(c.id,p_evidence,h,false,projection_hash,1,clock_timestamp());
   SELECT count(DISTINCT payload#>>'{rejectionRecovery,attempt}') INTO missing_count
    FROM bill2_receipts WHERE call_id=c.id AND NOT conflict
     AND payload->>'evidenceKind'='provider_rejection_lookup'
     AND payload#>'{rejectionRecovery,notFound}'='true'::jsonb;
   IF missing_count=3 AND c.recovery_attempts=3 AND c.selected_cost_usd IS NULL
    AND NOT c.provider_rejected AND NOT r.conflict AND r.state NOT IN ('settled','refunded')
    AND r.outcome IS DISTINCT FROM 'delivered'
    AND NOT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND
     (conflict OR payload->>'cost' IS NOT NULL OR payload->'final'='true'::jsonb
      OR payload->'usage' IS NOT NULL AND payload->'usage'<>'null'::jsonb
      OR (payload->>'source'='lookup' AND payload->>'evidenceKind' IS DISTINCT FROM 'provider_rejection_lookup'))) THEN
    UPDATE bill2_calls SET provider_rejected=true,selected_cost_usd=0,state='responded' WHERE id=c.id;
    PERFORM bill2_cancel(p_actor_id,r.id);
    PERFORM bill2_finalize(p_actor_id,r.id);
   END IF;
   SELECT * INTO r FROM bill2_runs WHERE id=r.id;
   RETURN bill2_erasure_view(r,erasing);
  END IF;
  -- Any other result uses ordinary cost/conflict handling. Its claim cannot also count as 404.
  p_evidence:=bill2_financial_projection(p_evidence)||jsonb_build_object('rejectionRecovery',lookup_audit);
  projection_hash:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 ELSIF p_evidence->>'evidenceKind'='provider_rejection_lookup' THEN
  RAISE EXCEPTION 'BILL2_REJECTION_LOOKUP_DENIED';
 END IF;
 -- A complete refusal is evidence about this call, never a whole-run refund.
 IF p_evidence->>'evidenceKind' IN ('provider_rejection','provider_rejection_pending') THEN
  pending_rejection:=p_evidence->>'evidenceKind'='provider_rejection_pending';
  IF c.provider<>'openrouter' OR c.payload->>'protocol'<>'openrouter-chat-v1'
   OR p_evidence->>'source' IS DISTINCT FROM 'response'
   OR p_evidence->>'requestHash' IS DISTINCT FROM c.payload->>'requestHash'
   OR p_evidence->>'model' IS DISTINCT FROM c.model
   OR (NOT pending_rejection AND p_evidence->>'providerId' IS NOT NULL) OR p_evidence->>'cost' IS NOT NULL
   OR p_evidence->'usage' IS NOT NULL AND p_evidence->'usage'<>'null'::jsonb
   OR p_evidence->'final' IS DISTINCT FROM 'false'::jsonb
   OR p_evidence->>'coverage' IS DISTINCT FROM 'request_total'
   OR p_evidence#>'{transport,httpStatus}' IS DISTINCT FROM '402'::jsonb
   OR p_evidence#>'{transport,complete}' IS DISTINCT FROM 'true'::jsonb
   OR p_evidence#>>'{transport,transportIssue}' IS NOT NULL
   OR (NOT pending_rejection AND p_evidence#>>'{transport,generationId}' IS NOT NULL)
   OR NOT coalesce((p_evidence->>'rawBody') IS JSON OBJECT WITH UNIQUE KEYS,false)
   OR octet_length(p_evidence->>'rawBody')>65536
   OR encode(sha256(convert_to(p_evidence->>'rawBody','utf8')),'hex') IS DISTINCT FROM p_evidence->>'sourceHash'
   OR p_evidence#>>'{transport,sourceHash}' IS DISTINCT FROM p_evidence->>'sourceHash'
   OR (NOT pending_rejection AND c.provider_id IS NOT NULL) OR c.selected_cost_usd IS NOT NULL OR c.provider_rejected
   OR r.conflict OR r.state IN ('settled','refunded') OR r.outcome='delivered'
   OR (NOT pending_rejection AND EXISTS(SELECT 1 FROM bill2_provider_ids WHERE call_id=c.id))
   OR EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND (NOT pending_rejection
    OR conflict OR payload->>'evidenceKind' IS DISTINCT FROM 'transport_observation'
    OR payload->>'source' IS DISTINCT FROM 'response' OR payload->>'cost' IS NOT NULL
    OR payload->'final' IS DISTINCT FROM 'false'::jsonb OR payload ? 'rawBody' OR payload ? 'transport'
    OR payload->'usage' IS NOT NULL AND payload->'usage'<>'null'::jsonb
    OR payload->>'providerId' IS DISTINCT FROM p_evidence->>'providerId'))
   OR (pending_rejection AND (c.recovery_attempts<>0
    OR coalesce(length(p_evidence->>'providerId'),0) NOT BETWEEN 1 AND 256
    OR p_evidence->>'providerId' !~ '^[a-zA-Z0-9._:-]+$'
    OR p_evidence#>>'{transport,generationId}' IS DISTINCT FROM p_evidence->>'providerId'
    OR (c.provider_id IS NOT NULL AND c.provider_id IS DISTINCT FROM p_evidence->>'providerId')))
  THEN RAISE EXCEPTION 'BILL2_REJECTION_PROOF_DENIED';END IF;
  rejection:=(p_evidence->>'rawBody')::jsonb;
  IF rejection-ARRAY['error','user_id']<>'{}'::jsonb
   OR (rejection ? 'user_id' AND jsonb_typeof(rejection->'user_id') NOT IN ('string','null'))
   OR jsonb_typeof(rejection->'error') IS DISTINCT FROM 'object'
   OR (rejection->'error')-ARRAY['code','message','metadata']<>'{}'::jsonb
   OR rejection#>'{error,code}' IS DISTINCT FROM '402'::jsonb
   OR jsonb_typeof(rejection#>'{error,message}') IS DISTINCT FROM 'string'
   OR jsonb_typeof(rejection#>'{error,metadata}') IS DISTINCT FROM 'object'
   OR (rejection#>'{error,metadata}')-ARRAY['limit_source','reason','remedy_hint','provider_name']<>'{}'::jsonb
   OR coalesce(rejection#>>'{error,metadata,limit_source}','') NOT IN
    ('openrouter_key_limit','openrouter_credits','openrouter_in_flight_budget')
   OR (rejection#>'{error,metadata}' ? 'provider_name' AND jsonb_typeof(rejection#>'{error,metadata,provider_name}') NOT IN ('string','null'))
   OR (rejection#>'{error,metadata}' ? 'reason' AND jsonb_typeof(rejection#>'{error,metadata,reason}')<>'string')
   OR (rejection#>'{error,metadata}' ? 'remedy_hint' AND jsonb_typeof(rejection#>'{error,metadata,remedy_hint}')<>'string')
  THEN RAISE EXCEPTION 'BILL2_REJECTION_PROOF_DENIED';END IF;
  IF pending_rejection THEN
   INSERT INTO bill2_provider_ids VALUES(c.provider,c.account_namespace,p_evidence->>'providerId',c.id) ON CONFLICT DO NOTHING;
   SELECT call_id INTO other_id FROM bill2_provider_ids WHERE provider=c.provider AND account_namespace=c.account_namespace
    AND provider_id=p_evidence->>'providerId';
   IF other_id IS DISTINCT FROM c.id THEN RAISE EXCEPTION 'BILL2_REJECTION_PROOF_DENIED';END IF;
   UPDATE bill2_calls SET provider_id=p_evidence->>'providerId' WHERE id=c.id;
  END IF;
  IF erasing OR pending_rejection THEN
   -- Reuse the existing content-free projection, then restore only verified refusal fields.
   p_evidence:=bill2_financial_projection(p_evidence-'evidenceKind')||jsonb_build_object('evidenceKind',p_evidence->>'evidenceKind',
    'usage',NULL,'requestHash',c.payload->>'requestHash','limitSource',rejection#>>'{error,metadata,limit_source}');
   projection_hash:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
  END IF;
  INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,
   financial_projection_version,financial_projected_at)
  VALUES(c.id,p_evidence,h,false,projection_hash,CASE WHEN erasing OR pending_rejection THEN 1 END,CASE WHEN erasing OR pending_rejection THEN clock_timestamp() END);
  IF NOT pending_rejection THEN
   UPDATE bill2_calls SET provider_rejected=true,selected_cost_usd=0,state='responded' WHERE id=c.id;
  END IF;
  -- Existing cancellation closes future claims; its financial outcome preserves previous charges.
  UPDATE bill2_runs SET state='cost_pending',version=version+1 WHERE id=r.id;
  PERFORM bill2_cancel(p_actor_id,r.id);
  PERFORM bill2_finalize(p_actor_id,r.id);
  SELECT * INTO r FROM bill2_runs WHERE id=r.id;
  RETURN bill2_erasure_view(r,erasing);
 END IF;
 -- A later contradictory receipt cannot overwrite a proven refusal or recharge its hold.
 bad:=c.provider_rejected;
 IF erasing THEN
  -- Keep the conflict fact, never an arbitrary mismatching model string.
  IF p_evidence->>'model' IS DISTINCT FROM c.model THEN p_evidence:=jsonb_set(p_evidence,'{model}','null'::jsonb);END IF;
  p_evidence:=bill2_financial_projection(p_evidence)||CASE WHEN lookup_audit IS NULL THEN '{}'::jsonb
   ELSE jsonb_build_object('rejectionRecovery',lookup_audit) END;
  projection_hash:=encode(sha256(convert_to(p_evidence::text,'utf8')),'hex');
 END IF;
 IF p_evidence->>'providerId' IS NOT NULL THEN
  IF length(p_evidence->>'providerId') NOT BETWEEN 1 AND 256 THEN RAISE EXCEPTION 'BILL2_INVALID_PROVIDER_ID';END IF;
  INSERT INTO bill2_provider_ids VALUES(c.provider,c.account_namespace,p_evidence->>'providerId',c.id) ON CONFLICT DO NOTHING;
  SELECT call_id INTO other_id FROM bill2_provider_ids WHERE provider=c.provider AND account_namespace=c.account_namespace AND provider_id=p_evidence->>'providerId';
  bad:=bad OR other_id<>c.id OR (c.provider_id IS NOT NULL AND c.provider_id IS DISTINCT FROM p_evidence->>'providerId');
  IF NOT bad THEN UPDATE bill2_calls SET provider_id=p_evidence->>'providerId' WHERE id=c.id;END IF;
 END IF;
 -- Transport observations preserve diagnostics/IDs but never assert cost, finality or delivery.
 IF p_evidence->>'evidenceKind'='transport_observation' THEN
  IF p_evidence->>'cost' IS NOT NULL OR p_evidence->>'final' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'BILL2_UNTRUSTED_RECEIPT';END IF;
  bad:=bad OR (p_evidence->>'providerId' IS NOT NULL AND p_evidence->>'expectedProviderId' IS NOT NULL AND p_evidence->>'expectedProviderId' IS DISTINCT FROM p_evidence->>'providerId');
  INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,financial_projection_version,financial_projected_at)
 VALUES(c.id,p_evidence,h,bad,projection_hash,CASE WHEN erasing OR lookup_audit IS NOT NULL THEN 1 END,CASE WHEN erasing OR lookup_audit IS NOT NULL THEN clock_timestamp() END);
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
 IF raw_cost IS NOT NULL AND parts>raw_cost AND r.contract_version='bill2.v1' THEN bad:=true;END IF;
 IF p_evidence->>'coverage'='request_total' THEN
  FOR prior IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND payload->>'coverage'='request_total' AND payload->>'final'='true' AND payload->>'cost' IS NOT NULL LOOP
   IF bill2_decimal(prior->'cost') IS DISTINCT FROM raw_cost OR prior->>'currency' IS DISTINCT FROM currency OR prior->>'model' IS DISTINCT FROM p_evidence->>'model' OR p_evidence->>'final' IS DISTINCT FROM 'true' THEN bad:=true;END IF;
  END LOOP;
  IF cost IS NOT NULL AND cost>c.upper_usd THEN
   IF r.contract_version='bill2.v1' THEN bad:=true;
   ELSE UPDATE bill2_calls SET budget_conflict=true WHERE id=c.id;END IF;END IF;
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
  IF r.contract_version='bill2.v1' AND (detail_total>bill2_decimal(total_observation->'cost') OR EXISTS(
   SELECT 1 FROM (SELECT payload FROM bill2_receipts WHERE call_id=c.id UNION ALL SELECT p_evidence) obs
   WHERE payload->>'coverage'='included_detail' AND payload->>'cost' IS NOT NULL AND payload->>'currency' IS DISTINCT FROM total_observation->>'currency')) THEN bad:=true;END IF;
 END LOOP;
 INSERT INTO bill2_receipts(call_id,payload,payload_hash,conflict,financial_projection_hash,financial_projection_version,financial_projected_at)
 VALUES(c.id,p_evidence,h,bad,projection_hash,CASE WHEN erasing OR lookup_audit IS NOT NULL THEN 1 END,CASE WHEN erasing OR lookup_audit IS NOT NULL THEN clock_timestamp() END);
 IF bad THEN UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=r.id RETURNING * INTO r;
 ELSE
  IF p_evidence->>'coverage'='request_total' AND p_evidence->>'final'='true' AND cost IS NOT NULL AND p_evidence->>'providerId' IS NOT NULL THEN
   UPDATE bill2_calls SET selected_cost_usd=cost,state='responded' WHERE id=c.id;
  ELSE UPDATE bill2_calls SET state=CASE WHEN selected_cost_usd IS NULL THEN 'unknown' ELSE state END WHERE id=c.id;END IF;
  IF r.state IN ('settled','refunded') THEN
   UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)=0 THEN coalesce(sum(selected_cost_usd),0) ELSE NULL END FROM bill2_calls WHERE run_id=r.id),version=version+1 WHERE id=r.id RETURNING * INTO r;
  ELSE UPDATE bill2_runs SET state=CASE WHEN p_evidence->>'providerId' IS NULL THEN 'unknown' ELSE 'cost_pending' END,version=version+1 WHERE id=r.id RETURNING * INTO r;END IF;
 END IF;
 IF r.contract_version='bill2.v2' THEN
  PERFORM bill2_payg_finalize(p_actor_id,r.id);SELECT * INTO r FROM bill2_runs WHERE id=r.id;
 END IF;
 RETURN bill2_erasure_view(r,erasing);
END $function$;

CREATE OR REPLACE FUNCTION bill2_payg_finalize(a uuid,rid uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;rec record;usage jsonb;selected_usage jsonb;v numeric;n numeric;w numeric;delta numeric;
 bounded numeric;debit integer;cap numeric;bound numeric;before_balance integer;after_balance integer;restored integer;
 release_amount integer;q record;meta jsonb;spent uuid;source text;bad boolean;missing boolean;erasing boolean;pending boolean;
 prices jsonb;read_margin numeric;write_margin numeric;other_margin numeric;pt bigint;ct bigint;wt bigint;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;
 IF r.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 PERFORM bill2_payg_lock_models(r);
 PERFORM id FROM bill2_calls WHERE run_id=rid ORDER BY id FOR UPDATE;
 PERFORM e.id FROM bill2_receipts e JOIN bill2_calls bc ON bc.id=e.call_id WHERE bc.run_id=rid ORDER BY e.id FOR UPDATE OF e;
 PERFORM id FROM profiles WHERE id=a FOR UPDATE;
 IF NOT bill2_payg_financial_binding(r) THEN RAISE EXCEPTION 'BILL2_FINANCIAL_BINDING_DENIED';END IF;
 erasing:=bill2_erasure_closed(a,rid);
 IF erasing AND NOT r.closed THEN
  PERFORM bill2_cancel(a,rid);SELECT * INTO r FROM bill2_runs WHERE id=rid;
 END IF;
 FOR c IN SELECT * FROM bill2_calls WHERE run_id=rid ORDER BY provider_rejected DESC,sequence LOOP
  n:=NULL;selected_usage:=NULL;bad:=false;source:='nominal';
  FOR rec IN SELECT payload FROM bill2_receipts WHERE call_id=c.id AND NOT conflict
   AND payload->>'coverage'='request_total' AND payload->>'final'='true' ORDER BY created_at,id LOOP
   usage:=rec.payload->'usage';
   BEGIN
    v:=bill2_payg_nominal(c.payload->'payg'->'nominalPricing',usage);
    IF v IS NOT NULL THEN
     IF n IS NOT NULL AND (n<>v OR selected_usage->>'inputTokens' IS DISTINCT FROM usage->>'inputTokens'
      OR selected_usage->>'outputTokens' IS DISTINCT FROM usage->>'outputTokens'
      OR selected_usage->>'reasoningTokens' IS DISTINCT FROM usage->>'reasoningTokens') THEN bad:=true;END IF;
     n:=v;selected_usage:=usage;
    END IF;
   EXCEPTION WHEN OTHERS THEN bad:=true;
   END;
  END LOOP;
  -- Late data may reconstruct nominal value but can never rewrite a settled debit.
  IF c.settled_at IS NOT NULL THEN
   PERFORM bill2_payg_compensate(r,c);
   IF c.nominal_source='actual_fallback' AND n IS NOT NULL THEN UPDATE bill2_calls SET nominal_reconstructed_usd=n WHERE id=c.id;END IF;
   CONTINUE;
  END IF;
  IF bad THEN UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=rid RETURNING * INTO r;EXIT;END IF;
  IF c.provider_rejected OR c.dispatched_at IS NULL OR (r.closed AND r.outcome='confirmed_failure') THEN
   IF c.dispatched_at IS NULL AND c.state<>'cancelled' THEN CONTINUE;END IF;
   n:=0;delta:=0;bounded:=0;debit:=0;cap:=0;bound:=0;source:=CASE WHEN c.dispatched_at IS NULL THEN 'not_dispatched' ELSE 'confirmed_failure' END;
  ELSE
   IF r.conflict OR c.selected_cost_usd IS NULL THEN EXIT;END IF;
   IF n IS NULL THEN
    IF c.recovery_attempts<3 AND clock_timestamp()<c.created_at+interval '24 hours'
     AND c.payload->>'lookupSupported'='true' AND c.provider_id IS NOT NULL THEN EXIT;END IF;
    n:=least(c.selected_cost_usd,c.upper_usd);source:='actual_fallback';
    UPDATE bill2_calls SET metering_missing=true WHERE id=c.id;
   END IF;
   w:=r.weighted_nominal_usd;
   delta:=ceil((w+n*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'))*r.credits_per_usd)-ceil(w*r.credits_per_usd);
   bounded:=ceil((w+least(n,c.upper_usd)*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'))*r.credits_per_usd)-ceil(w*r.credits_per_usd);
   debit:=least(delta,c.reserved_credits)::int;cap:=greatest(bounded-c.reserved_credits,0);bound:=delta-debit-cap;
   UPDATE bill2_calls SET budget_conflict=budget_conflict OR n>upper_usd OR selected_cost_usd>upper_usd
    OR coalesce((selected_usage->>'inputTokens')::bigint>(payload->'payg'->>'promptTokensUpper')::bigint,false)
    OR coalesce((selected_usage->>'outputTokens')::bigint>(payload->>'outputLimit')::bigint,false),
    metering_exit=coalesce(payload->>'protocol'<>'fixture-cost-v1' AND
     ((selected_usage->>'inputTokens')::numeric*5>=(payload->'payg'->>'bytes')::numeric*4
      OR (selected_usage->>'inputTokens')::numeric*5>=(payload->'payg'->>'promptTokensUpper')::numeric*4),false),
    reconciliation_anomaly=CASE WHEN coalesce(selected_usage->>'cachedTokens','0') ~ '^(0|[1-9][0-9]{0,9})$'
     AND coalesce(selected_usage->>'cacheCreationTokens','0') ~ '^(0|[1-9][0-9]{0,9})$'
     THEN coalesce((selected_usage->>'cachedTokens')::bigint,0)+coalesce((selected_usage->>'cacheCreationTokens')::bigint,0)>coalesce((selected_usage->>'inputTokens')::bigint,0)
     ELSE true END
    WHERE id=c.id;
  END IF;
  read_margin:=NULL;write_margin:=NULL;other_margin:=NULL;
  IF source='nominal' AND selected_usage->>'inputTokens' IS NOT NULL THEN
   pt:=(selected_usage->>'inputTokens')::bigint;
   prices:=bill2_payg_prices(c.payload->'payg'->'nominalPricing',pt);
   ct:=CASE WHEN selected_usage->>'cachedTokens' ~ '^(0|[1-9][0-9]{0,9})$' THEN (selected_usage->>'cachedTokens')::bigint END;
   wt:=CASE WHEN selected_usage->>'cacheCreationTokens' ~ '^(0|[1-9][0-9]{0,9})$' THEN (selected_usage->>'cacheCreationTokens')::bigint END;
   IF NOT coalesce(ct+wt>pt,false) THEN
    IF ct<=pt AND prices ? 'cacheRead' THEN read_margin:=ct*(bill2_decimal(prices->'prompt')-bill2_decimal(prices->'cacheRead'))/1000000;END IF;
    IF wt<=pt AND prices ? 'cacheWrite' THEN write_margin:=wt*(bill2_decimal(prices->'prompt')-bill2_decimal(prices->'cacheWrite'))/1000000;END IF;
    other_margin:=n-c.selected_cost_usd-read_margin-write_margin;
   END IF;
  END IF;
  SELECT credits INTO before_balance FROM profiles WHERE id=a;
  meta:=jsonb_build_object('contractVersion','bill2.v2','runId',rid,'callId',c.id,'preDeductId',c.pre_deduct_id,
   'providerCostUsd',c.selected_cost_usd::text,'nominalCostUsd',n::text,'nominalSource',source,
   'theoreticalDelta',delta::text,'chargedDelta',debit,'platformCapCredits',cap::text,'platformBoundCredits',bound::text);
  IF c.dispatched_at IS NULL OR source='confirmed_failure' THEN
   SELECT * INTO q FROM bill2_legacy_refund(a,c.pre_deduct_id,'BILL2 undispatched call');restored:=q.refund_amount;
  ELSE
   SELECT * INTO q FROM bill2_legacy_settle(a,c.pre_deduct_id,debit,meta,NULL);restored:=q.difference;
  END IF;
  after_balance:=q.balance_after;release_amount:=restored+debit;
  IF restored<0 OR after_balance-before_balance<>restored OR release_amount>c.reserved_credits THEN RAISE EXCEPTION 'BILL2_SOURCE_CONSERVATION';END IF;
  INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
   idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
  VALUES(a,release_amount,'adjustment','Call reservation release','adjustment','bill2_release','ai_task',rid::text,
   'bill2:'||c.id||':release',before_balance,before_balance::bigint+release_amount,rid,c.id,meta);
  IF c.dispatched_at IS NOT NULL AND source<>'confirmed_failure' THEN
   INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
    idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
   VALUES(a,-debit,'consumption','AI call consumption','spend','bill2_spend','ai_task',rid::text,
    'bill2:'||c.id||':spend',before_balance::bigint+release_amount,after_balance,rid,c.id,meta) RETURNING id INTO spent;
   UPDATE billing_history SET transaction_id=spent WHERE operation_type='settle' AND metadata->>'preDeductId'=c.pre_deduct_id::text;
   INSERT INTO token_stats(bill2_run_id,bill2_call_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
   VALUES(rid,c.id,a,c.model,(selected_usage->>'inputTokens')::int,(selected_usage->>'outputTokens')::int,
    NULL,NULL,NULL,c.selected_cost_usd,debit,meta);
   INSERT INTO ai_usage_logs(bill2_run_id,bill2_call_id,user_id,request_id,model_id,status,metadata)
   VALUES(rid,c.id,a,c.id::text,c.model,'success',meta);
  END IF;
  UPDATE bill2_calls SET nominal_cost_usd=n,nominal_source=source,theoretical_delta=delta,charged_delta=debit,
   platform_absorbed_cap_credits=cap,platform_absorbed_bound_credits=bound,settled_at=clock_timestamp(),
   platform_margin_cache_read_usd=read_margin,platform_margin_cache_write_usd=write_margin,platform_margin_other_usd=other_margin WHERE id=c.id;
  UPDATE bill2_runs SET nominal_cost_usd=nominal_cost_usd+n,
   weighted_nominal_usd=weighted_nominal_usd+n*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'),
   theoretical_credits=theoretical_credits+delta,charged=coalesce(bill2_runs.charged,0)+debit,
   platform_absorbed_credits=platform_absorbed_credits+cap+bound,actual_restore=coalesce(actual_restore,0)+restored,
   version=version+1 WHERE id=rid RETURNING * INTO r;
 END LOOP;
 SELECT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND settled_at IS NULL) INTO pending;
 UPDATE bill2_runs SET provider_cost_usd=(SELECT CASE WHEN count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL)>0
  THEN NULL ELSE coalesce(sum(selected_cost_usd),0) END FROM bill2_calls WHERE run_id=rid),
  state=CASE WHEN closed AND NOT pending THEN CASE WHEN outcome<>'confirmed_failure' AND EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND dispatched_at IS NOT NULL AND NOT provider_rejected) THEN 'settled' ELSE 'refunded' END
   WHEN pending THEN 'cost_pending' ELSE 'prepared' END,
  charged=coalesce(bill2_runs.charged,0) WHERE id=rid RETURNING * INTO r;
 IF r.theoretical_credits<>coalesce(r.charged,0)+r.platform_absorbed_credits THEN RAISE EXCEPTION 'BILL2_PAYG_CONSERVATION';END IF;
 RETURN bill2_erasure_view(r,erasing);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_finalize(p_actor_id uuid, p_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;n integer;pending integer;cost numeric;credits integer:=0;before_balance integer;after_balance integer;restored integer;release_amount integer;spent uuid;meta jsonb;q record;weighted_cost numeric;
BEGIN
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id AND contract_version='bill2.v2') THEN RETURN bill2_payg_finalize(p_actor_id,p_run_id); END IF;
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.state IN ('settled','refunded') THEN RETURN bill2_public(r);END IF;
 IF NOT r.closed THEN RAISE EXCEPTION 'BILL2_CALL_SET_OPEN';END IF;
 -- All receipt/call writers take the run lock first. Read/lock order is deterministic.
 PERFORM id FROM bill2_calls WHERE run_id=r.id ORDER BY id FOR UPDATE;
 PERFORM e.id FROM bill2_receipts e JOIN bill2_calls c ON c.id=e.call_id WHERE c.run_id=r.id ORDER BY e.id FOR UPDATE OF e;
 SELECT count(*) FILTER(WHERE dispatched_at IS NOT NULL AND NOT provider_rejected),count(*) FILTER(WHERE dispatched_at IS NOT NULL AND selected_cost_usd IS NULL),coalesce(sum(selected_cost_usd),0)
 INTO n,pending,cost FROM bill2_calls WHERE run_id=r.id;
 -- BILL-UNIT: N = ceil(q × Σ(cost_i × m_i)), rounded once; runs without billingUnit keep ceil(Σcost × q × m).
 IF jsonb_typeof(r.payload->'rules'->'billingUnit')='object' THEN
  SELECT coalesce(sum(selected_cost_usd*bill2_unit_multiplier(payload->'billingUnit'->'multiplier')),0) INTO weighted_cost
  FROM bill2_calls WHERE run_id=r.id AND selected_cost_usd IS NOT NULL;
 END IF;
 IF n>0 AND r.outcome IS DISTINCT FROM 'confirmed_failure' THEN
  IF r.conflict OR pending>0 OR r.outcome='unknown' THEN RETURN bill2_public(r);END IF;
  IF r.outcome IS NULL OR r.outcome NOT IN ('delivered','cancelled') THEN RAISE EXCEPTION 'BILL2_OUTCOME_REQUIRED';END IF;
  IF cost>r.budget_usd OR ceil(CASE WHEN weighted_cost IS NULL THEN cost*r.credits_per_usd*r.multiplier ELSE weighted_cost*r.credits_per_usd END)>r.reserved THEN
   UPDATE bill2_runs SET conflict=true,version=version+1 WHERE id=r.id RETURNING * INTO r;RETURN bill2_public(r);END IF;
  credits:=ceil(CASE WHEN weighted_cost IS NULL THEN cost*r.credits_per_usd*r.multiplier ELSE weighted_cost*r.credits_per_usd END)::integer;
 END IF;
 SELECT p.credits INTO before_balance FROM profiles p WHERE p.id=p_actor_id FOR UPDATE;
 meta:=jsonb_build_object('contractVersion',r.contract_version,'runId',r.id,'preDeductId',r.pre_deduct_id,'outcome',r.outcome,'providerCostUsd',CASE WHEN pending=0 THEN cost::text ELSE NULL END);
 IF n=0 OR r.outcome='confirmed_failure' THEN
  SELECT * INTO q FROM bill2_legacy_refund(p_actor_id,r.pre_deduct_id,'BILL2 confirmed failure or no dispatch');
  restored:=q.refund_amount;after_balance:=q.balance_after;release_amount:=restored;
 ELSE
  SELECT * INTO q FROM bill2_legacy_settle(p_actor_id,r.pre_deduct_id,credits,meta,NULL);
  restored:=q.difference;after_balance:=q.balance_after;release_amount:=restored+credits;
 END IF;
 SELECT meta || b.metadata INTO meta FROM billing_history b WHERE b.metadata->>'preDeductId'=r.pre_deduct_id::text AND b.operation_type IN ('settle','refund','abort_settle');
 IF after_balance-before_balance<>restored OR restored<0 OR release_amount>r.reserved THEN RAISE EXCEPTION 'BILL2_SOURCE_CONSERVATION';END IF;
 INSERT INTO credit_transactions(created_at,user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
 VALUES(greatest(clock_timestamp(),coalesce((SELECT max(t.created_at)+interval '1 microsecond' FROM credit_transactions t WHERE t.user_id=p_actor_id),'-infinity'::timestamptz)),p_actor_id,release_amount,'adjustment','Run reservation release','adjustment','bill2_release','ai_task',r.id::text,'bill2:'||r.id||':release',before_balance,before_balance::bigint+release_amount,r.id,meta||jsonb_build_object('nominalReserved',r.reserved,'actualRestore',restored,'intercepted',r.reserved-release_amount));
 IF n>0 AND r.outcome<>'confirmed_failure' THEN
  INSERT INTO credit_transactions(created_at,user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
  VALUES(greatest(clock_timestamp(),coalesce((SELECT max(t.created_at)+interval '1 microsecond' FROM credit_transactions t WHERE t.user_id=p_actor_id),'-infinity'::timestamptz)),p_actor_id,-credits,'consumption','AI run consumption','spend','bill2_spend','ai_task',r.id::text,'bill2:'||r.id||':spend',before_balance::bigint+release_amount,after_balance,r.id,meta) RETURNING id INTO spent;
  UPDATE billing_history SET transaction_id=spent WHERE operation_type='settle' AND metadata->>'preDeductId'=r.pre_deduct_id::text;
  INSERT INTO token_stats(bill2_run_id,user_id,model_used,input_tokens,output_tokens,cached_tokens,cache_creation_tokens,web_search_count,total_cost_usd,total_credits,metadata)
  VALUES(r.id,p_actor_id,'bill2.aggregate',bill2_usage_total(r.id,'inputTokens'),bill2_usage_total(r.id,'outputTokens'),bill2_usage_total(r.id,'cachedTokens'),bill2_usage_total(r.id,'cacheCreationTokens'),bill2_usage_total(r.id,'webSearchCount'),cost,credits,meta||jsonb_build_object('usageInPrivateReceipts',true));
  INSERT INTO ai_usage_logs(bill2_run_id,user_id,request_id,model_id,status,metadata)
  VALUES(r.id,p_actor_id,r.request_id::text,'bill2.aggregate','success',meta);
 END IF;
 UPDATE bill2_runs SET state=CASE WHEN n=0 OR outcome='confirmed_failure' THEN 'refunded' ELSE 'settled' END,
 charged=credits,actual_restore=restored,provider_cost_usd=CASE WHEN pending=0 THEN cost ELSE NULL END,version=version+1 WHERE id=r.id RETURNING * INTO r;
 RETURN bill2_public(r);
END $function$;
CREATE OR REPLACE FUNCTION public.bill2_recovery_claim(p_actor_id uuid, p_run_id uuid, p_call_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;candidate boolean;claimed_at timestamptz;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NULL THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL OR c.dispatched_at IS NULL OR c.provider_id IS NULL OR (c.selected_cost_usd IS NOT NULL AND (r.contract_version='bill2.v1' OR c.settled_at IS NOT NULL)) OR c.recovery_attempts>=3
 OR clock_timestamp()>(CASE WHEN r.contract_version='bill2.v2' THEN c.created_at+interval '24 hours' ELSE r.deadline+interval '24 hours' END) OR c.payload->>'lookupSupported' IS DISTINCT FROM 'true' OR r.conflict THEN RETURN NULL;END IF;
 SELECT EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=c.id AND NOT conflict
  AND payload->>'evidenceKind'='provider_rejection_pending') INTO candidate;
 claimed_at:=clock_timestamp();
 IF candidate AND c.rejection_recovery_at IS NOT NULL
  AND claimed_at<c.rejection_recovery_at+interval '5 minutes' THEN RETURN NULL;END IF;
 UPDATE bill2_calls SET recovery_attempts=recovery_attempts+1,
  rejection_recovery_at=CASE WHEN candidate THEN claimed_at ELSE rejection_recovery_at END WHERE id=c.id;
 RETURN jsonb_build_object('id',c.id,'providerId',c.provider_id,'provider',c.provider,'account',c.account_namespace,'model',c.model,'protocol',c.payload->>'protocol')||CASE WHEN candidate THEN
  jsonb_build_object('rejectionRecovery',jsonb_build_object('attempt',c.recovery_attempts+1,'claimedAt',claimed_at))
  ELSE '{}'::jsonb END;
END $function$;

COMMIT;
