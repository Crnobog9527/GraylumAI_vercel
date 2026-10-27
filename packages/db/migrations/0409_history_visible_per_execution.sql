-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- DB-PERF (number 0409 assigned by the controller).
-- Coach admission cost grows with the length of the conversation. 2026-10-27 A/B on staging, 30 coach users: accounts whose
-- coach session holds 70-116 history rows spent 6-10 s in runtime_admit and failed 19-65% of turns (57014); 30 fresh accounts
-- spent 2.2-2.6 s and failed 10-12%. runtime_admit picks the last historyItems+128 history rows (up to 228) and ran the
-- own-post visibility test runtime_workspace_posts_history_visible(execution_id) once for EVERY ROW, although the answer
-- depends only on the execution and a coach execution owns about five rows; runtime_history_availability already ran once per
-- execution. The same pattern is in runtime_session_items (action 'read', and the count in action 'freeze').
-- Change, same result row for row: the visibility test runs once per execution that is available (a MATERIALIZED CTE next to
-- the availability one) and the rows are joined to the executions that passed both tests. A row is kept exactly when its
-- execution is available and visible, as before; the order, the limits and everything else are unchanged.
-- Compatibility: same signatures, results and privileges; old and new application code are interchangeable.
-- Repeatable: CREATE OR REPLACE only, no data or index change. Recovery: re-apply runtime_admit and runtime_session_items from
-- packages/db/functions as of 0406 (slower on long conversations, same results).
BEGIN;
SET LOCAL lock_timeout='5s';

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
     ELSE model_id END)=(p_billing->>'modelId')::uuid FOR SHARE;
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

CREATE OR REPLACE FUNCTION public.runtime_session_items(p_actor_id uuid, p_session_id uuid, p_execution_id uuid, p_action text, p_items jsonb DEFAULT NULL::jsonb, p_limit integer DEFAULT NULL::integer, p_batch integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;e runtime_executions;b runtime_session_batches;n integer;answer jsonb;selected bigint[];omitted_notice boolean:=false;
 batches jsonb;cur jsonb;nb integer;
BEGIN
 -- D7 read boundary
 PERFORM content_erasure_runtime_check(p_actor_id,p_execution_id);
 PERFORM bill2_actor(p_actor_id);
 -- DB-100 C3 read check (0384): this running reply already checked its lineage and admit its history.
 IF p_action='read' AND runtime_read_verified(p_actor_id,p_execution_id) THEN
  SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
  SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=s.id AND actor_id=p_actor_id;
  IF s.id IS NULL OR e.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SESSION_DENIED';END IF;
  IF p_limit<0 THEN RAISE EXCEPTION 'RUNTIME_SESSION_LIMIT';END IF;
  SELECT coalesce(jsonb_agg(item ORDER BY revision),'[]') INTO answer FROM (
   SELECT jsonb_build_object('revision',h.revision,'item',h.item) item,h.revision
   FROM runtime_session_history h JOIN runtime_executions x ON x.id=h.execution_id
   WHERE h.session_id=s.id AND h.revision=ANY(coalesce(e.selected_history,e.candidate_history)) AND NOT h.internal_control
    AND x.actor_id=p_actor_id AND x.unavailable_reason IS NULL AND x.erased_at IS NULL AND x.content_deleted_at IS NULL
   ORDER BY h.revision DESC LIMIT p_limit
  ) x;
  RETURN answer;
 END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=s.id AND actor_id=p_actor_id;
 IF s.id IS NULL OR e.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SESSION_DENIED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,(SELECT payload FROM bill2_runs WHERE id=e.billing_run_id),e.billing_run_id);
 IF p_action='read' THEN
  IF p_limit<0 THEN RAISE EXCEPTION 'RUNTIME_SESSION_LIMIT';END IF;
  -- Freeze the SDK's initial history for replay; this execution's own batches
  -- are replayed by the host, never injected again as previous-turn history.
  WITH candidates AS MATERIALIZED (
   SELECT h.revision,h.execution_id,h.item FROM runtime_session_history h
   WHERE h.session_id=s.id AND h.revision=ANY(coalesce(e.selected_history,e.candidate_history)) AND NOT h.internal_control
  ), availability AS MATERIALIZED (
   SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM candidates))
  ), visible AS MATERIALIZED (
   -- 0409: the own-post visibility test depends on the execution only: once per execution, not once per history row.
   SELECT a.execution_id FROM availability a WHERE a.available AND runtime_workspace_posts_history_visible(a.execution_id)
  )
  SELECT coalesce(jsonb_agg(item ORDER BY revision),'[]') INTO answer FROM (
   SELECT jsonb_build_object('revision',revision,'item',item) item,revision
   FROM candidates JOIN visible USING(execution_id) ORDER BY revision DESC LIMIT p_limit
  ) x;
  RETURN answer;
 ELSIF p_action='freeze' THEN
  -- New service callers can attach one fixed diagnostic to the existing freeze.
  -- Old array callers and replay keep their original wire contract.
  IF jsonb_typeof(p_items)='object' THEN
   IF p_items->'historyOmitted' IS DISTINCT FROM 'true'::jsonb
    OR NOT (p_items ? 'revisions')
    OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_items) k WHERE k NOT IN ('revisions','historyOmitted'))
   THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
   omitted_notice:=true;p_items:=p_items->'revisions';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>1000 THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  SELECT coalesce(array_agg(v::bigint ORDER BY v::bigint),ARRAY[]::bigint[]) INTO selected FROM jsonb_array_elements_text(p_items) v;
  IF e.selected_history IS NOT NULL THEN
   IF e.selected_history IS DISTINCT FROM selected OR (omitted_notice AND NOT e.history_omitted) THEN RAISE EXCEPTION 'RUNTIME_HISTORY_CHANGED';END IF;
   RETURN to_jsonb(selected);
  END IF;
  IF cardinality(selected)>greatest(0,least(1000,coalesce((e.payload->>'historyItems')::int,0)))
   OR cardinality(selected)<>(SELECT count(DISTINCT v) FROM unnest(selected) v)
   OR NOT selected<@e.candidate_history
   OR cardinality(selected)<>(WITH candidates AS MATERIALIZED (
    SELECT h.execution_id FROM runtime_session_history h WHERE h.session_id=s.id AND h.revision=ANY(selected)
   ), availability AS MATERIALIZED (
    SELECT * FROM runtime_history_availability(ARRAY(SELECT DISTINCT execution_id FROM candidates))
   ), visible AS MATERIALIZED (
    SELECT a.execution_id FROM availability a WHERE a.available AND runtime_workspace_posts_history_visible(a.execution_id)
   ) SELECT count(*) FROM candidates JOIN visible USING(execution_id))
   OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=e.billing_run_id AND payload->>'phase'<>'skill_matching')
  THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  IF omitted_notice AND (cardinality(selected)=0 OR cardinality(selected)>=cardinality(e.candidate_history)
   OR s.active_execution IS DISTINCT FROM e.id OR e.state<>'running'
   OR EXISTS(SELECT 1 FROM bill2_runs WHERE id=e.billing_run_id AND (closed OR cancel_requested)))
  THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  -- Membership and notice commit together, before any primary model call.
  UPDATE runtime_executions SET selected_history=selected,history_omitted=omitted_notice WHERE id=e.id;
  INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
   SELECT DISTINCT e.id,h.execution_id FROM runtime_session_history h WHERE h.session_id=s.id AND h.revision=ANY(selected);
  RETURN to_jsonb(selected);
 ELSIF p_action IN ('append','append_batches') THEN
  IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=e.billing_run_id AND (cancel_requested OR closed)) THEN RAISE EXCEPTION 'RUNTIME_SESSION_CLOSED';END IF;
  IF s.active_execution IS DISTINCT FROM e.id OR e.state IN ('completed','cancelled') THEN RAISE EXCEPTION 'RUNTIME_SESSION_CLOSED';END IF;
  -- DB-PERF 0402: append_batches writes consecutive batches p_batch, p_batch+1, ... after one set of checks;
  -- each batch keeps the single-append rules (replay of an identical saved batch, conflict, order, 128 items).
  IF p_action='append' THEN batches:=jsonb_build_array(p_items);
  ELSIF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'RUNTIME_SESSION_BATCH';
  ELSE batches:=p_items;END IF;
  FOR i IN 0..jsonb_array_length(batches)-1 LOOP
   cur:=batches->i;nb:=p_batch+i;
   IF p_batch IS NULL OR p_batch<0 OR jsonb_typeof(cur) IS DISTINCT FROM 'array' OR jsonb_array_length(cur)>128 THEN RAISE EXCEPTION 'RUNTIME_SESSION_BATCH';END IF;
   SELECT * INTO b FROM runtime_session_batches WHERE execution_id=e.id AND batch=nb;
   IF b.execution_id IS NOT NULL THEN
    IF b.items IS DISTINCT FROM cur THEN RAISE EXCEPTION 'RUNTIME_SESSION_CONFLICT';END IF;
    CONTINUE;
   END IF;
   IF nb<>(SELECT count(*) FROM runtime_session_batches WHERE execution_id=e.id) THEN RAISE EXCEPTION 'RUNTIME_SESSION_BATCH_ORDER';END IF;
   n:=jsonb_array_length(cur);
   INSERT INTO runtime_session_batches VALUES(s.id,e.id,nb,cur,s.revision,s.revision+n);
   INSERT INTO runtime_session_history(session_id,revision,execution_id,item,internal_control)
    SELECT s.id,s.revision+ordinality,e.id,value,(e.payload ? 'matching' AND nb=0) FROM jsonb_array_elements(cur) WITH ORDINALITY;
   UPDATE runtime_sessions SET revision=revision+n WHERE id=s.id RETURNING * INTO s;
  END LOOP;
  RETURN 'null'::jsonb;
 END IF;
 RAISE EXCEPTION 'RUNTIME_SESSION_ACTION';
END $function$;

COMMIT;
