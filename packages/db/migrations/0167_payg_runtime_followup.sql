-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BILL-PAYG B2; source staging 6fccfaba, rebuilt locally. No remote DB access.
-- Preserve financial/abnormality facts. Rollback revokes review writes and keeps B1 recovery.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $$ BEGIN
 IF md5(pg_get_functiondef('public.runtime_admit(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure)) NOT IN ('1513a5cf6ac6cb1b26975036a37ed3b9','28999a90cd0396f6fd8779cde7e0c595') THEN
  RAISE EXCEPTION 'PAYG_B2_SOURCE_MISMATCH: runtime_admit(uuid,uuid,uuid,jsonb,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.opc_step_material(uuid,uuid,uuid,text,text,text)'::regprocedure)) NOT IN ('05865c9d70bf4f4bc3ea383d556b2125','c78e948ef71515f7ca9c6dfa0377e93c') THEN
  RAISE EXCEPTION 'PAYG_B2_SOURCE_MISMATCH: opc_step_material(uuid,uuid,uuid,text,text,text)';END IF;
 IF md5(pg_get_functiondef('public.runtime_session_context(uuid,uuid)'::regprocedure)) NOT IN ('9a159d2e2cbf6f6bcc151410fc57564d','67b8e8ca0a4f07c95e5758676a1a803c') THEN
  RAISE EXCEPTION 'PAYG_B2_SOURCE_MISMATCH: runtime_session_context(uuid,uuid)';END IF;
 IF md5(pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure)) NOT IN ('a67839c4bbbe56e72cebf972a2d19ff5','ca126fb624fb5b755471f9e26dfc37db') THEN
  RAISE EXCEPTION 'PAYG_B2_SOURCE_MISMATCH: bill2_payg_claim(uuid,uuid,integer,jsonb)';END IF;
 IF md5(pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure)) NOT IN ('6d3ae6342bf0eaaf1899da954203f658','fb0a164b29dfd4ae43f7c9059473c053') THEN
  RAISE EXCEPTION 'PAYG_B2_SOURCE_MISMATCH: runtime_execution(uuid,uuid,text,jsonb)';END IF;
END $$;
-- The audit table already owns administrator history. This pointer grants only
-- a reviewed exception to the model-level new-claim block, never a new money fact.
ALTER TABLE bill2_calls ADD COLUMN IF NOT EXISTS metering_review_audit_id uuid
 REFERENCES user_activity_logs(id);
-- Only unresolved anomalies enter the model gate. Approved history is absent
-- from this index and claim never hashes historical payloads or receipts.
CREATE INDEX IF NOT EXISTS bill2_payg_unreviewed_model ON bill2_calls(model)
 WHERE (budget_conflict OR metering_missing OR metering_exit) AND metering_review_audit_id IS NULL;
CREATE OR REPLACE FUNCTION public.bill2_payg_review_invalidate_call() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF ROW(NEW.id,NEW.run_id,NEW.model,NEW.payload,NEW.budget_conflict,NEW.metering_missing,NEW.metering_exit,
   NEW.settled_at,NEW.selected_cost_usd,NEW.nominal_cost_usd,NEW.nominal_reconstructed_usd,NEW.charged_delta)
  IS DISTINCT FROM ROW(OLD.id,OLD.run_id,OLD.model,OLD.payload,OLD.budget_conflict,OLD.metering_missing,OLD.metering_exit,
   OLD.settled_at,OLD.selected_cost_usd,OLD.nominal_cost_usd,OLD.nominal_reconstructed_usd,OLD.charged_delta)
 THEN NEW.metering_review_audit_id:=NULL;END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION public.bill2_payg_review_invalidate_receipt() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Receipts are immutable: a newly inserted receipt is the only evidence change.
 -- The existing writer already holds the run/model locks, also used by review.
 UPDATE bill2_calls SET metering_review_audit_id=NULL
 WHERE id=NEW.call_id AND metering_review_audit_id IS NOT NULL;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bill2_payg_review_invalidate_call(),public.bill2_payg_review_invalidate_receipt()
 FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS bill2_payg_review_call_changed ON bill2_calls;
CREATE TRIGGER bill2_payg_review_call_changed BEFORE UPDATE ON bill2_calls
 FOR EACH ROW WHEN (OLD.metering_review_audit_id IS NOT NULL)
 EXECUTE FUNCTION public.bill2_payg_review_invalidate_call();
DROP TRIGGER IF EXISTS bill2_payg_review_receipt_added ON bill2_receipts;
CREATE TRIGGER bill2_payg_review_receipt_added AFTER INSERT ON bill2_receipts
 FOR EACH ROW EXECUTE FUNCTION public.bill2_payg_review_invalidate_receipt();
CREATE OR REPLACE FUNCTION public.bill2_payg_metering_hash(c bill2_calls) RETURNS text
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT encode(sha256(convert_to(jsonb_build_object(
  'callId',c.id,'runId',c.run_id,'payloadHash',encode(sha256(convert_to(c.payload::text,'utf8')),'hex'),
  'budgetConflict',c.budget_conflict,'meteringMissing',c.metering_missing,'meteringExit',c.metering_exit,
  'settledAt',extract(epoch FROM c.settled_at),'selectedCost',c.selected_cost_usd,'nominalCost',c.nominal_cost_usd,
  'nominalReconstructed',c.nominal_reconstructed_usd,'chargedDelta',c.charged_delta,
  'receipts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'hash',r.payload_hash,
   'financialHash',r.financial_projection_hash,'conflict',r.conflict) ORDER BY r.id)
   FROM bill2_receipts r WHERE r.call_id=c.id),'[]'::jsonb))::text,'utf8')),'hex');
$$;
REVOKE ALL ON FUNCTION public.bill2_payg_metering_hash(bill2_calls) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.bill2_payg_metering_review_snapshot(p_actor_id uuid,p_call_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c bill2_calls;r bill2_runs;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id;
 SELECT * INTO r FROM bill2_runs WHERE id=c.run_id;
 IF c.id IS NULL OR r.contract_version IS DISTINCT FROM 'bill2.v2'
  OR coalesce(c.payload#>>'{payg,profileVersion}','')='' OR coalesce(c.payload#>>'{payg,evidenceVersion}','')=''
 THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_DENIED';END IF;
 RETURN jsonb_build_object('callId',c.id,'evidenceHash',bill2_payg_metering_hash(c),
  'profileVersion',c.payload#>>'{payg,profileVersion}','evidenceVersion',c.payload#>>'{payg,evidenceVersion}',
  'budgetConflict',c.budget_conflict,'meteringMissing',c.metering_missing,'meteringExit',c.metering_exit,
  'auditId',c.metering_review_audit_id,
  'reviewable',c.settled_at IS NOT NULL AND NOT r.conflict AND bill2_payg_financial_binding(r)
   AND (c.budget_conflict OR c.metering_missing OR c.metering_exit)
   AND NOT EXISTS(SELECT 1 FROM bill2_receipts receipt JOIN bill2_calls bc ON bc.id=receipt.call_id
    WHERE bc.run_id=r.id AND receipt.conflict));
END $$;
CREATE OR REPLACE FUNCTION public.bill2_payg_review_metering(
 p_actor_id uuid,p_call_id uuid,p_request_id uuid,p_review jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c bill2_calls;r bill2_runs;prior user_activity_logs;h text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_DENIED' USING ERRCODE='42501';END IF;
 IF p_request_id IS NULL OR jsonb_typeof(p_review) IS DISTINCT FROM 'object'
  OR p_review->'humanReviewed' IS DISTINCT FROM 'true'::jsonb
  OR coalesce(p_review->>'expectedEvidenceHash','') !~ '^[a-f0-9]{64}$'
  OR length(btrim(coalesce(p_review->>'reviewReference',''))) NOT BETWEEN 1 AND 500
  OR length(coalesce(p_review->>'profileVersion','')) NOT BETWEEN 1 AND 128
  OR length(coalesce(p_review->>'evidenceVersion','')) NOT BETWEEN 1 AND 128
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_review) k WHERE k NOT IN
   ('expectedEvidenceHash','profileVersion','evidenceVersion','reviewReference','humanReviewed'))
 THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_DENIED';END IF;
 -- Same order as record/finalize: run, sorted model locks, calls/receipts, profile.
 SELECT * INTO r FROM bill2_runs WHERE id=(SELECT run_id FROM bill2_calls WHERE id=p_call_id) FOR UPDATE;
 IF r.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_DENIED';END IF;
 PERFORM bill2_payg_lock_models(r);
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 PERFORM id FROM bill2_receipts WHERE call_id=c.id ORDER BY id FOR UPDATE;
 PERFORM id FROM profiles WHERE id=p_actor_id AND role='admin' AND status='active' AND is_deleted='false' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO prior FROM user_activity_logs WHERE id=p_request_id;
 IF prior.id IS NOT NULL THEN
  IF prior.action<>'bill2_metering_review' OR prior.admin_id IS DISTINCT FROM p_actor_id
   OR prior.details->>'callId' IS DISTINCT FROM c.id::text OR prior.details->'review' IS DISTINCT FROM p_review
   OR c.metering_review_audit_id IS DISTINCT FROM prior.id
  THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_CONFLICT';END IF;
  RETURN jsonb_build_object('callId',c.id,'auditId',prior.id,'reviewed',true);
 END IF;
 IF c.settled_at IS NULL OR r.conflict OR NOT bill2_payg_financial_binding(r)
  OR NOT (c.budget_conflict OR c.metering_missing OR c.metering_exit)
  OR EXISTS(SELECT 1 FROM bill2_receipts receipt JOIN bill2_calls bc ON bc.id=receipt.call_id
   WHERE bc.run_id=r.id AND receipt.conflict)
 THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_NOT_READY';END IF;
 h:=bill2_payg_metering_hash(c);
 IF h IS DISTINCT FROM p_review->>'expectedEvidenceHash'
  OR c.payload#>>'{payg,profileVersion}' IS DISTINCT FROM p_review->>'profileVersion'
  OR c.payload#>>'{payg,evidenceVersion}' IS DISTINCT FROM p_review->>'evidenceVersion'
  OR EXISTS(SELECT 1 FROM user_activity_logs log WHERE log.id=c.metering_review_audit_id
   AND log.details->>'evidenceHash'=h)
 THEN RAISE EXCEPTION 'BILL2_METERING_REVIEW_CONFLICT';END IF;
 INSERT INTO user_activity_logs(id,user_id,admin_id,action,action_type,details)
 VALUES(p_request_id,r.actor_id,p_actor_id,'bill2_metering_review','admin',jsonb_build_object(
  'callId',c.id,'runId',r.id,'model',c.model,'evidenceHash',h,'review',p_review,
  'budgetConflict',c.budget_conflict,'meteringMissing',c.metering_missing,'meteringExit',c.metering_exit));
 UPDATE bill2_calls SET metering_review_audit_id=p_request_id WHERE id=c.id;
 RETURN jsonb_build_object('callId',c.id,'auditId',p_request_id,'reviewed',true);
END $$;
REVOKE ALL ON FUNCTION public.bill2_payg_metering_review_snapshot(uuid,uuid),
 public.bill2_payg_review_metering(uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.bill2_payg_metering_review_snapshot(uuid,uuid),
 public.bill2_payg_review_metering(uuid,uuid,uuid,jsonb) TO service_role;

;
CREATE OR REPLACE FUNCTION public.runtime_admit(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b jsonb;history_candidates bigint[];source runtime_executions;prior_turn opc_turns;current_turn opc_turns;card jsonb;answer jsonb;idx integer;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'RUNTIME_REQUEST_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,107));
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO e FROM runtime_executions WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF e.id IS NOT NULL THEN
  IF e.session_id<>s.id OR e.payload IS DISTINCT FROM p_payload
   OR (SELECT payload FROM bill2_runs WHERE id=e.billing_run_id) IS DISTINCT FROM p_billing THEN RAISE EXCEPTION 'RUNTIME_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
 END IF;
 IF EXISTS(SELECT 1 FROM runtime_executions pending JOIN bill2_runs pr ON pr.id=pending.billing_run_id
  WHERE pending.session_id=s.id AND pr.contract_version='bill2.v2' AND pending.primary_result IS NOT NULL
   AND pending.payload ? 'attachedOrganizer' AND pending.result IS NULL
   AND pending.state IN ('waiting_credits','waiting_resume','running','interrupted','cost_pending')
   AND NOT pr.cancel_requested) THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
 -- Only NEW admissions validate source freshness. Existing requests above and
 -- execution recovery retain their frozen inputs even after another turn exists.
 answer:=p_payload#>'{request,answerSource}';
 IF answer IS NOT NULL THEN
  BEGIN
   SELECT * INTO source FROM runtime_executions WHERE id=(answer->>'executionId')::uuid
    AND actor_id=p_actor_id AND session_id=s.id;
   EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';
  END;
  SELECT * INTO prior_turn FROM opc_turns WHERE session_id=s.id AND request_id=source.request_id
   AND token::text=source.payload->>'opcTurnToken' AND purpose='mentor';
  SELECT * INTO current_turn FROM opc_turns WHERE session_id=s.id AND request_id=p_request_id
   AND token::text=p_payload->>'opcTurnToken' AND purpose='mentor';
  IF source.id IS NULL OR source.state IS DISTINCT FROM 'completed' OR NOT runtime_history_available(source.id)
   OR source.id IS DISTINCT FROM (SELECT id FROM runtime_executions WHERE session_id=s.id ORDER BY created_at DESC,id DESC LIMIT 1)
   OR prior_turn.token IS NULL OR current_turn.token IS NULL
   OR prior_turn.draft_id IS DISTINCT FROM current_turn.draft_id
   OR prior_turn.round_id IS DISTINCT FROM current_turn.round_id
   OR prior_turn.step_id IS DISTINCT FROM current_turn.step_id
   OR NOT EXISTS(SELECT 1 FROM opc_drafts WHERE draft_id=current_turn.draft_id AND actor_id=p_actor_id
     AND session_id=s.id AND round_id=current_turn.round_id)
   OR coalesce(p_payload#>>'{request,selection,task}','') !~ '^opc-question:[a-z][a-z0-9_-]{0,63}$'
   OR source.payload#>>'{request,selection,task}' IS DISTINCT FROM p_payload#>>'{request,selection,task}'
   THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END IF;
  BEGIN card:=(source.result->>'body')::jsonb;
   EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END;
  IF jsonb_typeof(card->'card')='object' AND NOT (card->'card' ? 'recommended') THEN
   card:=jsonb_set(card,'{card,recommended}','null'::jsonb);
  END IF;
  IF card->>'format' IS DISTINCT FROM 'agent-turn.v1' OR jsonb_typeof(card->'card') IS DISTINCT FROM 'object'
   OR card->'card' IS DISTINCT FROM p_payload#>'{answeredCard,card}'
   OR answer IS DISTINCT FROM (p_payload->'answeredCard')-'card'
   OR jsonb_typeof(card#>'{card,options}') IS DISTINCT FROM 'array'
   THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END IF;
  IF answer ? 'optionIndex' THEN
   IF jsonb_typeof(answer->'optionIndex') IS DISTINCT FROM 'number' OR (answer->>'optionIndex') !~ '^[0-4]$'
    THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END IF;
   idx:=(answer->>'optionIndex')::integer;
   IF idx>=jsonb_array_length(card#>'{card,options}')
    OR p_payload->>'input' IS DISTINCT FROM card#>>ARRAY['card','options',idx::text]
    OR p_payload#>>'{request,input}' IS DISTINCT FROM card#>>ARRAY['card','options',idx::text]
    THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';END IF;
  ELSIF p_payload->>'input' IS DISTINCT FROM p_payload#>>'{request,input}' THEN
   RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';
  END IF;
 ELSIF p_payload ? 'answeredCard' THEN RAISE EXCEPTION 'OPC_ANSWER_SOURCE_DENIED';
 END IF;
 IF s.scope->>'kind'='work_item' AND (p_payload->>'input' LIKE '[OPC_SCRIPT_V1]%' OR p_payload->>'input' LIKE '[OPC_VIDEO_PACKAGE_V1]%') AND opc_item_content_type((s.scope->>'workItemId')::uuid)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
 -- A stopped invocation may retain an unknown financial obligation. Its closed,
 -- cancelled BILL2 run cannot dispatch or append history. Under the existing
 -- session row lock, only replace the pointer; never settle or edit old evidence.
 IF s.active_execution IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runtime_executions old_execution JOIN bill2_runs old_run
   ON old_run.id=old_execution.billing_run_id
   WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
    AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
    AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
    AND old_run.closed AND old_run.cancel_requested) THEN
  RAISE EXCEPTION 'RUNTIME_SESSION_BUSY';
 END IF;
 IF p_payload IS DISTINCT FROM p_billing->'input' THEN RAISE EXCEPTION 'RUNTIME_INPUT_BINDING_DENIED';END IF;
 IF p_payload->'scopeMaterial' IS NOT NULL AND p_payload->'scopeMaterial'->>'sessionId' IS DISTINCT FROM s.id::text THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_SCOPE';END IF;
 PERFORM runtime_context_allowed(p_actor_id,p_payload);
 IF p_billing->'scope' IS DISTINCT FROM s.scope OR p_billing->>'sessionRef' IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 -- Share the original admission lock before checking for an existing BILL2 run.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,105));
 -- Never adopt an old isolated run, even with a matching public request ID.
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE actor_id=p_actor_id AND request_id=p_request_id) THEN RAISE EXCEPTION 'RUNTIME_LEGACY_RUN_DENIED';END IF;
 -- Freeze history membership and permission locks before bill2_prepare takes
 -- the profile balance lock. Dispatch takes revision permissions before profile.
 history_candidates:=ARRAY(
  WITH bounded AS MATERIALIZED (
   SELECT h.revision,h.execution_id FROM runtime_session_history h
   WHERE h.session_id=s.id AND h.revision<=s.revision AND NOT h.internal_control
   ORDER BY h.revision DESC
   LIMIT CASE WHEN coalesce((p_payload->>'historyItems')::int,0)>0
    THEN least(1000,(p_payload->>'historyItems')::int)+128 ELSE 0 END
  ), availability AS MATERIALIZED (
   SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM bounded))
  )
  SELECT revision FROM bounded JOIN availability USING(execution_id)
  WHERE available ORDER BY revision);
 -- Runtime requires the administrator model binding; legacy unbound BILL2
 -- callers keep their existing package authorization contract.
 IF p_billing->>'revisionId' IS NOT NULL THEN
  PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
   AND skill_id=(p_billing->>'skillId')::uuid AND active AND model_id=(p_billing->>'modelId')::uuid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
 END IF;
 b:=bill2_prepare(p_actor_id,p_request_id,p_billing);
 INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,billing_run_id,history_revision)
 VALUES(p_actor_id,s.id,p_request_id,p_payload,(b->>'id')::uuid,s.revision) RETURNING * INTO e;
 UPDATE runtime_executions SET candidate_history=history_candidates WHERE id=e.id;
 UPDATE bill2_runs SET session_ref=s.id WHERE id=e.billing_run_id;
 UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
END $function$

;
CREATE OR REPLACE FUNCTION public.opc_step_material(p_actor_id uuid, p_draft_id uuid, p_request_id uuid, p_step_id text, p_purpose text, p_input text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts;m runtime_scope_material;n bigint;r artifact_rounds;t opc_turns;result jsonb;spec jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND draft_id=p_draft_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM 1 FROM runtime_sessions WHERE id=d.session_id FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 IF p_purpose NOT IN ('step','mentor','plan') OR (p_purpose IN ('step','mentor') AND r.state<>'draft') OR (p_purpose='plan' AND r.state<>'published') OR NOT(r.steps?p_step_id) THEN RAISE EXCEPTION 'OPC_STEP_DENIED';END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=d.session_id AND request_id=p_request_id;
 IF FOUND THEN
  SELECT * INTO t FROM opc_turns WHERE session_id=d.session_id AND request_id=p_request_id;
  IF t.token IS NULL OR t.purpose IS DISTINCT FROM p_purpose OR t.step_id IS DISTINCT FROM p_step_id OR t.input_hash IS DISTINCT FROM artifact_hash(to_jsonb(p_input)) OR m.content->>'brief' IS DISTINCT FROM p_purpose||':'||p_step_id OR m.revoked THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('revision',m.revision,'turnToken',t.token);
 END IF;
 IF EXISTS(SELECT 1 FROM runtime_executions pending JOIN bill2_runs pr ON pr.id=pending.billing_run_id
  WHERE pending.session_id=d.session_id AND pr.contract_version='bill2.v2' AND pending.primary_result IS NOT NULL
   AND pending.payload ? 'attachedOrganizer' AND pending.result IS NULL
   AND pending.state IN ('waiting_credits','waiting_resume','running','interrupted','cost_pending')
   AND NOT pr.cancel_requested) THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
 SELECT x INTO spec FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=p_step_id;
 IF p_purpose IN ('step','mentor') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(spec->'dependsOn') dep WHERE (r.steps->dep->>'valid')::boolean IS DISTINCT FROM true) THEN RAISE EXCEPTION 'OPC_DEPENDENCIES_UNCONFIRMED';END IF;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=d.session_id;
 result:=runtime_material(p_actor_id,d.session_id,'save',p_request_id,n,jsonb_build_object('brief',p_purpose||':'||p_step_id,'material','','roundId',r.id));
 INSERT INTO opc_turns(draft_id,session_id,request_id,round_id,step_id,purpose,material_revision,input_hash) VALUES(d.draft_id,d.session_id,p_request_id,r.id,p_step_id,p_purpose,(result->>'revision')::bigint,artifact_hash(to_jsonb(p_input))) RETURNING * INTO t;
 RETURN result||jsonb_build_object('turnToken',t.token);
END $function$

;
CREATE OR REPLACE FUNCTION public.runtime_session_context(p_actor_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;chosen jsonb;m runtime_scope_material;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO e FROM runtime_executions WHERE session_id=s.id AND payload->>'role' IN ('ordinary','skill')
  AND (result->>'body' IS NOT NULL OR primary_result->>'body' IS NOT NULL) AND runtime_history_available(id) ORDER BY created_at DESC,id LIMIT 1;
 SELECT c INTO chosen FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key';
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=s.id ORDER BY revision DESC LIMIT 1;
 RETURN jsonb_build_object('waitingOrganizer',(
  SELECT jsonb_build_object('executionId',pending.id,'cursor',pr.runtime_cursor,'epoch',pr.runtime_epoch,
   'state',pending.state,'remainingCalls',pr.max_calls-(SELECT count(*) FROM bill2_calls WHERE run_id=pr.id))
  FROM runtime_executions pending JOIN bill2_runs pr ON pr.id=pending.billing_run_id
  WHERE pending.session_id=s.id AND pr.contract_version='bill2.v2' AND pending.primary_result IS NOT NULL
   AND pending.payload ? 'attachedOrganizer' AND pending.result IS NULL AND NOT pr.cancel_requested
   AND pending.state IN ('waiting_credits','waiting_resume','running','interrupted','cost_pending')
  ORDER BY pending.created_at,pending.id LIMIT 1),'scopeMaterial',CASE WHEN m.session_id IS NOT NULL AND NOT m.revoked THEN jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash,'content',m.content) ELSE NULL END,'materialRevision',coalesce(m.revision,0),'scope',s.scope,'dialogueModelId',coalesce(chosen->>'modelId',e.payload->>'modelId'),'dialogueModel',coalesce(chosen->>'model',e.payload->>'model'));
END $function$

;
CREATE OR REPLACE FUNCTION public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;w runtime_test_windows;n integer;used numeric;used_calls bigint;
 cfg jsonb;threshold jsonb;avail integer;quarantine bigint;g numeric;h integer;q record;u numeric;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;
 IF r.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 PERFORM bill2_payg_lock_models(r);
 PERFORM runtime_billing_allowed(a,r.payload,r.id);
 -- Match prepare/dispatch: profile before test window, then grants. The window
 -- permission check itself takes FOR UPDATE, so lock the profile before calling it.
 SELECT credits INTO avail FROM profiles WHERE id=a AND status='active' AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED';END IF;
 PERFORM runtime_test_window_allowed(a,r.payload);
 IF NOT coalesce(bill2_scope_allowed(a,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED';END IF;
 SELECT * INTO c FROM bill2_calls WHERE run_id=rid AND sequence=seq;
 IF c.id IS NOT NULL THEN
  IF c.payload IS DISTINCT FROM p THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF;
  RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',NULL);
 END IF;
 IF r.session_ref IS NOT NULL AND (coalesce(p->>'runtimeEpoch','') !~ '^[1-9][0-9]*$'
  OR (p->>'runtimeEpoch')::bigint IS DISTINCT FROM r.runtime_epoch
  OR NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
    WHERE e.billing_run_id=r.id AND e.state='running' AND s.active_execution=e.id)
  OR r.runtime_dispatch_deadline IS NULL) THEN RAISE EXCEPTION 'RUNTIME_RESUME_CONFLICT';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=
  (CASE WHEN r.session_ref IS NOT NULL THEN r.runtime_dispatch_deadline ELSE r.deadline END) THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 IF octet_length(p::text)>65536 THEN RAISE EXCEPTION 'BILL2_CALL_TOO_LARGE';END IF;
 PERFORM bill2_payg_validate_quote(r,p);
 IF r.session_ref IS NOT NULL AND r.runtime_checkpoint ? 'requestHash' AND seq=(r.runtime_checkpoint->>'sequence')::int AND
  (p->>'requestHash' IS DISTINCT FROM r.runtime_checkpoint->>'requestHash'
   OR p->>'phase' IS DISTINCT FROM r.runtime_checkpoint->>'phase')
 THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
 IF EXISTS(SELECT 1 FROM bill2_calls x WHERE x.model=p->>'model'
  AND (x.budget_conflict OR x.metering_missing OR x.metering_exit) AND x.metering_review_audit_id IS NULL) THEN RAISE EXCEPTION 'BILL2_PAYG_METERING_BLOCKED';END IF;
 IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=rid AND settled_at IS NULL) THEN RAISE EXCEPTION 'BILL2_CALL_PENDING';END IF;
 u:=bill2_decimal(p->'upperUsd');
 SELECT count(*),coalesce(sum(CASE WHEN state='cancelled' AND dispatched_at IS NULL THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END),0)
 INTO n,used FROM bill2_calls WHERE run_id=rid;
 IF seq IS DISTINCT FROM n+1 OR n>=r.max_calls OR used+u>r.budget_usd THEN RAISE EXCEPTION 'BILL2_CALL_BUDGET_OR_CONTRACT';END IF;
 IF r.test_window_id IS NOT NULL THEN
  SELECT * INTO w FROM runtime_test_windows WHERE id=r.test_window_id FOR UPDATE;
  SELECT coalesce(sum(CASE WHEN x.contract_version='bill2.v2' THEN coalesce(calls.cost,0)
   WHEN x.closed AND NOT x.conflict AND x.provider_cost_usd IS NOT NULL THEN greatest(x.provider_cost_usd,coalesce(calls.cost,0))
   ELSE greatest(x.budget_usd,coalesce(calls.cost,0)) END),0),
   coalesce(sum(CASE WHEN x.contract_version='bill2.v2' OR x.closed THEN coalesce(calls.n,0) ELSE x.max_calls END),0)
  INTO used,used_calls FROM bill2_runs x LEFT JOIN LATERAL(
   SELECT count(*) n,sum(CASE WHEN state='cancelled' AND dispatched_at IS NULL THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END) cost
   FROM bill2_calls WHERE run_id=x.id) calls ON true WHERE x.test_window_id=w.id;
  IF used+u>w.max_cost_usd OR used_calls+1>w.max_calls THEN RAISE EXCEPTION 'RUNTIME_TEST_BUDGET_EXHAUSTED';END IF;
 END IF;
 SELECT value INTO cfg FROM system_settings WHERE key='billing_payg_start_thresholds' FOR SHARE;
 SELECT x INTO threshold FROM jsonb_array_elements(CASE WHEN jsonb_typeof(cfg->'thresholds')='array' THEN cfg->'thresholds' ELSE '[]'::jsonb END) x
  WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase';
 IF coalesce(cfg->>'version','')='' OR coalesce(threshold->>'credits','') !~ '^[1-9][0-9]{0,8}$'
 OR (SELECT count(*) FROM jsonb_array_elements(cfg->'thresholds') x WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase')<>1
 THEN RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';END IF;
 -- The balance already excludes all pre-deductions. Subtract only unavailable grant remainder.
 PERFORM id FROM subscription_credit_grants WHERE user_id=a ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM subscription_credit_grants WHERE user_id=a AND accounting_state<>'trusted') THEN
  RAISE EXCEPTION 'PRE_DEDUCT_GRANT_ACCOUNTING_REVIEW_REQUIRED';END IF;
 SELECT coalesce(sum(greatest(g.credits_granted-g.consumed_amount,0)),0) INTO quarantine
 FROM subscription_credit_grants g WHERE g.user_id=a AND g.status='granted' AND g.accounting_state='trusted'
 AND EXISTS(SELECT 1 FROM user_subscriptions s WHERE s.user_id=a AND s.stripe_subscription_id=g.stripe_subscription_id AND s.credit_release_terminated_at IS NOT NULL);
 avail:=greatest(avail-quarantine,0);
 IF avail<(threshold->>'credits')::int THEN
  UPDATE bill2_runs SET paused_reason='insufficient_credits',version=version+1 WHERE id=rid;
  RETURN jsonb_build_object('id',NULL,'state','waiting_credits','dispatchToken',NULL);
 END IF;
 g:=ceil(u*r.credits_per_usd*bill2_unit_multiplier(p->'billingUnit'->'multiplier'));h:=least(g,avail)::int;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd)
 VALUES(rid,seq,p,p->>'provider',p->>'account',p->>'model',u) RETURNING * INTO c;
 SELECT * INTO q FROM atomic_pre_deduct(a,h,'BILL2 call reservation',c.id);
 IF q.is_idempotent THEN RAISE EXCEPTION 'BILL2_PREDEDUCT_CONFLICT';END IF;
 UPDATE bill2_calls SET pre_deduct_id=q.pre_deduct_id,reserved_credits=h,available_credits=avail,
  runtime_epoch=CASE WHEN r.session_ref IS NOT NULL THEN r.runtime_epoch ELSE NULL END,
  dispatch_deadline=coalesce(r.runtime_dispatch_deadline,r.deadline),
  recovery_deadline=coalesce(r.runtime_dispatch_deadline,r.deadline)+interval '24 hours',
  supersedes_call_id=(SELECT id FROM bill2_calls WHERE run_id=r.id AND sequence=seq-1 AND runtime_retryable
   AND state='cancelled' AND dispatched_at IS NULL AND settled_at IS NOT NULL
   AND payload->>'requestHash'=p->>'requestHash' AND payload->>'phase'=p->>'phase'),
  start_threshold=(threshold->>'credits')::int,threshold_version=cfg->>'version' WHERE id=c.id;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
  idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
 VALUES(a,-h,'adjustment','Call reservation','adjustment','bill2_reserve','ai_task',rid::text,
 'bill2:'||c.id||':reserve',q.balance_before,q.balance_after,rid,c.id,
 jsonb_build_object('contractVersion','bill2.v2','preDeductId',q.pre_deduct_id,'G',g::text,'H',h,'A',avail,'L',threshold->'credits','thresholdVersion',cfg->>'version'));
 UPDATE bill2_runs SET paused_reason=NULL,version=version+1 WHERE id=rid;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $function$

;
CREATE OR REPLACE FUNCTION public.runtime_execution(p_actor_id uuid, p_execution_id uuid, p_action text, p_result jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b bill2_runs;live boolean:=false;v jsonb;next_seq integer;pending_call bill2_calls;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 IF e.unavailable_reason IS NOT NULL AND p_action IN ('begin','read') THEN
  RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',b.id,'state',e.state,'live',false,'cancelRequested',true,'result',NULL,'unavailableReason',e.unavailable_reason);
 END IF;
 IF NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'RUNTIME_CONTEXT_REVOKED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,b.payload,b.id);
 IF p_action IN ('fail_before_dispatch','interrupt','checkpoint_match','checkpoint_primary','check_latest','complete',
  'owner_cancel','owner_session','owner_tool') AND b.contract_version='bill2.v2' THEN
  IF coalesce(p_result->>'epoch','') !~ '^[1-9][0-9]*$'
   OR (p_result->>'epoch')::bigint IS DISTINCT FROM b.runtime_epoch
   OR e.state IN ('prepared','waiting_credits','waiting_resume','cancelled')
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('epoch','value'))
  THEN RAISE EXCEPTION 'RUNTIME_RESUME_CONFLICT';END IF;
  p_result:=nullif(p_result->'value','null'::jsonb);
 END IF;
 -- These three bounded delegates hold the same Session/execution/run locks as
 -- resume. No asynchronous check-then-write gap, new RPC family or new authority.
 IF p_action IN ('owner_cancel','owner_session','owner_tool') THEN
  IF b.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
  IF p_action='owner_cancel' THEN
   RETURN runtime_cancel(p_actor_id,e.id);
  ELSIF p_action='owner_session' THEN
   IF coalesce(p_result->>'action','') NOT IN ('freeze','append') THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
   RETURN runtime_session_items(p_actor_id,s.id,e.id,p_result->>'action',nullif(p_result->'items','null'::jsonb),
    (p_result->>'limit')::int,(p_result->>'batch')::int);
  ELSE
   IF coalesce(p_result->>'action','') NOT IN ('claim','complete') THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
   RETURN runtime_tool(p_actor_id,e.id,p_result->>'callId',p_result->>'name',p_result->'arguments',
    p_result->>'action',nullif(p_result->'result','null'::jsonb));
  END IF;
 END IF;

 IF b.contract_version='bill2.v2' AND p_action IN ('begin','read')
  AND e.state IN ('running','interrupted') AND b.runtime_dispatch_deadline<=clock_timestamp()
  AND NOT b.closed AND NOT b.cancel_requested AND NOT b.conflict THEN
  SELECT * INTO pending_call FROM bill2_calls WHERE run_id=b.id AND state='prepared' AND dispatched_at IS NULL
   AND settled_at IS NULL ORDER BY sequence DESC LIMIT 1 FOR UPDATE;
  IF pending_call.id IS NOT NULL AND pending_call.runtime_epoch=b.runtime_epoch AND pending_call.dispatch_deadline<=clock_timestamp() THEN
   UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid(),runtime_retryable=true WHERE id=pending_call.id;
   PERFORM bill2_finalize(p_actor_id,b.id);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL) THEN
   SELECT count(*)+1 INTO next_seq FROM bill2_calls WHERE run_id=b.id;
    UPDATE bill2_runs SET runtime_cursor=runtime_cursor+1,paused_reason='http_budget',runtime_dispatch_deadline=NULL,
     runtime_checkpoint=jsonb_strip_nulls(jsonb_build_object('sequence',next_seq,'requestHash',pending_call.payload->>'requestHash',
      'phase',pending_call.payload->>'phase','sessionRevision',s.revision,
      'materialRevision',coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0)))
     WHERE id=b.id RETURNING * INTO b;
    UPDATE runtime_executions SET state='waiting_resume' WHERE id=e.id RETURNING * INTO e;
    UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  END IF;
 END IF;
 IF b.contract_version='bill2.v2' AND p_action IN ('payg_wait','payg_resume') THEN
  IF b.closed OR b.cancel_requested OR b.conflict THEN RAISE EXCEPTION 'RUNTIME_RESUME_CLOSED';END IF;
  IF p_action='payg_wait' THEN
   IF e.state<>'running' OR s.active_execution IS DISTINCT FROM e.id
    OR coalesce(p_result->>'epoch','') !~ '^[1-9][0-9]*$'
    OR (p_result->>'epoch')::bigint IS DISTINCT FROM b.runtime_epoch
    OR p_result->>'state' IS NULL OR p_result->>'state' NOT IN ('waiting_credits','waiting_resume')
    OR coalesce(p_result->>'sequence','') !~ '^[1-9][0-9]*$'
    OR coalesce(p_result->>'requestHash','') !~ '^[a-f0-9]{64}$'
    OR coalesce(p_result->>'phase','')='' OR length(p_result->>'phase')>64
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('epoch','state','sequence','requestHash','phase'))
   THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_DENIED';END IF;
   SELECT * INTO pending_call FROM bill2_calls WHERE run_id=b.id AND sequence=(p_result->>'sequence')::int FOR UPDATE;
   IF pending_call.id IS NOT NULL THEN
    IF p_result->>'state'<>'waiting_resume' OR pending_call.dispatched_at IS NOT NULL
     OR NOT ((pending_call.state='prepared' AND pending_call.settled_at IS NULL) OR (pending_call.state='cancelled' AND pending_call.runtime_retryable AND pending_call.settled_at IS NOT NULL))
     OR pending_call.runtime_epoch<>b.runtime_epoch
     OR pending_call.payload->>'requestHash' IS DISTINCT FROM p_result->>'requestHash'
     OR pending_call.payload->>'phase' IS DISTINCT FROM p_result->>'phase'
    THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
    UPDATE bill2_calls SET state='cancelled',token=gen_random_uuid(),runtime_retryable=true WHERE id=pending_call.id;
    PERFORM bill2_finalize(p_actor_id,b.id);
   END IF;
   SELECT count(*)+1 INTO next_seq FROM bill2_calls WHERE run_id=b.id;
   IF (p_result->>'sequence')::int<>(next_seq-CASE WHEN pending_call.id IS NOT NULL THEN 1 ELSE 0 END)
    OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL)
   THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
   UPDATE bill2_runs SET runtime_cursor=runtime_cursor+1,
    paused_reason=CASE WHEN p_result->>'state'='waiting_credits' THEN 'insufficient_credits' ELSE 'http_budget' END,
    runtime_checkpoint=jsonb_build_object('sequence',next_seq,'requestHash',p_result->>'requestHash',
      'phase',p_result->>'phase','sessionRevision',s.revision,
      'materialRevision',coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0)),
    runtime_dispatch_deadline=NULL WHERE id=b.id RETURNING * INTO b;
   UPDATE runtime_executions SET state=p_result->>'state' WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   IF e.state NOT IN ('waiting_credits','waiting_resume') OR s.active_execution IS NOT NULL
    OR coalesce(p_result->>'epoch','') !~ '^[1-9][0-9]*$'
    OR coalesce(p_result->>'cursor','') !~ '^[1-9][0-9]*$'
    OR (p_result->>'epoch')::bigint IS DISTINCT FROM b.runtime_epoch
    OR (p_result->>'cursor')::bigint IS DISTINCT FROM b.runtime_cursor
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k NOT IN ('epoch','cursor'))
   THEN RAISE EXCEPTION 'RUNTIME_RESUME_CONFLICT';END IF;
   -- Exhausted pre-transport cancellation cannot mint another call. Use the
   -- existing cancellation/financial authority under the original cursor/epoch CAS.
   IF (SELECT count(*) FROM bill2_calls WHERE run_id=b.id)>=b.max_calls THEN
    IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL)
     THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
    PERFORM runtime_cancel(p_actor_id,e.id);
    RETURN runtime_execution(p_actor_id,e.id,'read',NULL);
   END IF;
   IF b.runtime_checkpoint->>'sessionRevision' IS DISTINCT FROM s.revision::text
    OR b.runtime_checkpoint->>'materialRevision' IS DISTINCT FROM
      coalesce((SELECT max(revision) FROM runtime_scope_material WHERE session_id=s.id),0)::text
   THEN RAISE EXCEPTION 'RUNTIME_RESUME_SOURCE_CHANGED';END IF;
   IF EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND settled_at IS NULL)
    THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_PENDING';END IF;
   PERFORM runtime_test_window_allowed(p_actor_id,b.payload);
   UPDATE bill2_runs SET runtime_epoch=runtime_epoch+1,paused_reason=NULL,
    runtime_dispatch_deadline=clock_timestamp()+interval '265 seconds' WHERE id=b.id RETURNING * INTO b;
   UPDATE runtime_executions SET state='running' WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
   live:=true;
  END IF;
 ELSIF p_action='begin' THEN
  IF e.state='prepared' AND s.active_execution=e.id THEN
   UPDATE runtime_executions SET state='running' WHERE id=e.id RETURNING * INTO e;live:=true;
   IF b.contract_version='bill2.v2' THEN
    UPDATE bill2_runs SET runtime_epoch=runtime_epoch+1,
     runtime_dispatch_deadline=clock_timestamp()+interval '265 seconds' WHERE id=b.id RETURNING * INTO b;
   END IF;
  END IF;
 ELSIF p_action='fail_before_dispatch' THEN
  IF p_result IS NOT NULL AND p_result IS DISTINCT FROM '{"unavailable_reason":"provider_history"}'::jsonb THEN
   RAISE EXCEPTION 'RUNTIME_FAILURE_REASON_DENIED';
  END IF;
  IF e.state IN ('prepared','running','interrupted') AND NOT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND dispatched_at IS NOT NULL) THEN
   v:=bill2_cancel(p_actor_id,b.id);v:=bill2_finalize(p_actor_id,b.id);
   -- The reason is set atomically only on a proven pre-dispatch cancellation.
   -- This column revokes this failed execution's content, never earlier turns.
   UPDATE runtime_executions SET state='cancelled',
    unavailable_reason=coalesce(e.unavailable_reason,p_result->>'unavailable_reason')
   WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id;
  END IF;
 ELSIF p_action='interrupt' THEN
  IF e.state='running' THEN UPDATE runtime_executions SET state='interrupted' WHERE id=e.id RETURNING * INTO e;END IF;
 ELSIF p_action='checkpoint_match' THEN
  IF s.active_execution IS DISTINCT FROM e.id OR b.closed OR b.cancel_requested
   OR e.state NOT IN ('running','interrupted') OR NOT (e.payload ? 'matching')
   OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR NOT (p_result ? 'key')
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k<>'key')
   OR (p_result->'key'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->'key'=p_result->'key'))
   OR NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id AND batch=0)
  THEN RAISE EXCEPTION 'RUNTIME_MATCH_DENIED';END IF;
  IF e.match_result IS NOT NULL AND e.match_result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_MATCH_CONFLICT';END IF;
  UPDATE runtime_executions SET match_result=p_result WHERE id=e.id RETURNING * INTO e;
 ELSIF p_action='check_latest' THEN
  IF e.payload->>'network'='require_latest' AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls WHERE execution_id=e.id AND name='search' AND result IS NOT NULL) THEN
   v:=bill2_cancel(p_actor_id,b.id);v:=bill2_finalize(p_actor_id,b.id);
   UPDATE runtime_executions SET unavailable_reason='latest_unavailable',state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'cancelled' ELSE 'cost_pending' END WHERE id=e.id RETURNING * INTO e;
   IF e.state='cancelled' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
   RETURN jsonb_build_object('state',e.state,'unavailable',true);
  END IF;
 ELSIF p_action='checkpoint_primary' THEN
  IF s.active_execution IS DISTINCT FROM e.id OR b.closed OR b.cancel_requested
   OR e.state NOT IN ('running','interrupted') OR NOT (e.payload ? 'attachedOrganizer')
   OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'body') IS DISTINCT FROM 'string'
   OR length(p_result->>'body')=0 OR octet_length(p_result::text)>262144
   OR jsonb_typeof(p_result->'lastSequence') IS DISTINCT FROM 'number'
   OR coalesce(p_result->>'lastSequence','') !~ '^[1-9][0-9]*$'
   OR (p_result->>'lastSequence')::int<1
   OR (p_result->>'lastSequence')::int>(SELECT count(*) FROM bill2_calls WHERE run_id=b.id)
   OR NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id)
  THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_DENIED';END IF;
  IF e.primary_result IS NOT NULL AND e.primary_result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
  UPDATE runtime_executions SET primary_result=p_result WHERE id=e.id RETURNING * INTO e;
 ELSIF p_action='complete' THEN
  IF b.cancel_requested THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_CANCELLED';END IF;
  IF e.payload->>'network'='require_latest' AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls WHERE execution_id=e.id AND name='search' AND result IS NOT NULL) THEN RAISE EXCEPTION 'RUNTIME_LATEST_UNAVAILABLE';END IF;
  IF e.primary_result IS NOT NULL AND e.primary_result->>'body' IS DISTINCT FROM p_result->>'body' THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
  IF e.payload ? 'attachedOrganizer' AND (e.primary_result IS NULL OR jsonb_typeof(p_result->'summary') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
  IF e.state='completed' THEN
   IF e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
  ELSE
   IF s.active_execution IS DISTINCT FROM e.id OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR p_result->>'kind' IS DISTINCT FROM 'usable_result' THEN RAISE EXCEPTION 'RUNTIME_RESULT_DENIED';END IF;
   IF NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id) THEN RAISE EXCEPTION 'RUNTIME_SESSION_PENDING';END IF;
   v:=bill2_close(p_actor_id,b.id,'delivered',p_result);
   v:=bill2_finalize(p_actor_id,b.id);
   IF e.result IS NOT NULL AND e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
   UPDATE runtime_executions SET state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'completed' ELSE 'cost_pending' END,result=p_result WHERE id=e.id RETURNING * INTO e;
   IF e.state='completed' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
  END IF;
 ELSIF p_action<>'read' THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',b.id,'state',e.state,
  'cursor',b.runtime_cursor,'epoch',b.runtime_epoch,'remainingCalls',b.max_calls-(SELECT count(*) FROM bill2_calls WHERE run_id=b.id),
  'live',live,'cancelRequested',b.cancel_requested,'context',e.payload,'billing',b.payload,'result',e.result,'primaryResult',e.primary_result,'matchResult',e.match_result,'historyFrozen',e.selected_history IS NOT NULL,'historyOmitted',e.history_omitted,'unavailableReason',e.unavailable_reason);
END $function$

;
COMMIT;
