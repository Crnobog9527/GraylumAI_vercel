-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-RW-C (number 0418 assigned by the controller; design: db-rw-redesign-v1 section 3).
-- runtime_admit proves "this turn may start" and writes the execution in one transaction: it walks the permission chain,
-- the context and source checks and the whole history window while it holds the session row lock, and bill2_prepare walks
-- the permission chain (bill2_execution_allowed -> runtime_billing_allowed) under the same locks. With 8 backends busy, that
-- transaction holds ~150 relation locks for its whole duration and the lock manager becomes the queue.
-- This migration ADDS a two-step path and leaves runtime_admit exactly as it is (the old path is the Node switch being off):
--  * runtime_admit_precheck(...): the read-only part of runtime_admit, verbatim, without the session row lock and the two
--    advisory locks, plus the permission chain bill2_prepare would walk (bill2_execution_allowed on the billing payload);
--    it returns a proof {requestId, binding = md5 of payload and billing, sessionRevision, candidates,
--    catalogVersions} or {replay: ...} when the request was already admitted. Same errors, same order, as runtime_admit.
--  * runtime_admit_commit(..., p_pre): takes the locks of runtime_admit, replays the idempotency check, verifies the proof
--    (same request, same payload+billing, session revision unchanged, catalog skills/models versions unchanged when the
--    catalog version function exists), repeats the checks that depend on the session lock or a primary key (organizer
--    pending, session busy, legacy run, Skill/model binding) and writes the execution with the proven history window.
--    bill2_prepare skips its permission walk (already done by the precheck) only when graylum.admit_proved is on, a transaction-local setting that
--    only this function sets; any other caller of bill2_prepare still walks it. A proof that does not match, or a session
--    that moved on between the two calls, raises RUNTIME_ADMIT_PRECHECK_INVALID / RUNTIME_ADMIT_STALE (the application
--    re-runs the precheck once). Both functions are executable by service_role only, like runtime_admit.
-- What the two steps do not re-prove (a window of a few milliseconds, accepted in the design): a permission that was revoked
-- between the calls. The execution is only a request: bill2_payg_claim and bill2_dispatch run the permission chain again
-- before any money moves or any model is called, so nothing is spent on a revoked permission.
-- Compatibility: runtime_admit unchanged; bill2_prepare behaves exactly as before unless the setting is on.
-- Repeatable: CREATE OR REPLACE only. Recovery: stop calling the two functions (switch off) and re-apply bill2_prepare from
-- packages/db/functions as of 0413; the two new functions can stay or be dropped.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.runtime_admit_precheck(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;history_candidates bigint[];snap jsonb;source runtime_executions;prior_turn opc_turns;current_turn opc_turns;card jsonb;answer jsonb;idx integer;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('sessionId',p_session_id)); END IF;

 -- D7 read boundary
 IF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'RUNTIME_REQUEST_REQUIRED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO e FROM runtime_executions WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF e.id IS NOT NULL THEN
  IF e.session_id<>s.id OR e.payload IS DISTINCT FROM p_payload
   OR (SELECT payload FROM bill2_runs WHERE id=e.billing_run_id) IS DISTINCT FROM p_billing THEN RAISE EXCEPTION 'RUNTIME_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('replay',jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state));
 END IF;
 PERFORM report_admission_check(p_actor_id,p_session_id,p_payload,p_billing);
 IF EXISTS(SELECT 1 FROM runtime_executions pending JOIN bill2_runs pr ON pr.id=pending.billing_run_id
  WHERE pending.session_id=s.id AND pr.contract_version='bill2.v2' AND pending.primary_result IS NOT NULL
   AND pending.payload ? 'attachedOrganizer' AND pending.result IS NULL
   AND pending.state IN ('waiting_credits','waiting_resume','running','interrupted','cost_pending')
   AND NOT pr.cancel_requested AND pending.failure_code IS DISTINCT FROM 'RUNTIME_INTERRUPTED_RELEASED') THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
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
 -- A2 source freeze
 PERFORM runtime_admit_source_check(p_actor_id,s,p_payload);
 IF p_billing->'scope' IS DISTINCT FROM s.scope OR p_billing->>'sessionRef' IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
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
  ), visible AS MATERIALIZED (
   -- 0409: the own-post visibility test depends on the execution only, so it runs once per execution, not once per history row.
   SELECT a.execution_id FROM availability a WHERE a.available AND runtime_workspace_posts_history_visible(a.execution_id)
  )
  SELECT revision FROM bounded JOIN visible USING(execution_id) ORDER BY revision);
 -- Runtime requires the administrator model binding; legacy unbound BILL2
 -- callers keep their existing package authorization contract.
 IF p_billing->>'revisionId' IS NOT NULL THEN
  IF runtime_rw_flag('sharedRowLocks') THEN
   PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
    AND skill_id=(p_billing->>'skillId')::uuid AND active
    AND (CASE WHEN p_payload ? 'reportGeneration' THEN coalesce(report_model_id,model_id)
      ELSE model_id END)=(p_billing->>'modelId')::uuid;
  ELSE
   PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
    AND skill_id=(p_billing->>'skillId')::uuid AND active
    AND (CASE WHEN p_payload ? 'reportGeneration' THEN coalesce(report_model_id,model_id)
      ELSE model_id END)=(p_billing->>'modelId')::uuid FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
 END IF;
 -- The permission chain, walked once here without any row lock; bill2_prepare skips it in the commit because this proof stands for it
 -- (it is the call bill2_prepare makes with the same billing payload, so it refuses exactly what runtime_admit refuses).
 PERFORM bill2_execution_allowed(p_actor_id,p_billing);
 -- The catalog version function belongs to another change (DB-RW-B); without it there is no catalog version to compare.
 IF to_regprocedure('public.catalog_versions_snapshot()') IS NOT NULL THEN EXECUTE 'SELECT public.catalog_versions_snapshot()' INTO snap; END IF;
 RETURN jsonb_build_object('version',1,'requestId',p_request_id,'binding',md5(p_payload::text||'|'||p_billing::text),
  'sessionRevision',s.revision,'candidates',to_jsonb(history_candidates),'catalogVersions',snap);
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_admit_commit(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb, p_pre jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b jsonb;candidates bigint[];now_versions jsonb;
BEGIN
 -- The same entry guards as runtime_admit.
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('sessionId',p_session_id)); END IF;
 IF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'RUNTIME_REQUEST_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,107));
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO e FROM runtime_executions WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF e.id IS NOT NULL THEN
  IF e.session_id<>s.id OR e.payload IS DISTINCT FROM p_payload
   OR (SELECT payload FROM bill2_runs WHERE id=e.billing_run_id) IS DISTINCT FROM p_billing THEN RAISE EXCEPTION 'RUNTIME_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
 END IF;
 -- The proof belongs to exactly this request, payload and billing, and to the session as it is now.
 IF p_pre IS NULL OR p_pre->>'version' IS DISTINCT FROM '1' OR p_pre->>'requestId' IS DISTINCT FROM p_request_id::text
  OR p_pre->>'binding' IS DISTINCT FROM md5(p_payload::text||'|'||p_billing::text) THEN
  RAISE EXCEPTION 'RUNTIME_ADMIT_PRECHECK_INVALID' USING ERRCODE='P0001';
 END IF;
 IF (p_pre->>'sessionRevision')::bigint IS DISTINCT FROM s.revision THEN RAISE EXCEPTION 'RUNTIME_ADMIT_STALE' USING ERRCODE='P0001';END IF;
 IF jsonb_typeof(p_pre->'catalogVersions')='object' AND to_regprocedure('public.catalog_versions_snapshot()') IS NOT NULL THEN
  EXECUTE 'SELECT public.catalog_versions_snapshot()' INTO now_versions;
  IF now_versions->'skills' IS DISTINCT FROM p_pre->'catalogVersions'->'skills'
   OR now_versions->'models' IS DISTINCT FROM p_pre->'catalogVersions'->'models' THEN
   RAISE EXCEPTION 'RUNTIME_ADMIT_STALE' USING ERRCODE='P0001';
  END IF;
 END IF;
 -- Cheap checks that depend on the session lock or the primary key are repeated here, in the same order as runtime_admit.
 IF EXISTS(SELECT 1 FROM runtime_executions pending JOIN bill2_runs pr ON pr.id=pending.billing_run_id
  WHERE pending.session_id=s.id AND pr.contract_version='bill2.v2' AND pending.primary_result IS NOT NULL
   AND pending.payload ? 'attachedOrganizer' AND pending.result IS NULL
   AND pending.state IN ('waiting_credits','waiting_resume','running','interrupted','cost_pending')
   AND NOT pr.cancel_requested AND pending.failure_code IS DISTINCT FROM 'RUNTIME_INTERRUPTED_RELEASED') THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
 IF s.active_execution IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runtime_executions old_execution JOIN bill2_runs old_run
   ON old_run.id=old_execution.billing_run_id
   WHERE old_execution.id=s.active_execution AND old_execution.session_id=s.id
    AND old_execution.actor_id=p_actor_id AND old_run.actor_id=p_actor_id
    AND old_run.session_ref=s.id AND old_execution.state='cost_pending'
    AND old_run.closed AND old_run.cancel_requested) THEN
  RAISE EXCEPTION 'RUNTIME_SESSION_BUSY';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,105));
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE actor_id=p_actor_id AND request_id=p_request_id) THEN RAISE EXCEPTION 'RUNTIME_LEGACY_RUN_DENIED';END IF;
 IF p_billing->>'revisionId' IS NOT NULL THEN
  IF runtime_rw_flag('sharedRowLocks') THEN
   PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
    AND skill_id=(p_billing->>'skillId')::uuid AND active
    AND (CASE WHEN p_payload ? 'reportGeneration' THEN coalesce(report_model_id,model_id)
      ELSE model_id END)=(p_billing->>'modelId')::uuid;
  ELSE
   PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
    AND skill_id=(p_billing->>'skillId')::uuid AND active
    AND (CASE WHEN p_payload ? 'reportGeneration' THEN coalesce(report_model_id,model_id)
      ELSE model_id END)=(p_billing->>'modelId')::uuid FOR SHARE;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
 END IF;
 SELECT coalesce(array_agg(x::bigint ORDER BY n),ARRAY[]::bigint[]) INTO candidates FROM jsonb_array_elements_text(p_pre->'candidates') WITH ORDINALITY t(x,n);
 PERFORM set_config('graylum.admit_proved','on',true);
 b:=bill2_prepare(p_actor_id,p_request_id,p_billing);
 PERFORM set_config('graylum.admit_proved','',true);
 INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,billing_run_id,history_revision,candidate_history)
 VALUES(p_actor_id,s.id,p_request_id,p_payload,(b->>'id')::uuid,s.revision,candidates) RETURNING * INTO e;
 UPDATE bill2_runs SET session_ref=s.id WHERE id=e.billing_run_id;
 UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
 IF p_payload ? 'reportGeneration' THEN PERFORM report_fee_hold(e,p_billing); END IF;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
END $function$;

CREATE OR REPLACE FUNCTION public.bill2_prepare(p_actor_id uuid, p_request_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs; q record; b numeric; rate numeric; m numeric; reservation integer; new_id uuid:=gen_random_uuid(); fx record;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,p_payload->'scope'); END IF;

 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 -- Serialize missing-row admission before any profile/grant lock; no legacy lock takes this advisory lock.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,105));
 SELECT * INTO r FROM bill2_runs WHERE actor_id=p_actor_id AND request_id=p_request_id FOR UPDATE;
 IF r.id IS NOT NULL THEN IF r.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'BILL2_REQUEST_CONFLICT';END IF;RETURN bill2_public(r);END IF;
 -- DB-RW-C: runtime_admit_commit has just been given a proof of this exact permission chain by runtime_admit_precheck
 -- (same payload, same transaction), so it asks for it not to be walked a second time; every other caller still runs it.
 IF coalesce(current_setting('graylum.admit_proved',true),'')<>'on' THEN PERFORM bill2_execution_allowed(p_actor_id,p_payload); END IF;
 IF coalesce(p_payload->>'contractVersion','') NOT IN ('bill2.v1','bill2.v2') OR p_payload->>'sessionRef' IS NOT NULL
 OR p_payload->>'operation' IS NULL OR p_payload->>'operation' NOT IN ('question','research','organize','plan','work')
 OR (p_payload->'scope'->>'kind'='positioning_draft' AND p_payload->>'operation'='work')
 OR coalesce(p_payload->>'mode','') NOT IN ('isolated','staging_test','production') OR NOT(p_payload ? 'input')
 OR coalesce(p_payload->>'sourceHash','') !~ '^[a-f0-9]{64}$' OR coalesce(length(p_payload->'rules'->>'version'),0)=0
 OR coalesce(length(p_payload->'rules'->>'quoteVersion'),0)=0 THEN RAISE EXCEPTION 'BILL2_INVALID_CONTRACT';END IF;
 -- 0289 tool-only run
 IF NOT EXISTS(SELECT 1 FROM ai_models WHERE id=(p_payload->>'modelId')::uuid AND is_active='true')
  AND NOT publish_monitor_tool_only_run(p_payload) THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;
 IF p_payload->>'revisionId' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM skill_revisions sr JOIN skills s ON s.id=sr.skill_id WHERE sr.id=(p_payload->>'revisionId')::uuid AND s.status='published') THEN RAISE EXCEPTION 'BILL2_REVISION_DENIED';END IF;
 b:=bill2_decimal(p_payload->'limits'->'costUsd');rate:=bill2_decimal(p_payload->'rules'->'creditsPerUsd');m:=bill2_decimal(p_payload->'rules'->'multiplier');
 reservation:=(p_payload->'limits'->>'credits')::integer;
 IF b<=0 OR b>100000 OR rate<=0 OR m<=0 OR reservation IS NULL OR (CASE WHEN p_payload->>'contractVersion'='bill2.v2' THEN reservation<>0 ELSE reservation<=0 OR ceil(b*rate*m)>reservation END)
 OR reservation>(p_payload->'limits'->>'maxPreDeduct')::integer OR (p_payload->'limits'->>'maxPreDeduct') IS NULL
 OR coalesce((p_payload->'limits'->>'maxCalls')::integer,0) NOT BETWEEN 1 AND 32
 OR (p_payload->'limits'->>'deadline') IS NULL OR (p_payload->'limits'->>'deadline')::timestamptz<=clock_timestamp()
 OR (p_payload->'limits'->>'deadline')::timestamptz>clock_timestamp()+interval '24 hours'
 OR jsonb_typeof(p_payload->'rules'->'fx') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BILL2_INVALID_BUDGET';END IF;
 FOR fx IN SELECT * FROM jsonb_each(p_payload->'rules'->'fx') LOOP
  IF fx.key !~ '^[A-Z]{3}$' OR coalesce(length(fx.value->>'version'),0)=0 OR bill2_decimal(fx.value->'usdPerUnit')<=0 THEN RAISE EXCEPTION 'BILL2_INVALID_FX';END IF;
 END LOOP;
 -- Lock directly for update: admission must observe a suspension that won the profile lock, without a share-lock upgrade race.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 INSERT INTO bill2_runs(id,actor_id,request_id,scope,payload,contract_version,reserved,budget_usd,credits_per_usd,multiplier,max_calls,deadline)
 VALUES(new_id,p_actor_id,p_request_id,p_payload->'scope',p_payload,p_payload->>'contractVersion',reservation,b,rate,m,(p_payload->'limits'->>'maxCalls')::integer,(p_payload->'limits'->>'deadline')::timestamptz);
 IF p_payload->>'contractVersion'='bill2.v2' THEN
  IF jsonb_typeof(p_payload->'rules'->'billingUnit') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BILL2_UNIT_REQUIRED';END IF;
  SELECT * INTO r FROM bill2_runs WHERE id=new_id;RETURN bill2_public(r);
 END IF;
 -- Internal UUID is independent of public/legacy request IDs. Never adopt an old pre-deduction.
 SELECT * INTO q FROM atomic_pre_deduct(p_actor_id,reservation,'BILL2 reservation',new_id);
 IF q.is_idempotent THEN RAISE EXCEPTION 'BILL2_PREDEDUCT_CONFLICT';END IF;
 UPDATE bill2_runs SET pre_deduct_id=q.pre_deduct_id WHERE id=new_id RETURNING * INTO r;
 -- Profile lock serializes this actor; distinct timestamps preserve legacy timestamp-only pagination.
 INSERT INTO credit_transactions(created_at,user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,idempotency_key,balance_before,balance_after,bill2_run_id,metadata)
 VALUES(greatest(clock_timestamp(),coalesce((SELECT max(t.created_at)+interval '1 microsecond' FROM credit_transactions t WHERE t.user_id=p_actor_id),'-infinity'::timestamptz)),p_actor_id,-reservation,'adjustment','Run reservation','adjustment','bill2_reserve','ai_task',new_id::text,'bill2:'||new_id||':reserve',q.balance_before,q.balance_after,new_id,jsonb_build_object('contractVersion','bill2.v1','preDeductId',q.pre_deduct_id));
 RETURN bill2_public(r);
END $function$;

REVOKE ALL ON FUNCTION public.runtime_admit_precheck(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.runtime_admit_commit(uuid,uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_admit_precheck(uuid,uuid,uuid,jsonb,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.runtime_admit_commit(uuid,uuid,uuid,jsonb,jsonb,jsonb) TO service_role;

COMMIT;
