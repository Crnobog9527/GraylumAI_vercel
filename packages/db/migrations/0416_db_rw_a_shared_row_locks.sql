-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-RW-A (number 0416 assigned by the controller; design: db-rw-redesign-v1 section 9, PR-A).
-- Row locks on rows every turn of every user shares are removed; no behaviour of any check changes, only what the checks lock.
-- (The design note also asked for an index on runtime_executions(session_id); it already exists since 0321 as
--  runtime_executions_session_created_idx on (session_id, created_at, id), and the plans of the turn-path statements use it.)
-- Row locks removed: runtime_direct_billing_allowed_before_opc took
--     FOR SHARE on the model row (ai_models), the module row (modules), skills and skill_revisions, runtime_admit on the
--     module row again when it binds the Skill, and bill2_payg_claim on
--     the system_settings row of the start thresholds: 30 concurrent turns share-lock the same few rows, each lock is a
--     MultiXact member write, and each blocks an administrator's UPDATE until the turn commits. The checks themselves
--     stay (the same SELECTs still raise the same errors when the row is missing, inactive or revoked) and every later
--     step re-runs them: bill2_payg_claim and bill2_dispatch call runtime_billing_allowed again before any money moves,
--     so a module or revision deactivated between two steps stops the next step; the call that is already frozen keeps
--     the price and package hash it was frozen with. The threshold setting is read once per claim and its version string
--     is stored on the call (threshold_version), so a change between the read and the commit changes nothing that was used.
--     NOTE for the reviewer: the design note says the (201,1) advisory lock already orders settings writers against claims;
--     it does not for billing_payg_start_thresholds (runtime_stop_loss_settings_guard takes (201,1) only for
--     runtime_stop_loss and runtime_rate_limits). The reason to drop this lock is the one above, not (201,1).
-- Not changed on purpose: runtime_executions_own_posts and bill2_runs_recovery_open are partial indexes with their own
-- predicates (ownPosts executions, open runs), added by 0363 and 0388 for the library cleanup scope and the recovery jobs;
-- they are not copies of the primary key, so they stay.
-- Compatibility: same signatures, results and privileges; old and new application code are interchangeable.
-- Repeatable: CREATE OR REPLACE only, no data or index change. Recovery: re-apply the three functions from
-- packages/db/functions as of 0409.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.bill2_payg_claim(a uuid, rid uuid, seq integer, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r bill2_runs;c bill2_calls;w runtime_test_windows;n integer;used numeric;used_calls bigint;
 cfg jsonb;threshold jsonb;avail integer;g numeric;h integer;q record;u numeric;m_call numeric;l numeric;
BEGIN
 -- 0326 Fusion run archive guard
 -- 0324 archived business guard
 PERFORM opc_assert_business_writable(a,jsonb_build_object('runId',rid));
 SELECT * INTO r FROM bill2_runs WHERE id=rid AND actor_id=a FOR UPDATE;
 -- DB-100 C2 payload read once: fetch and decompress the TOAST value here, not at every r.payload use.
 -- A run payload is always a JSON object (bill2_prepare); || '{}' returns it unchanged.
 r.payload:=r.payload||'{}'::jsonb;
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
 IF (fusion_purpose(p) OR r.fusion_group_id IS NOT NULL) AND (r.fusion_group_id IS NULL
  OR current_setting('graylum.fusion_group_claim',true) IS DISTINCT FROM r.fusion_group_id::text) THEN
  RAISE EXCEPTION 'FUSION_GROUP_CLAIM_REQUIRED';END IF;
 IF r.payload#>'{input,reportGeneration}' IS NOT NULL THEN
  PERFORM report_membership_check(a);
  IF p->>'phase' IS DISTINCT FROM 'report' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
  IF (report_source(a,r.session_ref,(r.payload#>>'{input,reportGeneration,projectId}')::uuid,
    (r.payload#>>'{input,reportGeneration,roundId}')::uuid)->>'snapshotHash')
    IS DISTINCT FROM r.payload#>>'{input,reportGeneration,snapshotHash}' THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';END IF;
  -- 0268 benchmark claim
  PERFORM research_benchmark_report_current(a,r.session_ref,r.payload#>'{input,reportGeneration}');
 END IF;
 IF r.session_ref IS NOT NULL AND (coalesce(p->>'runtimeEpoch','') !~ '^[1-9][0-9]*$'
  OR (p->>'runtimeEpoch')::bigint IS DISTINCT FROM r.runtime_epoch
  OR NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
    WHERE e.billing_run_id=r.id AND e.state='running' AND s.active_execution=e.id)
  OR r.runtime_dispatch_deadline IS NULL) THEN RAISE EXCEPTION 'RUNTIME_RESUME_CONFLICT';END IF;
 IF r.paused_reason='user_stop' THEN RAISE EXCEPTION 'RUNTIME_STOP_REQUESTED';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=
  (CASE WHEN r.session_ref IS NOT NULL THEN r.runtime_dispatch_deadline ELSE r.deadline END) THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 IF octet_length(p::text)>65536 THEN RAISE EXCEPTION 'BILL2_CALL_TOO_LARGE';END IF;
 -- 0255 tool quote
 IF p->>'protocol'='research-tool-v1' THEN PERFORM bill2_payg_validate_tool_quote(r,p);
 ELSE PERFORM bill2_payg_validate_quote(r,p);END IF;
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
 -- The same frozen call multiplier is used for both L and G.
 m_call:=bill2_unit_multiplier(p->'billingUnit'->'multiplier');
 IF r.fusion_group_id IS NOT NULL AND current_setting('graylum.fusion_group_claim',true)=r.fusion_group_id::text THEN
  cfg:=jsonb_build_object('version','fusion-group-bound');l:=greatest(1,ceil(u*r.credits_per_usd*m_call));
 ELSE
 SELECT value INTO cfg FROM system_settings WHERE key='billing_payg_start_thresholds';
 IF jsonb_typeof(cfg->'version') IS DISTINCT FROM 'string' OR btrim(cfg->>'version')=''
  OR jsonb_typeof(cfg->'thresholds') IS DISTINCT FROM 'array' THEN
  RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';
 END IF;
 SELECT x INTO threshold FROM jsonb_array_elements(cfg->'thresholds') x
  WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase';
 IF (SELECT count(*) FROM jsonb_array_elements(cfg->'thresholds') x
  WHERE x->>'model'=p->>'model' AND x->>'purpose'=p->>'phase')<>1 THEN
  RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';
 END IF;
 IF threshold ? 'typicalUsd' THEN
  -- Never fall back to legacy credits for an invalid or ambiguous new entry.
  IF threshold ? 'credits' OR jsonb_typeof(threshold->'typicalUsd') IS DISTINCT FROM 'string'
   OR coalesce(threshold->>'typicalUsd','') !~ '^(0|[1-9][0-9]{0,11})(\.[0-9]{1,12})?$' THEN
   RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';
  END IF;
  l:=greatest(1,ceil((threshold->>'typicalUsd')::numeric*r.credits_per_usd*m_call));
  IF l>2147483647 THEN RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';END IF;
 ELSE
  -- Transitional reads retain the existing integer-credit meaning, without rescaling.
  IF coalesce(threshold->>'credits','') !~ '^[1-9][0-9]{0,8}$' THEN
   RAISE EXCEPTION 'BILL2_START_THRESHOLD_UNCONFIGURED';
  END IF;
  l:=(threshold->>'credits')::int;
 END IF;
 END IF;
 -- The balance already excludes all pre-deductions. Subtract only unavailable grant remainder.
 PERFORM id FROM subscription_credit_grants WHERE user_id=a ORDER BY id FOR UPDATE;
 avail:=greatest(credit_available(a),0); -- MAINT-P4 one formula: review barrier and every hold
 -- Its earlier patches here (ARCH-FIX E1, -- PAY-REFUND-HOLD, -- PAY-D1 claim-pending) live in credit_available;
 -- their markers stay so that re-running those migrations leaves this function alone.
 IF avail<l THEN
  UPDATE bill2_runs SET paused_reason='insufficient_credits',version=version+1 WHERE id=rid;
  RETURN jsonb_build_object('id',NULL,'state','waiting_credits','dispatchToken',NULL);
 END IF;
 g:=ceil(u*r.credits_per_usd*m_call);h:=least(g,avail)::int;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd)
 VALUES(rid,seq,p,p->>'provider',p->>'account',p->>'model',u) RETURNING * INTO c;
  -- DB-PERF 0362 late metering check: a block committed by a writer holding (201,1) exclusively
  -- is visible here; a writer that comes later waits for this claim to commit.
  PERFORM pg_advisory_xact_lock_shared(201,1);
  IF EXISTS(SELECT 1 FROM bill2_calls x WHERE x.model=p->>'model' AND x.id<>c.id
   AND (x.budget_conflict OR x.metering_missing OR x.metering_exit) AND x.metering_review_audit_id IS NULL)
  THEN RAISE EXCEPTION 'BILL2_PAYG_METERING_BLOCKED';END IF;
 SELECT * INTO q FROM atomic_pre_deduct(a,h,'BILL2 call reservation',c.id);
 IF q.is_idempotent THEN RAISE EXCEPTION 'BILL2_PREDEDUCT_CONFLICT';END IF;
 UPDATE bill2_calls SET pre_deduct_id=q.pre_deduct_id,reserved_credits=h,available_credits=avail,
  runtime_epoch=CASE WHEN r.session_ref IS NOT NULL THEN r.runtime_epoch ELSE NULL END,
  dispatch_deadline=coalesce(r.runtime_dispatch_deadline,r.deadline),
  recovery_deadline=coalesce(r.runtime_dispatch_deadline,r.deadline)+interval '24 hours',
  supersedes_call_id=(SELECT id FROM bill2_calls WHERE run_id=r.id AND sequence=seq-1 AND runtime_retryable
   AND state='cancelled' AND dispatched_at IS NULL AND settled_at IS NOT NULL
   AND payload->>'requestHash'=p->>'requestHash' AND payload->>'phase'=p->>'phase'),
  start_threshold=l::int,threshold_version=cfg->>'version' WHERE id=c.id;
 INSERT INTO credit_transactions(user_id,amount,type,description,ledger_type,reason_code,source_type,source_id,
  idempotency_key,balance_before,balance_after,bill2_run_id,bill2_call_id,metadata)
 VALUES(a,-h,'adjustment','Call reservation','adjustment','bill2_reserve','ai_task',rid::text,
 'bill2:'||c.id||':reserve',q.balance_before,q.balance_after,rid,c.id,
 jsonb_build_object('contractVersion','bill2.v2','preDeductId',q.pre_deduct_id,'G',g::text,'H',h,'A',avail,'L',l::int,'thresholdVersion',cfg->>'version'));
 UPDATE bill2_runs SET paused_reason=NULL,version=version+1 WHERE id=rid;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_direct_billing_allowed_before_opc(a uuid, p jsonb, p_run_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v jsonb;m uuid;k uuid;rev uuid; policy jsonb; entry jsonb; chosen jsonb;matched jsonb;
BEGIN
 PERFORM bill2_actor(a);
 -- Window enablement governs new dispatch, not retained content permissions.
 IF coalesce(p->>'mode','') NOT IN ('staging_test','production') THEN PERFORM runtime_test_window_allowed(a,p);END IF;
 PERFORM runtime_context_allowed(a,p->'input');
 IF p->'scope'->>'kind'='positioning_draft' THEN
  PERFORM id FROM bill2_drafts WHERE id=(p->'scope'->>'draftId')::uuid AND actor_id=a AND NOT revoked FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 ELSE
  -- Match artifact_create_work / reference save order: config, source, account, target.
  PERFORM cfg.id FROM artifact_reference_configs cfg WHERE cfg.id IN (SELECT config_id FROM artifact_work_references WHERE project_id=(p->'scope'->>'workItemId')::uuid) ORDER BY cfg.id FOR SHARE;
  PERFORM id FROM artifact_projects WHERE id=(p->'scope'->>'projectId')::uuid FOR SHARE;
  PERFORM ac.actor_id FROM artifact_accounts ac JOIN artifact_projects src ON src.id=(p->'scope'->>'projectId')::uuid
   WHERE ac.actor_id=src.actor_id AND ac.module_id=src.module_id AND ac.skill_id=src.skill_id AND ac.account=src.account FOR KEY SHARE OF ac;
  PERFORM id FROM artifact_projects WHERE id=(p->'scope'->>'workItemId')::uuid FOR SHARE;
 END IF;
 IF NOT coalesce(bill2_scope_allowed(a,p->'scope'),false) THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 policy:=p->'callPolicy';
 IF jsonb_typeof(policy) IS DISTINCT FROM 'array' OR jsonb_array_length(policy) NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_REQUIRED';END IF;
 IF p->'input' ? 'matching' THEN
  SELECT e.match_result INTO matched FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id WHERE e.actor_id=a AND r.id=p_run_id AND r.actor_id=a AND r.payload=p;
  SELECT c INTO chosen FROM jsonb_array_elements(p->'input'->'matching'->'candidates') c WHERE c->>'key'=matched->>'key';
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(policy) ORDER BY value->>'modelId' LOOP
  -- After the immutable choice, unused candidate models are not dependencies.
  -- The insertion guard below prevents claims against these unused policies.
  IF matched IS NOT NULL AND entry->>'modelId' IS DISTINCT FROM p->>'modelId'
   AND entry->>'modelId' IS DISTINCT FROM chosen->>'modelId'
   AND entry->>'modelId' IS DISTINCT FROM p->'input'->'attachedOrganizer'->>'modelId' THEN CONTINUE;END IF;
  -- 0255 tool policies
  IF entry->>'protocol'='research-tool-v1' THEN
   IF p->>'contractVersion' IS DISTINCT FROM 'bill2.v2'
    OR coalesce(entry->>'provider','') NOT IN ('tikhub','parallel','firecrawl') OR coalesce(length(entry->>'account'),0)=0
    OR coalesce(length(entry->>'model'),0)=0 OR entry->>'modelId' IS DISTINCT FROM bill2_tool_model_id(entry->>'model')::text
    OR bill2_decimal(entry->'upperUsd')<=0 OR entry->'lookupSupported' IS DISTINCT FROM 'false'::jsonb
    OR jsonb_typeof(entry->'toolPricing') IS DISTINCT FROM 'object' OR jsonb_typeof(entry->'purposes') IS DISTINCT FROM 'array'
    OR entry->>'modelId'=p->>'modelId' THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_DENIED';END IF;
   CONTINUE;
  END IF;
  PERFORM id FROM ai_models WHERE id=(entry->>'modelId')::uuid AND model_id=entry->>'model' AND (provider=entry->>'provider' OR (p->>'mode' IN ('staging_test','production') AND entry->>'provider'='openrouter' AND provider IN ('openai','openrouter','anthropic'))) AND is_active='true';
  IF NOT FOUND OR entry->>'protocol' IS DISTINCT FROM (CASE WHEN p->>'mode' IN ('staging_test','production') THEN 'openrouter-chat-v1' ELSE 'fixture-cost-v1' END) OR coalesce(length(entry->>'account'),0)=0
  OR coalesce((entry->>'inputLimit')::int,0) NOT BETWEEN 1 AND 1000000 OR coalesce((entry->>'outputLimit')::int,0) NOT BETWEEN 1 AND 1000000
  OR bill2_decimal(entry->'upperUsd')<=0 OR entry->'automaticRetry' IS DISTINCT FROM 'false'::jsonb OR entry->'hiddenTools' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(entry->'lookupSupported') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_DENIED';END IF;
 END LOOP;
 -- 0289 tool-only run
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy) x WHERE x->>'modelId'=p->>'modelId')
  AND NOT publish_monitor_tool_only_run(p) THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;
 rev:=(p->>'revisionId')::uuid;
 IF rev IS NOT NULL THEN
  m:=(p->>'moduleId')::uuid;k:=(p->>'skillId')::uuid;
  -- Preserve omitted-identity 0105 work requests only when no Runtime binding
  -- exists. runtime_admit requires both selected IDs before calling BILL2;
  -- no payload mode/version flag can opt a Runtime execution into this fallback.
  IF (m IS NULL OR k IS NULL) AND p->'scope'->>'kind'='work_item'
   AND NOT EXISTS(SELECT 1 FROM runtime_executions WHERE billing_run_id=p_run_id) THEN
   SELECT module_id,skill_id INTO m,k FROM artifact_projects WHERE id=(p->'scope'->>'workItemId')::uuid;
  END IF;
  -- Scope ownership/account/source checks above are independent of the
  -- explicitly selected Skill; never replace its identity with the work owner.
  IF EXISTS(SELECT 1 FROM runtime_executions WHERE billing_run_id=p_run_id AND actor_id=a) THEN
   PERFORM id FROM modules WHERE id=m AND skill_id=k AND active AND (
    (NOT (p->'input' ? 'reportGeneration') AND model_id=(p->>'modelId')::uuid)
    OR (p->'input' ? 'reportGeneration' AND EXISTS(
     SELECT 1 FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
     WHERE r.id=p_run_id AND r.actor_id=a AND e.actor_id=a AND r.payload=p
      AND e.payload=p->'input' AND e.payload ? 'reportGeneration'))
   );
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
  ELSE
   PERFORM id FROM modules WHERE id=m;
  END IF;
  PERFORM id FROM skills WHERE id=k;
  PERFORM id FROM skill_revisions WHERE id=rev AND skill_id=k;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_REVISION_DENIED';END IF;
  PERFORM read_skill_package(a,m,k,rev,NULL,'');
 END IF;
 -- The original frozen plan remains immutable. A later selection can only
 -- activate one of its candidates and must remain available on every access.
 IF p->'input' ? 'matching' THEN
  SELECT c INTO chosen FROM runtime_executions e,
   LATERAL jsonb_array_elements(e.payload->'matching'->'candidates') c
   WHERE e.actor_id=a AND e.billing_run_id=p_run_id AND EXISTS(SELECT 1 FROM bill2_runs r WHERE r.id=p_run_id AND r.actor_id=a AND r.payload=p)
    AND c->>'key'=e.match_result->>'key';
  IF chosen IS NOT NULL THEN
   m:=(chosen->>'moduleId')::uuid;k:=(chosen->>'skillId')::uuid;rev:=(chosen->>'revisionId')::uuid;
   PERFORM id FROM modules WHERE id=m AND active AND model_id=(chosen->>'modelId')::uuid;
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_MATCH_REVOKED';END IF;
   PERFORM id FROM skills WHERE id=k;
   PERFORM id FROM skill_revisions WHERE id=rev AND skill_id=k;
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_MATCH_REVOKED';END IF;
   PERFORM read_skill_package(a,m,k,rev,chosen->>'packageHash','');
  END IF;
 END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_admit(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_payload jsonb, p_billing jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b jsonb;history_candidates bigint[];source runtime_executions;prior_turn opc_turns;current_turn opc_turns;card jsonb;answer jsonb;idx integer;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('sessionId',p_session_id)); END IF;

 -- D7 read boundary
 IF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
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
  ), visible AS MATERIALIZED (
   -- 0409: the own-post visibility test depends on the execution only, so it runs once per execution, not once per history row.
   SELECT a.execution_id FROM availability a WHERE a.available AND runtime_workspace_posts_history_visible(a.execution_id)
  )
  SELECT revision FROM bounded JOIN visible USING(execution_id) ORDER BY revision);
 -- Runtime requires the administrator model binding; legacy unbound BILL2
 -- callers keep their existing package authorization contract.
 IF p_billing->>'revisionId' IS NOT NULL THEN
  PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
   AND skill_id=(p_billing->>'skillId')::uuid AND active
   AND (CASE WHEN p_payload ? 'reportGeneration' THEN coalesce(report_model_id,model_id)
     ELSE model_id END)=(p_billing->>'modelId')::uuid;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
 END IF;
 b:=bill2_prepare(p_actor_id,p_request_id,p_billing);
 INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,billing_run_id,history_revision)
 VALUES(p_actor_id,s.id,p_request_id,p_payload,(b->>'id')::uuid,s.revision) RETURNING * INTO e;
 UPDATE runtime_executions SET candidate_history=history_candidates WHERE id=e.id;
 UPDATE bill2_runs SET session_ref=s.id WHERE id=e.billing_run_id;
 UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
 -- 0295 report price
 IF p_payload ? 'reportGeneration' THEN PERFORM report_fee_hold(e,p_billing); END IF;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
END $function$;

COMMIT;
