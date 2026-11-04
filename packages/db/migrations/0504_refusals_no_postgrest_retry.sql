-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Refusals answered, not re-run (follow-up of #1725 / docs/validation/PAY_COMMON_CHANNEL_CONFLICT.md, migration 0175).
-- These seven functions refused out-of-date input (a preview, version, hash, level or job state that changed meanwhile) with
-- SQLSTATE 40001 (serialization failure). PostgREST re-runs a whole call that fails with 40001 instead of answering it, so the
-- refusal never came back: the request hung while the database re-ran the call in a loop (one connection and CPU held, the erasure
-- one re-taking its row locks on every run), and a re-run that came after the data had gone back to the old state went through and
-- wrote the stale input (an old price table or plan over a newer one, an erasure the user saw fail). Such a refusal can never clear
-- by a re-run, so it now uses PT409, which PostgREST answers at once with HTTP 409.
-- Kept on 40001 on purpose (a re-run reads the state again and goes through): turn_call_begin TURN_HOLD_RETRY and the three
-- pay_dispute_* PAY_DISPUTE_MAPPING_RETRY (lock order changed; the next run takes the right locks).
-- Compatibility: same signatures, inputs, outputs, locks and writes; only the refusals' SQLSTATE differs. Every caller matches the
-- error message (content erasure, session results, provider prices, publish jobs) or does not tell the codes apart (catalog), so old
-- and new API code both work with it. CREATE OR REPLACE keeps each function's owner and grants.
-- Repeatable: CREATE OR REPLACE only. Recovery: re-apply the functions as packages/db/functions held them before this migration
-- (forward fix; that would bring the hang back, so only for a broken definition).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.content_erasure_confirm(a uuid, k text, target uuid, expected_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 conversation results erasure

-- 0232 conversation name erasure

-- R9 erasure content

DECLARE scope jsonb; turn_ids bigint[]; ids uuid[]; sessions uuid[]; projects uuid[]; versions uuid[]; contents uuid[];
 refs uuid[]; rounds uuid[]; chats uuid[]; research_ids uuid[]; research_plan_ids uuid[]; stamp timestamptz:=clock_timestamp(); row record; financial jsonb;
 remaining bigint:=0; deleted boolean; deleted_runs text[]; deleted_pre text[]; linked uuid[];
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
  RAISE EXCEPTION 'CONTENT_ERASURE_PREVIEW_CHANGED' USING ERRCODE='PT409';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO projects FROM jsonb_array_elements_text(scope->'projects') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO versions FROM jsonb_array_elements_text(scope->'versions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO contents FROM jsonb_array_elements_text(scope->'contents') v;
 SELECT coalesce(array_agg(v::bigint),'{}') INTO turn_ids FROM jsonb_array_elements_text(scope->'turns') v;
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
 -- CORE-PATH-V2 V2-7a2: evidence linked to these runs, or to a turn of these conversations.
 linked:=ARRAY(SELECT evidence_id FROM opc_result_links WHERE execution_id=ANY(ids))
  ||ARRAY(SELECT l.evidence_id FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id WHERE t.actor_id=a AND t.session_id=ANY(sessions));
 research_ids:=ARRAY(SELECT DISTINCT o.id FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  JOIN artifact_evidence e ON e.operation_id=o.id WHERE p.actor_id=a AND
   (e.project_id=ANY(projects) OR e.id=ANY(linked)));
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
 -- CORE-PATH-V2 V2-7a2: a report turn's request id is its executionId in the edit and publish requests, which hold the edited text.
 refs:=refs||ARRAY(SELECT request_id FROM turns WHERE actor_id=a AND session_id=ANY(sessions) AND kind='report');
 -- CORE-PATH-V2 V2-10b: a topic turn's request id is its executionId in the topic drafts and the adoption requests.
 refs:=refs||ARRAY(SELECT t.request_id FROM turns t JOIN opc_topic_workspaces w ON w.session_id=t.session_id AND w.actor_id=a
  WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND t.kind='chat');
 PERFORM id FROM runtime_executions WHERE id=ANY(ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM bill2_runs WHERE id IN (SELECT billing_run_id FROM runtime_executions WHERE id=ANY(ids))
  ORDER BY id FOR UPDATE NOWAIT;
 -- CORE-PATH-V2 turns: after the account row and their sessions, the order turn_close takes them. A receipt holding one either committed its
 -- response body before this (removed below) or runs after and sees the tombstone (turn_call_record stores no body then).
 PERFORM 1 FROM turns WHERE actor_id=a AND session_id=ANY(sessions) ORDER BY id FOR UPDATE NOWAIT;
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
 -- V2-12 R2: an old report fee still held is no longer settled from here; it is counted and the delete reports review_required.
 remaining:=remaining+(SELECT count(*) FROM report_fees held_fee JOIN runtime_executions fe ON fe.id=held_fee.execution_id
  WHERE held_fee.actor_id=a AND held_fee.state='held' AND (fe.id=ANY(ids) OR fe.session_id=ANY(sessions)));
 UPDATE runtime_sessions SET content_deleted_at=stamp WHERE id=ANY(sessions) AND content_deleted_at IS NULL;
 UPDATE artifact_projects SET content_deleted_at=stamp WHERE id=ANY(projects) AND content_deleted_at IS NULL;
 UPDATE bill2_runs SET content_deleted_at=stamp WHERE actor_id=a AND content_deleted_at IS NULL
  AND id IN (SELECT billing_run_id FROM runtime_executions WHERE id=ANY(ids));
 -- Preserve original delivery/unknown facts before clearing the execution body.
 -- No adapter, redispatch, new request ID or fabricated provider failure exists here.
 FOR row IN SELECT id,billing_run_id FROM runtime_executions WHERE id=ANY(ids) ORDER BY id LOOP
  IF row.billing_run_id IS NOT NULL THEN
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
 -- A session with a turn still open keeps its (tombstoned, content-free) shell until that turn closes: an erased row is
 -- immutable and the closing turn releases active_turn_id on it. The sweep erases it on a later pass.
 UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL
  AND active_turn_id IS NULL;
 -- CORE-PATH-V2 conversation content: the provider response bodies of its turns and its message text. The turns and their
 -- receipts are billing records and keep their billing fields (plan 4.6).
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND r.turn_id=t.id;
 UPDATE session_messages SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(deleted_at,stamp)
  WHERE session_id=ANY(sessions) AND (content<>'' OR visible);
 -- The turns behind deleted content (content_erasure_scope), in conversations that stay. One still running would write its receipt and
 -- reply after this cleanup, and the conversation has no tombstone to stop it: the delete waits for it (retryable).
 IF EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND t.state<>'closed' AND NOT t.session_id=ANY(sessions)) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND r.turn_id=t.id;
 UPDATE session_messages m SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(m.deleted_at,stamp)
  FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids) AND m.session_id=t.session_id AND m.turn_id=t.id AND (m.content<>'' OR m.visible);
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
  AND (source_version_id=ANY(versions) OR request_id=ANY(refs)
   OR content_erasure_references(request,refs) OR content_erasure_references(body,refs)
   OR request_id IN (SELECT event.request_id FROM opc_data_events event WHERE event.actor_id=a
    AND event.action='topic_draft' AND (event.execution_id=ANY(ids)
     OR event.turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions)))));
 DELETE FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(ids) OR project_id=ANY(projects)
  OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
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
  (project_id=ANY(projects) OR id=ANY(linked));
 UPDATE artifact_requests SET payload=(SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(payload,'{}'))
  WHERE key IN ('sliceExecution','slicePhase')),response=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=artifact_requests.project_id AND p.actor_id=a)
  AND (project_id=ANY(projects) OR content_erasure_references(payload,refs) OR content_erasure_references(response,refs));
 UPDATE artifact_rounds SET steps=NULL,erased_at=stamp WHERE id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_work_references SET creation_payload=NULL,source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR source_version_id=ANY(versions));
 UPDATE artifact_projects SET work_title=NULL,account='erased:'||id,erased_at=stamp WHERE id=ANY(projects) AND erased_at IS NULL;
 -- content_erasure_ledger_owned is true only for a row naming one of this account's content-deleted runs. Collect those
 -- runs once and test each row's five identities against them with plain comparisons first, so the function (and the guard
 -- trigger it feeds) only runs for rows that can be owned; ownership is still decided by content_erasure_ledger_owned.
 deleted_runs:=ARRAY(SELECT r.id::text FROM bill2_runs r WHERE r.actor_id=a AND r.content_deleted_at IS NOT NULL);
 deleted_pre:=ARRAY(SELECT r.pre_deduct_id::text FROM bill2_runs r WHERE r.actor_id=a AND r.content_deleted_at IS NOT NULL
   AND r.pre_deduct_id IS NOT NULL);
 FOR row IN SELECT * FROM (VALUES
  ('token_stats','content_erased_at=$2'),
  ('billing_history','reason=NULL,content_erased_at=$2'),
  ('credit_transactions','description=NULL,content_erased_at=$2'),
  ('ai_usage_logs','error_message=NULL,ip_address=NULL,user_agent=NULL,content_erased_at=$2')
 ) x(tbl,assignment) LOOP
  EXECUTE format('WITH cand AS MATERIALIZED (SELECT t.ctid c FROM public.%1$I t CROSS JOIN LATERAL (SELECT to_jsonb(t) j) x
    WHERE t.user_id=$1 AND t.content_erased_at IS NULL
     AND ((x.j->>''bill2_run_id'')=ANY($3) OR (x.j#>>''{metadata,usage,runId}'')=ANY($3) OR (x.j#>>''{metadata,runId}'')=ANY($3)
      OR (x.j->>''id'')=ANY($4) OR (x.j#>>''{metadata,preDeductId}'')=ANY($4))
     AND content_erasure_ledger_owned(x.j))
   UPDATE public.%1$I t SET %2$s FROM cand WHERE t.ctid=cand.c',
   row.tbl,row.assignment) USING a,stamp,deleted_runs,deleted_pre;
 END LOOP;
 -- This status is about content. Unknown money remains on its original run.
 RETURN jsonb_build_object('kind',k,'id',target,'status',CASE WHEN remaining>0 THEN 'review_required' ELSE 'deleted' END,
  'alreadyDeleted',deleted,'preservedSavedVersions',scope->'preservedSavedVersions','financialReviewCount',remaining);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;

CREATE OR REPLACE FUNCTION public.runtime_session_result_edit(p_actor_id uuid, p_family_id uuid, p_request_id uuid, p_expected_version integer, p_title text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;latest runtime_session_results;r runtime_session_results;clean text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 -- Replays of one request queue, then edits and deletion of one result queue (the delete takes the same family lock):
 -- an edit never inserts a version after the family was deleted, and a delete always sees every committed version.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,337));
 PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text,338));
 SELECT * INTO latest FROM runtime_session_results WHERE family_id=p_family_id AND actor_id=p_actor_id ORDER BY version DESC LIMIT 1;
 IF latest.id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_NOT_FOUND' USING ERRCODE='42501';END IF;
 s:=runtime_session_results_session(p_actor_id,latest.session_id);
 -- Re-read under the session lock: a concurrent edit or delete has committed or is ordered after us.
 SELECT * INTO latest FROM runtime_session_results WHERE family_id=p_family_id AND actor_id=p_actor_id ORDER BY version DESC LIMIT 1;
 IF latest.id IS NULL THEN RAISE EXCEPTION 'SESSION_RESULT_NOT_FOUND' USING ERRCODE='42501';END IF;
 IF p_body IS NULL OR btrim(p_body)='' OR char_length(p_body)>20000 THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 clean:=runtime_session_result_title(p_title,p_body);
 IF char_length(clean)>80 OR clean ~ '[[:cntrl:]]' THEN RAISE EXCEPTION 'SESSION_RESULT_INVALID' USING ERRCODE='22023';END IF;
 SELECT * INTO r FROM runtime_session_results WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN
  IF r.family_id<>p_family_id OR r.version<>p_expected_version+1 OR r.body<>p_body OR r.title<>clean THEN
   RAISE EXCEPTION 'SESSION_RESULT_REQUEST_CONFLICT' USING ERRCODE='23505';END IF;
 ELSE
  IF latest.version<>p_expected_version THEN RAISE EXCEPTION 'SESSION_RESULT_VERSION_CONFLICT' USING ERRCODE='PT409';END IF;
  IF latest.version>=50 THEN RAISE EXCEPTION 'SESSION_RESULT_LIMIT' USING ERRCODE='54000';END IF;
  INSERT INTO runtime_session_results(id,actor_id,session_id,family_id,version,result_type,title,body,source_execution_id,
   source_result_id,request_id)
   VALUES(gen_random_uuid(),p_actor_id,s.id,p_family_id,latest.version+1,latest.result_type,clean,p_body,NULL,latest.id,p_request_id)
   RETURNING * INTO r;
 END IF;
 RETURN runtime_session_result_view(r,(SELECT count(*)::integer FROM runtime_session_results WHERE family_id=r.family_id));
END $function$;

CREATE OR REPLACE FUNCTION public.billing_provider_prices_swap(p_expected_hash text, p_value text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE current_value jsonb; current_hash text; present boolean;
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value::jsonb) IS DISTINCT FROM 'object'
   OR (p_expected_hash IS NOT NULL AND p_expected_hash !~ '^[0-9a-f]{64}$') THEN
    RAISE EXCEPTION 'BILLING_UNIT_PROVIDER_PRICES_INVALID' USING ERRCODE='22023';
  END IF;
  -- The row may not exist yet (first save): the advisory lock serializes that case too.
  PERFORM pg_advisory_xact_lock(hashtext('billing_provider_prices'));
  SELECT value INTO current_value FROM system_settings WHERE key='billing_provider_prices' FOR UPDATE;
  present:=FOUND;
  -- A row whose value is SQL NULL is a broken row, not a missing one: the client hashes it as the text "null".
  current_hash:=CASE WHEN NOT present THEN NULL
    WHEN current_value IS NULL THEN encode(sha256(convert_to('null','UTF8')),'hex')
    WHEN jsonb_typeof(current_value)='string' THEN encode(sha256(convert_to(current_value #>> '{}','UTF8')),'hex')
    ELSE encode(sha256(convert_to(current_value::text,'UTF8')),'hex') END;
  IF current_hash IS DISTINCT FROM p_expected_hash THEN
    RAISE EXCEPTION 'BILLING_UNIT_PROVIDER_PRICES_CONFLICT' USING ERRCODE='PT409';
  END IF;
  INSERT INTO system_settings(key,value) VALUES('billing_provider_prices',to_jsonb(p_value))
  ON CONFLICT (key) DO UPDATE SET value=excluded.value;
  RETURN encode(sha256(convert_to(p_value,'UTF8')),'hex');
END $function$;

CREATE OR REPLACE FUNCTION public.pay_common_save_catalog(p_kind text, p_id uuid, p_values jsonb, p_prices jsonb, p_merchant_namespace text, p_payment_mode text, p_expected_level text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE table_name text; allowed text[]; cols text; values_sql text; saved jsonb; current_row jsonb;
  cycle text; price jsonb; expected_cents integer; target uuid:=coalesce(p_id,gen_random_uuid()); old_ref public.payment_provider_refs;
BEGIN
  IF p_kind='credit_package' THEN
    table_name:='credit_packages';
    allowed:=ARRAY['name','price','credits_amount','bonus_credits','sort_order','is_popular','active'];
  ELSIF p_kind='membership_plan' THEN
    table_name:='membership_plans';
    allowed:=ARRAY['name','level','monthly_price','yearly_price','monthly_credits','yearly_credits','monthly_bonus_credits',
      'package_discount','features','max_context_messages','allow_export','allow_batch_export','is_active','sort_order',
      'allow_fusion_review','allow_fusion_compare','library_storage_bytes','allow_publish','own_data_window_days','allow_benchmark_monitor','allow_weekly_auto_review'];
  ELSE RAISE EXCEPTION 'PAY_COMMON_PRODUCT_UNAVAILABLE'; END IF;
  IF jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR p_values-allowed<>'{}'::jsonb OR p_id IS NULL AND p_values='{}'::jsonb
    OR jsonb_typeof(p_prices) IS DISTINCT FROM 'object'
    OR p_prices-(CASE WHEN p_kind='credit_package' THEN ARRAY['one_time'] ELSE ARRAY['monthly','yearly'] END)<>'{}'::jsonb THEN
    RAISE EXCEPTION 'PAY_COMMON_CATALOG_INPUT_INVALID' USING ERRCODE='23514';
  END IF;
  IF p_prices<>'{}'::jsonb AND (p_merchant_namespace IS NULL OR p_merchant_namespace !~ '^[A-Za-z0-9_-]{1,64}$'
    OR p_payment_mode IS NULL OR p_payment_mode NOT IN ('test','live')) THEN
    RAISE EXCEPTION 'PAY_COMMON_PROVIDER_SCOPE_UNKNOWN';
  END IF;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1 FOR UPDATE',table_name) INTO current_row USING target;
  IF p_id IS NOT NULL AND current_row IS NULL THEN RAISE EXCEPTION 'PAY_COMMON_PRODUCT_UNAVAILABLE'; END IF;
  IF p_expected_level IS NOT NULL AND current_row->>'level' IS DISTINCT FROM p_expected_level THEN
    RAISE EXCEPTION 'PAY_COMMON_CATALOG_CONFLICT' USING ERRCODE='PT409';
  END IF;
  -- A catalog amount cannot leave the old current Stripe price buyable. Require an
  -- explicitly supplied, validated price (or explicit removal) for each changed cycle.

  IF p_kind='credit_package' AND current_row IS NOT NULL AND p_values ? 'price'
    AND p_values->'price' IS DISTINCT FROM current_row->'price'
    AND EXISTS(SELECT 1 FROM payment_provider_refs WHERE credit_package_id=target
      AND object_type='price' AND is_current AND package_tier IN ('pro','gold')) THEN
    RAISE EXCEPTION 'PAY_WAFFO_TIER_PRICE_UPDATE_REQUIRED' USING ERRCODE='23514';
  END IF;
  IF current_row IS NOT NULL THEN
    FOREACH cycle IN ARRAY CASE WHEN p_kind='credit_package' THEN ARRAY['one_time'] ELSE ARRAY['monthly','yearly'] END LOOP
      IF p_values ? (CASE cycle WHEN 'monthly' THEN 'monthly_price' WHEN 'yearly' THEN 'yearly_price' ELSE 'price' END)
        AND (p_values->(CASE cycle WHEN 'monthly' THEN 'monthly_price' WHEN 'yearly' THEN 'yearly_price' ELSE 'price' END))
          IS DISTINCT FROM (current_row->(CASE cycle WHEN 'monthly' THEN 'monthly_price' WHEN 'yearly' THEN 'yearly_price' ELSE 'price' END))
        AND NOT (p_prices ? cycle) THEN
        RAISE EXCEPTION 'PAY_COMMON_PRICE_REPLACEMENT_REQUIRED' USING ERRCODE='23514';
      END IF;
    END LOOP;
  END IF;
  SELECT string_agg(quote_ident(k),',' ORDER BY k),string_agg('v.'||quote_ident(k),',' ORDER BY k)
    INTO cols,values_sql FROM jsonb_object_keys(p_values) k;
  IF p_id IS NULL THEN
    EXECUTE format('INSERT INTO public.%I(id,%s) SELECT $1,%s FROM jsonb_populate_record(NULL::public.%I,$2) v RETURNING to_jsonb(%I.*)',
      table_name,cols,values_sql,table_name,table_name) INTO saved USING target,p_values;
  ELSE
    IF p_values='{}'::jsonb THEN saved:=current_row; ELSE
    EXECUTE format('UPDATE public.%I t SET (%s)=(SELECT %s FROM jsonb_populate_record(NULL::public.%I,$2) v) WHERE id=$1 RETURNING to_jsonb(t.*)',
      table_name,cols,values_sql,table_name) INTO saved USING target,p_values;
    END IF;
  END IF;
  FOR cycle,price IN SELECT key,value FROM jsonb_each(p_prices) LOOP
    IF price<>'null'::jsonb THEN
      expected_cents:=(saved->>CASE cycle WHEN 'monthly' THEN 'monthly_price' WHEN 'yearly' THEN 'yearly_price' ELSE 'price' END)::integer;
      IF price->>'external_id' IS NULL OR price->>'external_id' !~ '^price_[A-Za-z0-9_]+$'
        OR price->>'unit_amount' IS DISTINCT FROM expected_cents::text OR expected_cents<=0
        OR price->>'currency' IS DISTINCT FROM 'usd' OR price->>'mode' IS DISTINCT FROM p_payment_mode
        OR price->>'billing_cycle' IS DISTINCT FROM cycle THEN RAISE EXCEPTION 'PAY_COMMON_PRICE_MISMATCH' USING ERRCODE='23514'; END IF;
      SELECT * INTO old_ref FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=p_merchant_namespace
        AND mode=p_payment_mode AND object_type='price' AND external_id=price->>'external_id';
      IF FOUND AND (old_ref.package_tier<>'legacy' OR old_ref.offer_kind<>'standard' OR old_ref.mode<>p_payment_mode OR old_ref.billing_cycle<>cycle
        OR (CASE p_kind WHEN 'credit_package' THEN old_ref.credit_package_id IS DISTINCT FROM target
          ELSE old_ref.membership_plan_id IS DISTINCT FROM target END)) THEN
        RAISE EXCEPTION 'PAY_COMMON_PRICE_MAPPING_CONFLICT' USING ERRCODE='23514';
      END IF;
    END IF;
    UPDATE payment_provider_refs SET is_current=false WHERE package_tier='legacy' AND price_usage IN ('subscription','package') AND channel='stripe' AND merchant_namespace=p_merchant_namespace
      AND mode=p_payment_mode AND object_type='price' AND offer_kind='standard' AND billing_cycle=cycle
      AND CASE p_kind WHEN 'credit_package' THEN credit_package_id=target ELSE membership_plan_id=target END;
    IF price<>'null'::jsonb THEN
      INSERT INTO payment_provider_refs(channel,merchant_namespace,mode,object_type,external_id,billing_cycle,
        credit_package_id,membership_plan_id,is_current)
      VALUES('stripe',p_merchant_namespace,p_payment_mode,'price',price->>'external_id',cycle,
        CASE WHEN p_kind='credit_package' THEN target END,CASE WHEN p_kind='membership_plan' THEN target END,true)
      ON CONFLICT(channel,merchant_namespace,mode,object_type,external_id) DO UPDATE SET is_current=true;
      IF NOT EXISTS(SELECT 1 FROM payment_provider_refs WHERE channel='stripe' AND merchant_namespace=p_merchant_namespace
        AND mode=p_payment_mode AND object_type='price' AND external_id=price->>'external_id' AND billing_cycle=cycle
        AND CASE p_kind WHEN 'credit_package' THEN credit_package_id=target ELSE membership_plan_id=target END) THEN
        RAISE EXCEPTION 'PAY_COMMON_PRICE_MAPPING_CONFLICT' USING ERRCODE='23514';
      END IF;
    END IF;
    EXECUTE format('UPDATE public.%I SET %I=$2 WHERE id=$1',table_name,
      CASE cycle WHEN 'monthly' THEN 'stripe_monthly_price_id' WHEN 'yearly' THEN 'stripe_yearly_price_id' ELSE 'stripe_price_id' END)
      USING target,CASE WHEN price<>'null'::jsonb THEN price->>'external_id' END;
  END LOOP;
  EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE id=$1',table_name) INTO saved USING target;
  RETURN saved;
END $function$;

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_release(p_job uuid, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE j social_publish_jobs;
BEGIN
 IF coalesce(p_code,'') !~ '^[A-Z0-9_]{1,64}$' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.state IN ('released','failed') THEN RETURN publish_monitor_publish_view(j); END IF;
 IF j.state NOT IN ('claimed','dispatching') OR j.provider_post_id IS NOT NULL OR j.results<>'{}'::jsonb THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_STATE_CONFLICT' USING ERRCODE='PT409';
 END IF;
 j:=publish_monitor_publish_close(j,0,CASE WHEN j.state='claimed' THEN 'released' ELSE 'failed' END,p_code);
 RETURN publish_monitor_publish_view(j);
END $function$;

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_record(p_job uuid, p_provider_post_id text, p_results jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE j social_publish_jobs;merged jsonb;k text;r jsonb;old jsonb;pending integer;successes integer;
BEGIN
 IF jsonb_typeof(p_results) IS DISTINCT FROM 'object'
  OR (p_provider_post_id IS NOT NULL AND p_provider_post_id !~ '^[A-Za-z0-9_-]{1,128}$') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
 END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.state IN ('claimed','released') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_STATE_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF p_provider_post_id IS NOT NULL AND j.provider_post_id IS NOT NULL AND j.provider_post_id<>p_provider_post_id THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='PT409';
 END IF;
 merged:=j.results;
 FOR k,r IN SELECT * FROM jsonb_each(p_results) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(j.targets) t WHERE t->>'connectionId'=k)
   OR jsonb_typeof(r) IS DISTINCT FROM 'object' OR r-ARRAY['status','url']<>'{}'::jsonb
   OR coalesce(r->>'status','') NOT IN ('published','failed')
   OR (r ? 'url' AND (jsonb_typeof(r->'url') IS DISTINCT FROM 'string' OR char_length(r->>'url') NOT BETWEEN 1 AND 2048
    OR r->>'url' !~ '^https://')) THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023';
  END IF;
  old:=merged->k;
  IF old IS NOT NULL AND old->>'status'<>r->>'status' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='PT409'; END IF;
  IF old IS NULL THEN merged:=merged||jsonb_build_object(k,r); END IF;
 END LOOP;
 IF j.state IN ('completed','failed') THEN
  IF merged<>j.results THEN RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='PT409'; END IF;
  RETURN publish_monitor_publish_view(j);
 END IF;
 UPDATE social_publish_jobs SET results=merged,provider_post_id=coalesce(provider_post_id,p_provider_post_id),
  updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 SELECT count(*) FILTER (WHERE j.results->(t->>'connectionId') IS NULL),
  count(*) FILTER (WHERE j.results->(t->>'connectionId')->>'status'='published')
 INTO pending,successes FROM jsonb_array_elements(j.targets) t;
 IF pending=0 THEN
  j:=publish_monitor_publish_close(j,successes,CASE WHEN successes>0 THEN 'completed' ELSE 'failed' END,NULL);
 ELSIF j.state='dispatching' THEN
  UPDATE social_publish_jobs SET state='unknown',next_check_at=clock_timestamp()+interval '2 minutes',
   updated_at=clock_timestamp() WHERE id=j.id RETURNING * INTO j;
 END IF;
 RETURN publish_monitor_publish_view(j);
END $function$;

CREATE OR REPLACE FUNCTION public.publish_monitor_publish_manual_resolve(p_admin uuid, p_job uuid, p_not_sent boolean, p_results jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE j social_publish_jobs;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_admin AND role='admin' AND status='active' AND is_deleted::text='false') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_ADMIN_REQUIRED' USING ERRCODE='42501';
 END IF;
 j:=publish_monitor_publish_lock(p_job);
 IF j.state NOT IN ('dispatching','unknown') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_STATE_CONFLICT' USING ERRCODE='PT409'; END IF;
 IF p_not_sent THEN
  IF j.results<>'{}'::jsonb THEN RAISE EXCEPTION 'PUBLISH_MONITOR_RESULT_CONFLICT' USING ERRCODE='PT409'; END IF;
  j:=publish_monitor_publish_close(j,0,'failed','PUBLISH_MONITOR_MANUAL_NOT_SENT');
 ELSE
  PERFORM publish_monitor_publish_record(p_job,NULL,p_results);
  SELECT * INTO j FROM social_publish_jobs WHERE id=p_job;
  IF j.id IS NULL THEN RETURN '{"state":"settled"}'::jsonb; END IF;
 END IF;
 INSERT INTO user_activity_logs(admin_id,action,action_type,details)
 VALUES(p_admin,'publish_monitor_manual_resolve','admin',jsonb_build_object('jobId',p_job,'notSent',p_not_sent));
 RETURN publish_monitor_publish_view(j);
END $function$;

COMMIT;
