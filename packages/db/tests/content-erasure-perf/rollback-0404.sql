-- The three functions of 0404 as of 0403, for verify.mjs --before-0404 / --before-fix.
CREATE OR REPLACE FUNCTION public.erasure_ledger_value(v jsonb, shape jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE k text; item jsonb; result jsonb; typ text:=shape#>>'{}';
BEGIN
 IF v IS NULL OR v='null'::jsonb THEN RETURN v; END IF;
 IF jsonb_typeof(shape)='object' AND shape ? '$enum' THEN
  IF jsonb_typeof(v)='string' AND (shape->'$enum') @> jsonb_build_array(v) THEN RETURN v; END IF;
  RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE';
 END IF;
 IF jsonb_typeof(shape)='object' THEN
  IF jsonb_typeof(v)<>'object' THEN RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE'; END IF;
  result:='{}';
  FOR k,item IN SELECT * FROM jsonb_each(shape) LOOP
   IF v ? k THEN result:=result||jsonb_build_object(k,erasure_ledger_value(v->k,item)); END IF;
  END LOOP;
  RETURN result;
 ELSIF jsonb_typeof(shape)='array' THEN
  IF jsonb_typeof(v)<>'array' THEN RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE'; END IF;
  result:='[]';
  FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
   result:=result||jsonb_build_array(erasure_ledger_value(item,shape->0));
  END LOOP;
  RETURN result;
 END IF;
 IF typ='number' AND jsonb_typeof(v) IN ('number','string')
  AND v#>>'{}' ~ '^-?[0-9]+(\.[0-9]+)?$' THEN RETURN v; END IF;
 IF typ='delivery_failure_reason' AND v='"confirmed_delivery_failure"'::jsonb THEN RETURN v; END IF;
 IF typ='boolean' AND jsonb_typeof(v)='boolean' THEN RETURN v; END IF;
 IF typ='id' AND jsonb_typeof(v)='string' AND length(v#>>'{}')>0 THEN RETURN v; END IF;
 RAISE EXCEPTION 'ERASURE_LEDGER_INVALID_EVIDENCE';
END $function$;

CREATE OR REPLACE FUNCTION public.erasure_ledger_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE prior jsonb; incoming jsonb:=to_jsonb(NEW); projected jsonb; cols text[]; closed boolean;
BEGIN
 cols:=CASE TG_TABLE_NAME WHEN 'credit_transactions' THEN ARRAY['description','metadata','content_erased_at']
  WHEN 'billing_history' THEN ARRAY['reason','metadata','content_erased_at']
  WHEN 'token_stats' THEN ARRAY['metadata','content_erased_at']
  WHEN 'ai_usage_logs' THEN ARRAY['error_message','ip_address','user_agent','metadata','content_erased_at'] END;
 IF cols IS NULL THEN RAISE EXCEPTION 'ERASURE_LEDGER_TABLE_DENIED'; END IF;
 IF TG_OP='UPDATE' THEN prior:=to_jsonb(OLD); END IF;
 IF TG_OP='INSERT' AND incoming->>'content_erased_at' IS NOT NULL THEN
  RAISE EXCEPTION 'ERASURE_LEDGER_IMMUTABLE';
 END IF;
 -- Existing client paths remain unchanged. They cannot claim cleanup or bypass closed-account RLS.
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  AND current_user<>'service_role' THEN
  IF incoming->>'content_erased_at' IS NOT NULL THEN RAISE EXCEPTION 'ERASURE_LEDGER_DENIED'; END IF;
  RETURN NEW;
 END IF;
 closed:=EXISTS(SELECT 1 FROM account_erasure_requests e JOIN profiles p ON p.id=e.profile_id
  WHERE e.profile_id=NEW.user_id AND p.status='deleted' AND p.is_deleted='true');
 -- D7 original ledger binding
 closed:=closed OR content_erasure_ledger_owned(incoming);
 IF prior->>'content_erased_at' IS NOT NULL THEN
  IF incoming->'content_erased_at' IS DISTINCT FROM prior->'content_erased_at'
   OR incoming->'user_id' IS DISTINCT FROM prior->'user_id' THEN
   RAISE EXCEPTION 'ERASURE_LEDGER_IMMUTABLE';
  END IF;
 ELSIF TG_OP='UPDATE' AND incoming->>'content_erased_at' IS NOT NULL THEN
  IF NOT closed OR current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   OR (incoming-cols) IS DISTINCT FROM (prior-cols) THEN
   RAISE EXCEPTION 'ERASURE_LEDGER_DENIED';
  END IF;
 ELSIF NOT closed THEN RETURN NEW;
 END IF;
 projected:=erasure_ledger_metadata(NEW.metadata);
 IF TG_OP='UPDATE' AND prior->>'content_erased_at' IS NULL
  AND incoming->>'content_erased_at' IS NOT NULL
  AND projected IS DISTINCT FROM erasure_ledger_metadata(OLD.metadata) THEN
  RAISE EXCEPTION 'ERASURE_LEDGER_EVIDENCE_CHANGED';
 END IF;
 incoming:=incoming||jsonb_build_object('metadata',projected,
  'content_erased_at',coalesce(prior->>'content_erased_at',incoming->>'content_erased_at',clock_timestamp()::text));
 IF TG_TABLE_NAME='credit_transactions' THEN incoming:=incoming||'{"description":null}'::jsonb;
 ELSIF TG_TABLE_NAME='billing_history' THEN incoming:=incoming||'{"reason":null}'::jsonb;
 ELSIF TG_TABLE_NAME='ai_usage_logs' THEN
  incoming:=incoming||'{"error_message":null,"ip_address":null,"user_agent":null}'::jsonb;
 END IF;
 NEW:=jsonb_populate_record(NEW,incoming);
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_confirm(a uuid, k text, target uuid, expected_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 conversation results erasure

-- 0232 conversation name erasure

-- R9 erasure content

DECLARE scope jsonb; ids uuid[]; sessions uuid[]; projects uuid[]; versions uuid[]; contents uuid[];
 refs uuid[]; rounds uuid[]; chats uuid[]; research_ids uuid[]; research_plan_ids uuid[]; stamp timestamptz:=clock_timestamp(); row record; financial jsonb;
 remaining bigint:=0; deleted boolean;
BEGIN
 PERFORM bill2_actor(a);
 -- Runtime writers use session -> execution -> run. NOWAIT prevents inverse
 -- legacy/project lock orders from turning erasure into a cross-domain deadlock.
 PERFORM id FROM profiles WHERE id=a FOR SHARE NOWAIT;
 PERFORM bill2_actor(a);
 -- 0231 marked session locks
 IF k='session' AND EXISTS(SELECT 1 FROM runtime_sessions WHERE id=target AND actor_id=a AND content_deleted_at IS NOT NULL) THEN
  scope:=content_erasure_scope(a,k,target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
  rounds:=ARRAY(SELECT DISTINCT s0.id FROM runtime_sessions s0 WHERE s0.actor_id=a
   AND (s0.id=ANY(sessions) OR s0.id IN (SELECT e0.session_id FROM runtime_executions e0 WHERE e0.id=ANY(ids))) ORDER BY s0.id);
  PERFORM id FROM runtime_sessions WHERE id=ANY(rounds) ORDER BY id FOR UPDATE NOWAIT;
  -- Works these conversations feed (draft, topic workspace or captured field): capture locks the
  -- project before writing, so holding it here serializes capture with this cleanup.
  PERFORM id FROM artifact_projects WHERE actor_id=a AND (id IN (SELECT d0.project_id FROM opc_drafts d0 WHERE d0.session_id=ANY(rounds))
   OR id IN (SELECT d1.project_id FROM opc_topic_workspaces t1 JOIN opc_drafts d1 ON d1.draft_id=t1.draft_id WHERE t1.session_id=ANY(rounds))
   OR id IN (SELECT r0.project_id FROM artifact_rounds r0 JOIN artifact_projects p0 ON p0.id=r0.project_id
    WHERE p0.actor_id=a AND content_erasure_references(r0.steps,ids))) ORDER BY id FOR UPDATE NOWAIT;
  scope:=content_erasure_scope(a,k,target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
  IF NOT sessions<@rounds OR jsonb_array_length(scope->'projects')>0
   OR EXISTS(SELECT 1 FROM runtime_executions e0 WHERE e0.id=ANY(ids) AND NOT e0.session_id=ANY(rounds)) THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
  END IF;
 ELSE
  PERFORM id FROM runtime_sessions WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM artifact_projects WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
  scope:=content_erasure_scope(a,k,target);
 END IF;
 deleted:=(scope->>'alreadyDeleted')::boolean;
 -- 0227 erasure manifest
 PERFORM erasure_manifest_note(k,target,a,stamp);
 IF NOT deleted AND expected_hash IS DISTINCT FROM encode(sha256(convert_to(scope::text,'utf8')),'hex') THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_PREVIEW_CHANGED' USING ERRCODE='40001';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO projects FROM jsonb_array_elements_text(scope->'projects') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO versions FROM jsonb_array_elements_text(scope->'versions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO contents FROM jsonb_array_elements_text(scope->'contents') v;
 -- Existing UI writers lock their item/account before updating private settings.
 PERFORM work_item_id FROM opc_items WHERE work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM project_id FROM opc_accounts WHERE project_id=ANY(projects) ORDER BY project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM account_project_id FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects) ORDER BY account_project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 rounds:=ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 chats:=ARRAY(SELECT c.conversation_id FROM artifact_chats c JOIN conversations v ON v.id=c.conversation_id
  WHERE c.project_id=ANY(projects) AND v.user_id=a);
 PERFORM id FROM conversations WHERE id=ANY(chats) ORDER BY id FOR UPDATE NOWAIT;
 research_ids:=ARRAY(SELECT DISTINCT o.id FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  JOIN artifact_evidence e ON e.operation_id=o.id WHERE p.actor_id=a AND
   (e.project_id=ANY(projects) OR e.id IN (SELECT evidence_id FROM opc_result_links WHERE execution_id=ANY(ids))));
 -- 0263 runtime research: conversation searches have no artifact evidence.
 research_plan_ids:=ARRAY(SELECT p.id FROM research_plans p WHERE p.actor_id=a AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids)))));
 research_ids:=research_ids||ARRAY(SELECT o.id FROM research_operations o
  WHERE o.plan_id=ANY(research_plan_ids) AND NOT o.id=ANY(research_ids));
 research_plan_ids:=research_plan_ids||ARRAY(SELECT DISTINCT plan_id FROM research_operations WHERE id=ANY(research_ids));

 -- Research RPCs serialize on the plan. NOWAIT avoids their plan -> project lock inversion.
 PERFORM id FROM research_plans WHERE id=ANY(research_plan_ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM research_operations WHERE id=ANY(research_ids) ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM research_operations WHERE id=ANY(research_ids) AND erased_at IS NULL AND
   (NOT research_operation_settled(research_operations) OR (pre_deduct_id IS NOT NULL AND charged_credits IS NULL))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO refs FROM jsonb_array_elements_text(scope->'references') v;
 refs:=refs||ids||sessions||projects||versions||contents||rounds;
 PERFORM id FROM runtime_executions WHERE id=ANY(ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM bill2_runs WHERE id IN (SELECT billing_run_id FROM runtime_executions WHERE id=ANY(ids))
  ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM artifact_generations g WHERE g.state NOT IN ('succeeded','refunded')
  AND (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 -- Keep only source IDs in the existing dependency graph before clearing copies.
 -- Repeated deletion/financial cleanup must find the same original dependent runs.
 INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
 SELECT ex.id,src.id FROM runtime_executions ex JOIN runtime_executions src ON src.session_id=ex.session_id
 WHERE ex.id=ANY(ids) AND src.id=ANY(ids) AND ex.actor_id=a AND src.actor_id=a
  AND (src.created_at,src.id)<(ex.created_at,ex.id) AND content_erasure_capture_copy(ex.payload,src.result)
 ON CONFLICT DO NOTHING;
 -- Retain only binding identities for later cleanup/recovery after frozen material is gone.
 INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
 SELECT ex.id,src.id FROM opc_video_material_bindings b JOIN runtime_executions src
  ON src.actor_id=b.actor_id AND src.session_id=b.session_id AND src.request_id=b.request_id
 JOIN runtime_executions ex ON ex.actor_id=b.actor_id AND ex.session_id=b.session_id AND ex.id<>src.id
 WHERE b.actor_id=a AND src.id=ANY(ids) AND ex.id=ANY(ids)
  AND ex.payload#>>'{scopeMaterial,sessionId}'=b.session_id::text
  AND ex.payload#>>'{scopeMaterial,revision}'=b.material_revision::text
 ON CONFLICT DO NOTHING;
 -- 0295 report price
 PERFORM report_fee_settle_internal(held_fee.execution_id,false) FROM report_fees held_fee JOIN runtime_executions fe ON fe.id=held_fee.execution_id
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND (fe.id=ANY(ids) OR fe.session_id=ANY(sessions));
 PERFORM report_fee_settle_internal(held_fee.execution_id,true) FROM report_fees held_fee JOIN runtime_executions fe ON fe.id=held_fee.execution_id
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND (fe.id=ANY(ids) OR fe.session_id=ANY(sessions));
 UPDATE runtime_sessions SET content_deleted_at=stamp WHERE id=ANY(sessions) AND content_deleted_at IS NULL;
 UPDATE artifact_projects SET content_deleted_at=stamp WHERE id=ANY(projects) AND content_deleted_at IS NULL;
 UPDATE bill2_runs SET content_deleted_at=stamp WHERE actor_id=a AND content_deleted_at IS NULL
  AND id IN (SELECT billing_run_id FROM runtime_executions WHERE id=ANY(ids));
 -- Preserve original delivery/unknown facts before clearing the execution body.
 -- No adapter, redispatch, new request ID or fabricated provider failure exists here.
 FOR row IN SELECT id,billing_run_id FROM runtime_executions WHERE id=ANY(ids) ORDER BY id LOOP
  IF row.billing_run_id IS NOT NULL THEN
   financial:=runtime_financial_recovery(a,row.id,true);
   PERFORM account_erasure_scrub_calls(a,row.billing_run_id);
   PERFORM account_erasure_scrub_run(a,row.billing_run_id);
   financial:=account_erasure_scrub_receipts(a,row.billing_run_id,100);
   remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  END IF;
 END LOOP;
 -- 0290 fusion compares
 PERFORM fc.id FROM fusion_compares fc WHERE fc.actor_id=a AND (fc.session_id=ANY(sessions)
  OR fc.session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))
  OR content_erasure_references(fc.workspace_dependencies,refs)) ORDER BY fc.id FOR UPDATE NOWAIT;
 PERFORM r.id FROM bill2_runs r JOIN fusion_compares fc ON fc.group_id=r.fusion_group_id
  WHERE fc.actor_id=a AND content_erasure_references(fc.workspace_dependencies,refs) ORDER BY r.id FOR UPDATE OF r NOWAIT;
 FOR row IN SELECT r.id,r.closed FROM bill2_runs r JOIN fusion_compares fc ON fc.group_id=r.fusion_group_id
  WHERE fc.actor_id=a AND content_erasure_references(fc.workspace_dependencies,refs) ORDER BY r.id LOOP
  UPDATE bill2_runs SET content_deleted_at=stamp WHERE id=row.id AND content_deleted_at IS NULL;
  IF NOT row.closed THEN PERFORM bill2_cancel(a,row.id); END IF;
  PERFORM bill2_finalize(a,row.id);
  financial:=account_erasure_scrub_calls(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_run(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_receipts(a,row.id,100);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
 END LOOP;
 DELETE FROM fusion_call_outputs o USING fusion_compares fc
  WHERE o.group_id=fc.group_id AND fc.actor_id=a AND content_erasure_references(fc.workspace_dependencies,refs);
 DELETE FROM fusion_compares fc WHERE fc.actor_id=a AND (fc.session_id=ANY(sessions)
  OR fc.session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))
  OR content_erasure_references(fc.workspace_dependencies,refs));
 -- 0236 fusion reviews
 -- NOWAIT like the session/project/run locks: a claim holding a review row fails this fast (retryable
 -- CONTENT_ERASURE_BUSY) instead of a deadlock (#955 review).
 PERFORM fr.id FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions)) ORDER BY fr.id FOR UPDATE NOWAIT;
 DELETE FROM fusion_reviews fr WHERE fr.actor_id=a AND (fr.project_id=ANY(projects) OR fr.source_session_id=ANY(sessions)
  OR fr.source_version_id=ANY(versions));
 -- 0294 fee refund
 PERFORM fusion_review_fee_settle_internal(held_fee.review_id) FROM fusion_review_fees held_fee
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND NOT EXISTS(SELECT 1 FROM fusion_reviews WHERE id=held_fee.review_id);
 -- 0235 fusion outputs
 -- Like the session/project locks above, take the Fusion run locks up front with NOWAIT: a concurrent group
 -- claim holds a run and then the profile, so waiting here could deadlock; failing fast lets the caller
 -- (or the deletion sweep) retry once the claim committed (#947 review).
 PERFORM r.id FROM bill2_runs r JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
  WHERE g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects)))
  ORDER BY r.id FOR UPDATE OF r NOWAIT;
 FOR row IN SELECT r.id,r.closed FROM bill2_runs r JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
  WHERE g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects))) ORDER BY r.id LOOP
  UPDATE bill2_runs SET content_deleted_at=stamp WHERE id=row.id AND content_deleted_at IS NULL;
  IF NOT row.closed THEN PERFORM bill2_cancel(a,row.id); END IF;
  PERFORM bill2_finalize(a,row.id);
  -- Anything a scrub could not clear yet is counted (review_required), and the recovery cron
  -- scrubs a content-deleted run again once it settles (PR-3b).
  financial:=account_erasure_scrub_calls(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_run(a,row.id);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  financial:=account_erasure_scrub_receipts(a,row.id,100);
  remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
 END LOOP;
 DELETE FROM fusion_call_outputs o USING fusion_billing_groups g
  WHERE o.group_id=g.id AND g.actor_id=a AND (g.source_session_id=ANY(sessions)
   OR g.source_session_id IN (SELECT d.session_id FROM opc_drafts d WHERE d.actor_id=a AND d.project_id=ANY(projects)));
 UPDATE runtime_scope_material m SET request=NULL,content=NULL,content_hash=NULL,erased_at=stamp
  WHERE m.erased_at IS NULL AND EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=m.session_id AND s.actor_id=a)
   AND (m.session_id=ANY(refs) OR m.request_id=ANY(refs)
    OR EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=m.session_id AND content_erasure_references(rs.scope,refs))
    OR content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)
    OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.session_id=m.session_id AND b.material_revision=m.revision AND b.source_script_id=ANY(refs)));
 UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL;
 UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL;
 UPDATE runtime_session_history SET item=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL
  AND (session_id=ANY(sessions) OR item->>'role' IS DISTINCT FROM 'user');
 UPDATE runtime_history_dependencies SET erased_at=stamp WHERE erased_at IS NULL
  AND (execution_id=ANY(ids) OR dependency_id=ANY(ids));
 UPDATE runtime_executions SET payload=jsonb_build_object('input',payload->'input'),result=NULL,primary_result=NULL,match_result=NULL,
  unavailable_reason='content_deleted',content_deleted_at=stamp WHERE id=ANY(ids) AND content_deleted_at IS NULL AND erased_at IS NULL;
 -- Whole sessions also clear retained questions; an answer deletion retains them.
 UPDATE runtime_executions SET payload=NULL,result=NULL,primary_result=NULL,match_result=NULL,erased_at=stamp
  WHERE session_id=ANY(sessions) AND erased_at IS NULL AND state IN ('completed','cancelled');
 UPDATE runtime_executions SET payload=jsonb_build_object('input',NULL)
  WHERE session_id=ANY(sessions) AND erased_at IS NULL AND content_deleted_at IS NOT NULL;
 UPDATE bill2_drafts SET revoked=true WHERE actor_id=a AND id IN
  (SELECT (rs.scope->>'draftId')::uuid FROM runtime_sessions rs WHERE rs.id=ANY(sessions) AND rs.scope->>'kind' IN ('positioning_draft','positioning_topic'));
 DELETE FROM runtime_session_names WHERE session_id=ANY(sessions);
 UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL;
 UPDATE opc_content_versions SET body=NULL,title=NULL,erased_at=stamp WHERE id=ANY(contents) AND erased_at IS NULL;
 -- System capture fields and suggestions carry exact execution provenance. Preserve
 -- unrelated manual fields and independently saved published bodies.
 UPDATE artifact_rounds r SET steps=content_erasure_capture_steps(r.steps)
  WHERE r.erased_at IS NULL AND NOT r.id=ANY(rounds)
  AND EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=r.project_id AND p.actor_id=a)
  AND content_erasure_references(r.steps,ids)
  AND r.steps IS DISTINCT FROM content_erasure_capture_steps(r.steps);
 UPDATE artifact_generations g SET input=NULL,result=(SELECT jsonb_object_agg(key,value)
  FROM jsonb_each(coalesce(g.result,'{}')) WHERE key IN ('credits','inputTokens','outputTokens','costUsd')),erased_at=stamp
  WHERE g.erased_at IS NULL AND g.state IN ('succeeded','refunded') AND
   (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs));
 UPDATE agent_slice_executions SET preference_refs=NULL,discussion_refs=NULL,input_hash=NULL,erased_at=stamp
  WHERE erased_at IS NULL AND project_id=ANY(projects);
 UPDATE agent_slice_links SET source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND round_id=ANY(rounds);
 UPDATE opc_library_requests SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (request_id IN (SELECT request_id FROM opc_content_versions WHERE id=ANY(contents))
   OR result->>'id'=ANY(contents::text[]) OR content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_handoffs SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_topic_draft_versions SET request=NULL,body=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (source_version_id=ANY(versions) OR request_id=ANY(ids)
   OR content_erasure_references(request,refs) OR content_erasure_references(body,refs)
   OR request_id IN (SELECT event.request_id FROM opc_data_events event WHERE event.actor_id=a
    AND event.action='topic_draft' AND event.execution_id=ANY(ids)));
 DELETE FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(ids) OR project_id=ANY(projects)
  OR target_project_id=ANY(projects) OR source_version_id=ANY(versions));
 -- Frozen source bodies and request caches are system copies, not independent saved content.
 UPDATE opc_turns t SET input_hash=NULL,erased_at=stamp WHERE t.erased_at IS NULL AND
  (t.session_id=ANY(sessions) OR t.round_id=ANY(rounds) OR EXISTS(SELECT 1 FROM runtime_executions e
   WHERE e.id=ANY(ids) AND e.session_id=t.session_id AND e.request_id=t.request_id));
 UPDATE opc_topic_workspaces SET source_hash=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (session_id=ANY(sessions) OR source_version_id=ANY(versions));
 UPDATE opc_topic_openings SET input=NULL,erased_at=stamp WHERE erased_at IS NULL AND draft_id IN
  (SELECT draft_id FROM opc_drafts WHERE actor_id=a AND (session_id=ANY(sessions) OR project_id=ANY(projects)));
 UPDATE opc_plans SET request=NULL,body=NULL,erased_at=stamp WHERE erased_at IS NULL AND source_version_id=ANY(versions);
 -- Same private-setting removal as account erasure, restricted to the selected family.
 DELETE FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 DELETE FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects);
 DELETE FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 UPDATE opc_item_edits SET title=NULL,brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_items SET brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_accounts SET account_key='erased:'||project_id,erased_at=stamp WHERE erased_at IS NULL AND project_id=ANY(projects);
 -- Guided Skill chats belong to the selected artifact family. Clear snapshots
 -- before message bodies and retain content-free identity shells for accounting.
 UPDATE conversation_context_snapshots SET content=NULL,metadata=NULL,erased_at=stamp
  WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE messages SET content=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_chat_turns SET body=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET is_deleted='true',deleted_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET title=NULL,summary=NULL,summary_metadata=NULL,erased_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_versions SET report=NULL,report_hash=NULL,erased_at=stamp WHERE project_id=ANY(projects) AND erased_at IS NULL;
 UPDATE artifact_candidates SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_confirmations SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 -- Bound plans include approved operations that were never reserved; erasing them prevents late reserve.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.actor_id=a AND p.erased_at IS NULL AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids))));
 WITH removed AS (
  DELETE FROM research_discoveries d WHERE d.actor_id=a AND (d.session_id=ANY(sessions) OR d.execution_id=ANY(ids)
   OR d.keyword_confirmation_id IN (SELECT confirmation_id FROM research_selection_cards
    WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)))) RETURNING id
 ) DELETE FROM research_selection_cards WHERE actor_id=a AND
  (session_id=ANY(sessions) OR execution_id=ANY(ids) OR discovery_id IN (SELECT id FROM removed));
 -- Deleting only the answer of a later refresh keeps the earlier success of a remaining answer: the record goes back
 -- to that success (the refresh attempt is dropped and can never finish), so it is reused and never paid for again.
 UPDATE research_account_fetches SET state=CASE WHEN state='failed_charged' THEN state ELSE 'succeeded' END,execution_id=last_success_execution_id,evidence=last_success,
   attempt=gen_random_uuid(),refresh_id=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND execution_id=ANY(ids) AND last_success IS NOT NULL
   AND NOT coalesce(last_success_execution_id=ANY(ids),false) AND NOT coalesce(session_id=ANY(sessions),false);
 -- A sent charged/unknown result must not become payable again when only its answer is removed.
 -- Retain only the session-scoped digest and terminal state; revoke late completion tokens and all private payload.
 UPDATE research_account_fetches SET execution_id=NULL,account=NULL,evidence=NULL,last_success=NULL,
   last_success_execution_id=NULL,refresh_id=NULL,attempt=gen_random_uuid(),updated_at=stamp
 WHERE actor_id=a AND state IN ('failed_charged','unknown')
   AND (execution_id=ANY(ids) OR last_success_execution_id=ANY(ids)) AND NOT coalesce(session_id=ANY(sessions),false);
 DELETE FROM research_account_fetches WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR last_success_execution_id=ANY(ids));
 DELETE FROM research_refresh_grants WHERE actor_id=a AND (session_id=ANY(sessions)
   OR used_execution_id=ANY(ids) OR source_execution_id=ANY(ids));
 DELETE FROM research_discoveries WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 -- 0338 session results: a saved result goes with its conversation; erasing only its source reply keeps it (shown as source unavailable).
 DELETE FROM runtime_session_results WHERE actor_id=a AND session_id=ANY(sessions);
 -- 0320 shortfall: the choice card goes with its answer or conversation.
 DELETE FROM research_benchmark_shortfalls WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 -- 0268 benchmarks: derived numbers go with their answer, conversation or evidence.
 DELETE FROM research_benchmarks WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR operation_ids && research_ids);
 -- Same terminal-result cost projection as account erasure; original amounts and charge IDs stay intact.
 UPDATE research_operations o SET erased_at=stamp,
  result=(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(
   CASE WHEN jsonb_typeof(o.result)='object' THEN o.result ELSE '{}'::jsonb END) e WHERE e.key='cost')
 WHERE o.id=ANY(research_ids) AND o.erased_at IS NULL;
 -- Plans contain approved operation IDs/hashes/quote ceilings, never query text. Preserve
 -- mixed plans for unrelated operations; clear only when every approved operation is erased.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.id=ANY(research_plan_ids)
  AND p.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.operations) item
   WHERE NOT EXISTS(SELECT 1 FROM research_operations o WHERE o.plan_id=p.id
    AND o.id::text=item->>'operationId' AND o.erased_at IS NOT NULL));
 UPDATE artifact_evidence SET payload=NULL,content_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR id IN (SELECT evidence_id FROM opc_result_links WHERE execution_id=ANY(ids)));
 UPDATE artifact_requests SET payload=(SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(payload,'{}'))
  WHERE key IN ('sliceExecution','slicePhase')),response=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=artifact_requests.project_id AND p.actor_id=a)
  AND (project_id=ANY(projects) OR content_erasure_references(payload,refs) OR content_erasure_references(response,refs));
 UPDATE artifact_rounds SET steps=NULL,erased_at=stamp WHERE id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_work_references SET creation_payload=NULL,source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR source_version_id=ANY(versions));
 UPDATE artifact_projects SET work_title=NULL,account='erased:'||id,erased_at=stamp WHERE id=ANY(projects) AND erased_at IS NULL;
 FOR row IN SELECT * FROM (VALUES
  ('token_stats','metadata=erasure_ledger_metadata(metadata),content_erased_at=$2'),
  ('billing_history','reason=NULL,metadata=erasure_ledger_metadata(metadata),content_erased_at=$2'),
  ('credit_transactions','description=NULL,metadata=erasure_ledger_metadata(metadata),content_erased_at=$2'),
  ('ai_usage_logs','error_message=NULL,ip_address=NULL,user_agent=NULL,metadata=erasure_ledger_metadata(metadata),content_erased_at=$2')
 ) x(tbl,assignment) LOOP
  EXECUTE format('UPDATE public.%I t SET %s WHERE t.user_id=$1 AND t.content_erased_at IS NULL AND content_erasure_ledger_owned(to_jsonb(t))',
   row.tbl,row.assignment) USING a,stamp;
 END LOOP;
 -- This status is about content. Unknown money remains on its original run.
 RETURN jsonb_build_object('kind',k,'id',target,'status',CASE WHEN remaining>0 THEN 'review_required' ELSE 'deleted' END,
  'alreadyDeleted',deleted,'preservedSavedVersions',scope->'preservedSavedVersions','financialReviewCount',remaining);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;

