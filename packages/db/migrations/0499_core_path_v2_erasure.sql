-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-9 (number placeholder; the controller assigns it before staging): conversation deletion and account erasure
-- on the core-path tables of 0420/0421 (docs/launch/tasks/CORE-PATH-V2.md sections 2.6, 4.6 and 6.1 row V2-9).
--   Conversation deletion stays a tombstone (runtime_sessions.content_deleted_at, read by turn_open and every call write):
--   content_erasure_mark_session also takes the conversation's messages out of the visible history in the same transaction
--   (one indexed update under the session lock), and content_erasure_confirm - run inline for a bound conversation or by
--   content_erasure_sweep_sessions in the background - deletes the response bodies of its turns and empties its message text.
--   Turns and receipts are billing records and keep their billing fields (three years, plan 4.6).
--   Account erasure: account_erasure_body_remaining counts the message text and response bodies account_erasure_scrub_turns
--   (0420) has not cleared yet, so the erasure proof cannot complete while any is left; account_erasure_scrub_runtime, like
--   content_erasure_confirm, leaves a session with a turn still open un-erased until the turn closes (an erased session row is
--   immutable, and turn_close releases active_turn_id on it; erasing it first left that turn unable to close).
--   Voice source revocation: voice_delete_versions hides the replies written with a deleted version (turns.policy
--   voiceVersionId), serialized with a closing turn on the account and turn rows; turn_tombstones (0421) already stops a running turn.
--   content_erasure_turn_check is the core-path replacement of content_erasure_runtime_check (a turn instead of an
--   execution); the old check stays for the old path until V2-12 drops it.
-- Each changed function is the full current text of packages/db/functions/ with the added lines; nothing is patched in place.
-- Lock order: account row -> session -> turn everywhere (as turn_open and turn_close of 0421); content_erasure_confirm takes
-- them NOWAIT and reports busy, content_erasure_mark_session waits up to 2 seconds, voice_delete_versions waits on the turn.
-- Compatibility: the old Runtime path never writes the new tables, so the added statements touch no row for it; Node needs
--   no change. Repeatable: CREATE OR REPLACE and IF NOT EXISTS. Recovery: re-apply the previous texts from git history
--   (packages/db/functions at the parent commit) and drop content_erasure_turn_check and turns_voice_version.
BEGIN;
SET LOCAL lock_timeout='5s';

-- Finds the turns written with a voice version when it is deleted.
CREATE INDEX IF NOT EXISTS turns_voice_version ON public.turns (actor_id, (policy->>'voiceVersionId'))
  WHERE policy ? 'voiceVersionId';

-- content_erasure_mark_session(uuid,uuid)
CREATE OR REPLACE FUNCTION public.content_erasure_mark_session(a uuid, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; deleted boolean; scope jsonb; ids uuid[]; refs uuid[]; local boolean; stamp timestamptz; unbound boolean;
BEGIN
 PERFORM bill2_actor(a);
 -- Same order as content_erasure_confirm (profile, then session). A short wait instead of
 -- NOWAIT lets a reply commit that holds this session for a moment finish first.
 PERFORM set_config('lock_timeout','2000',true);
 PERFORM id FROM profiles WHERE id=a FOR SHARE;
 PERFORM bill2_actor(a);
 SELECT * INTO s FROM runtime_sessions WHERE id=target AND actor_id=a FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 deleted:=s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL;
 IF deleted THEN
  RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',true,
   'preservedSavedVersions',0,'financialReviewCount',0);
 END IF;
 -- Writers that copy a result out of this conversation (saving a work result, capture, history
 -- dependencies) lock its execution rows first and then check availability, so taking the same
 -- rows here serializes them with the marker: a copy committed first is visible to the checks
 -- below and cleaned now; a writer that waits sees the committed marker and is refused.
 PERFORM id FROM runtime_executions WHERE session_id=target AND actor_id=a ORDER BY id FOR UPDATE;
 -- Read-only scope (no account-wide locks). The marker alone is enough only when nothing outside
 -- this conversation holds a copy: a free conversation (no work, draft or topic binding), every scoped
 -- execution in it, no saved content, work, data event, result link, captured field, library
 -- request or other conversation's frozen material referencing it. Anything else, or any doubt,
 -- runs the full cleanup now so no derived copy stays readable after this call returns.
 -- ERASE-SPEED bound first: a conversation bound to a draft or a topic workspace (the same two conditions as
 -- below) is never cleaned by the marker alone; only for it is the scope not computed here.
 unbound:=NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target);
 IF unbound THEN
  scope:=content_erasure_scope(a,'session',target);
  SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
  refs:=ids||target;
 END IF;
 local:=unbound AND s.scope->>'kind'='positioning_draft' AND s.scope->>'workItemId' IS NULL
  AND NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM runtime_executions e WHERE e.id=ANY(ids) AND e.session_id<>target)
  AND NOT EXISTS(SELECT 1 FROM fusion_billing_groups fg WHERE fg.source_session_id=target)
  AND NOT EXISTS(SELECT 1 FROM fusion_compares fcmp WHERE fcmp.session_id=target)
  AND jsonb_array_length(scope->'projects')=0 AND jsonb_array_length(scope->'versions')=0
  AND jsonb_array_length(scope->'contents')=0 AND jsonb_array_length(scope->'affectedSources')=0
  AND NOT EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=a AND c.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d WHERE d.actor_id=a AND d.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE l.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.erased_at IS NULL AND content_erasure_references(r.steps,refs))
  AND NOT EXISTS(SELECT 1 FROM opc_library_requests q WHERE q.actor_id=a AND q.erased_at IS NULL
   AND (content_erasure_references(q.payload,refs) OR content_erasure_references(q.result,refs)))
  AND NOT EXISTS(SELECT 1 FROM runtime_scope_material m JOIN runtime_sessions o ON o.id=m.session_id
   WHERE o.actor_id=a AND m.session_id<>target AND m.erased_at IS NULL
    AND (content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)));
 UPDATE runtime_sessions SET content_deleted_at=clock_timestamp() WHERE id=target RETURNING content_deleted_at INTO stamp;
 -- CORE-PATH-V2: the conversation's messages leave the visible history now (one indexed update, still under the session
 -- lock turn_close appends under); their text is cleared with the rest of the conversation by content_erasure_confirm.
 UPDATE session_messages SET visible=false,deleted_at=stamp WHERE session_id=target AND (visible OR deleted_at IS NULL);
 -- Off-database erasure manifest (0227): recorded at the marker's time, in the same transaction;
 -- the later cleanup's own note keeps this first time.
 PERFORM erasure_manifest_note('session',target,a,stamp);
 IF NOT local THEN
  -- Same transaction: the marked-session cleanup locks only rows in scope. If it is busy the
  -- marker rolls back with it and the caller reports the conversation as not deleted.
  RETURN content_erasure_confirm(a,'session',target,NULL)||jsonb_build_object('alreadyDeleted',false);
 END IF;
 -- Content is unreadable from here on. Money facts stay on their original runs; the
 -- background cleanup reports any financial review.
 RETURN jsonb_build_object('kind','session','id',target,'status','deleted','alreadyDeleted',false,
  'preservedSavedVersions',0,'financialReviewCount',0);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $function$;

-- content_erasure_confirm(uuid,text,uuid,text)
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
 remaining bigint:=0; deleted boolean; deleted_runs text[]; deleted_pre text[];
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
 -- A session with a turn still open keeps its (tombstoned, content-free) shell until that turn closes: an erased row is
 -- immutable and the closing turn releases active_turn_id on it. The sweep erases it on a later pass.
 UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL
  AND active_turn_id IS NULL;
 -- CORE-PATH-V2 conversation content: the provider response bodies of its turns and its message text. The turns and their
 -- receipts are billing records and keep their billing fields (plan 4.6).
 DELETE FROM turn_call_raw r USING turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions) AND r.turn_id=t.id;
 UPDATE session_messages SET content='',content_hash=encode(sha256(''::bytea),'hex'),visible=false,deleted_at=coalesce(deleted_at,stamp)
  WHERE session_id=ANY(sessions) AND (content<>'' OR visible);
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

-- account_erasure_body_remaining(uuid)
CREATE OR REPLACE FUNCTION public.account_erasure_body_remaining(p_profile_id uuid)
 RETURNS bigint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0338 account results proof

-- 0232 account name proof

-- R9 account proof

DECLARE entry record; n bigint; total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM fusion_call_outputs WHERE actor_id=p_profile_id)+(SELECT count(*) FROM fusion_reviews WHERE actor_id=p_profile_id)+(SELECT count(*) FROM fusion_compares WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM runtime_session_results WHERE actor_id=p_profile_id)
  +(SELECT count(*) FROM runtime_session_names WHERE actor_id=p_profile_id)
  -- CORE-PATH-V2 (account_erasure_scrub_turns): message text and provider response bodies still held.
  +(SELECT count(*) FROM session_messages m JOIN runtime_sessions s ON s.id=m.session_id
     WHERE s.actor_id=p_profile_id AND (m.content<>'' OR m.visible))
  +(SELECT count(*) FROM turn_call_raw r JOIN turn_calls c ON c.turn_id=r.turn_id AND c.seq=r.seq WHERE c.actor_id=p_profile_id);
BEGIN
 FOR entry IN SELECT * FROM (VALUES
  ('runtime_sessions','t.actor_id=$1'),
  ('runtime_executions','t.actor_id=$1'),
  ('artifact_projects','t.actor_id=$1'),
  ('opc_accounts','t.actor_id=$1'),
  ('opc_businesses','t.actor_id=$1'),
  ('opc_handoffs','t.actor_id=$1'),
  ('opc_content_versions','t.actor_id=$1'),
  ('opc_library_requests','t.actor_id=$1'),
  ('opc_topic_workspaces','t.actor_id=$1'),
  ('opc_topic_draft_versions','t.actor_id=$1'),
  ('research_plans','t.actor_id=$1'),
  ('conversations','t.user_id=$1'),
  -- 0271 legacy chat tables
  ('messages','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('conversation_context_snapshots','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('runtime_scope_material','EXISTS(SELECT 1 FROM runtime_sessions p WHERE p.id=t.session_id AND p.actor_id=$1)'),
  ('runtime_session_history','EXISTS(SELECT 1 FROM runtime_sessions p WHERE p.id=t.session_id AND p.actor_id=$1)'),
  ('runtime_session_batches','EXISTS(SELECT 1 FROM runtime_sessions p WHERE p.id=t.session_id AND p.actor_id=$1)'),
  ('runtime_tool_calls','EXISTS(SELECT 1 FROM runtime_executions p WHERE p.id=t.execution_id AND p.actor_id=$1)'),
  ('runtime_history_dependencies','EXISTS(SELECT 1 FROM runtime_executions p WHERE p.id=t.execution_id AND p.actor_id=$1)'),
  ('artifact_rounds','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_evidence','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_versions','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_requests','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_generations','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_work_references','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('agent_slice_executions','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.project_id AND p.actor_id=$1)'),
  ('artifact_confirmations','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('artifact_candidates','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('agent_slice_links','EXISTS(SELECT 1 FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id WHERE r.id=t.round_id AND p.actor_id=$1)'),
  ('artifact_chat_turns','EXISTS(SELECT 1 FROM conversations p WHERE p.id=t.conversation_id AND p.user_id=$1)'),
  ('research_operations','EXISTS(SELECT 1 FROM research_plans p WHERE p.id=t.plan_id AND p.actor_id=$1)'),
  ('opc_plans','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_turns','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_topic_openings','EXISTS(SELECT 1 FROM opc_drafts p WHERE p.draft_id=t.draft_id AND p.actor_id=$1)'),
  ('opc_items','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.work_item_id AND p.actor_id=$1)'),
  ('opc_item_edits','EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=t.work_item_id AND p.actor_id=$1)')
 ) AS v(tbl,predicate) LOOP
  EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s) AND t.erased_at IS NULL',entry.tbl,entry.predicate)
   INTO n USING p_profile_id;
  total:=total+n;
 END LOOP;
 RETURN total;
END $function$;

-- voice_delete_versions(uuid,uuid[])
CREATE OR REPLACE FUNCTION public.voice_delete_versions(a uuid, ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE n integer;
BEGIN
 INSERT INTO voice_billing_scrubs(run_id,actor_id,outcome)
 SELECT billing_run_id,a,CASE WHEN profile IS NULL THEN 'confirmed_failure' ELSE 'cancelled' END
 FROM voice_profile_versions WHERE actor_id=a AND id=ANY(ids) AND billing_run_id IS NOT NULL
 ON CONFLICT(run_id) DO NOTHING;
 DELETE FROM voice_profile_versions WHERE actor_id=a AND id=ANY(ids);
 GET DIAGNOSTICS n=ROW_COUNT;
 -- CORE-PATH-V2: replies written with a deleted version leave the visible history (Owner 10-23: effective at once). The
 -- open turns bound to it are locked first, so a turn that closes waits for this commit, re-reads its tombstones, closes
 -- erased and saves nothing. The callers hold the account row (library_actor), which turn_close takes before its turn row,
 -- so a turn row held here is only ever held by a call write (turn row only): waiting on it cannot deadlock.
 PERFORM 1 FROM turns WHERE actor_id=a AND policy->>'voiceVersionId'=ANY(ids::text[]) AND policy ? 'voiceVersionId'
  AND state<>'closed' ORDER BY id FOR UPDATE;
 UPDATE session_messages m SET visible=false FROM turns t
  WHERE t.actor_id=a AND t.policy ? 'voiceVersionId' AND t.policy->>'voiceVersionId'=ANY(ids::text[])
   AND m.session_id=t.session_id AND m.turn_id=t.id AND m.visible;
 RETURN n;
END $function$;

-- account_erasure_scrub_runtime(uuid)
CREATE OR REPLACE FUNCTION public.account_erasure_scrub_runtime(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  now_at timestamptz := clock_timestamp(); counts jsonb := '{}'; n bigint; g record;
  session_ids uuid[]; conversation_ids uuid[];
BEGIN
  IF p_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.account_erasure_barrier() THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- confirm and scrub must use separate transactions. The service cannot backdate confirmed_at.
  -- Conservatively also retry a caller whose transaction predates a concurrent confirmation;
  -- this is not the barrier cutoff or proof of commit (the activity/prepared checks remain).
  IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id
    AND confirmed_at >= transaction_timestamp()) THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- Runtime writers lock session before execution. Never hold profile/run/project locks here.
  -- Do not wait on a busy session/conversation; counters include the omitted rows.
  session_ids := ARRAY(SELECT id FROM runtime_sessions WHERE actor_id = p_profile_id FOR UPDATE SKIP LOCKED);
  conversation_ids := ARRAY(SELECT id FROM conversations WHERE user_id = p_profile_id FOR UPDATE SKIP LOCKED);

  FOR g IN SELECT * FROM (VALUES
    ('runtime_executions',
      'payload = NULL, result = NULL, primary_result = NULL, match_result = NULL, erased_at = $2',
      't.actor_id = $1 AND EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      't.session_id = ANY($3) AND t.state IN (''completed'',''cancelled'') AND (t.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b
      WHERE b.id = t.billing_run_id AND b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded'')))'),
    ('runtime_history_dependencies',
      'erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1)',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded''))) ) AND EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id =
      t.dependency_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN (''completed'',''cancelled'') AND (e.billing_run_id IS NULL
      OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND b.actor_id = $1 AND b.closed AND b.state IN
      (''settled'',''refunded''))) )'),
    ('runtime_session_batches',
      'items = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded''))) AND e.session_id = t.session_id)'),
    ('runtime_session_history',
      'item = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded''))) AND e.session_id = t.session_id)'),
    ('runtime_tool_calls',
      'arguments = NULL, result = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1)',
      'EXISTS (SELECT 1 FROM runtime_executions e WHERE e.id = t.execution_id AND e.actor_id = $1 AND e.session_id = ANY($3) AND e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded''))) )'),
    ('runtime_scope_material',
      'request = NULL, content = NULL, content_hash = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = t.session_id AND s.actor_id = $1)',
      't.session_id = ANY($3) AND NOT EXISTS (SELECT 1 FROM runtime_executions e WHERE e.session_id = t.session_id AND NOT (e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded'')))))'),
    ('runtime_sessions',
      'scope = NULL, start_payload = NULL, erased_at = $2',
      't.actor_id = $1',
      -- CORE-PATH-V2: a session with a turn still open is erased once the turn closes (it releases active_turn_id there).
      't.id = ANY($3) AND t.active_turn_id IS NULL AND NOT EXISTS (SELECT 1 FROM runtime_executions e WHERE e.session_id = t.id AND NOT (e.state IN
      (''completed'',''cancelled'') AND (e.billing_run_id IS NULL OR EXISTS (SELECT 1 FROM bill2_runs b WHERE b.id = e.billing_run_id AND
      b.actor_id = $1 AND b.closed AND b.state IN (''settled'',''refunded'')))))'),
    -- 0271 legacy chat tables
    ('messages',
      'content = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id =
      ch.project_id AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.conversation_id AND ag.state NOT IN
      (''succeeded'',''refunded''))'),
    ('conversation_context_snapshots',
      'content = NULL, metadata = NULL, erased_at = $2',
      'EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id AND c.user_id = $1)',
      't.conversation_id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id =
      ch.project_id AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.conversation_id AND ag.state NOT IN
      (''succeeded'',''refunded''))'),
    ('conversations',
      'title = NULL, summary = NULL, summary_metadata = NULL, erased_at = $2',
      't.user_id = $1',
      't.id = ANY($4) AND NOT EXISTS (SELECT 1 FROM artifact_chats ch JOIN artifact_generations ag ON ag.project_id = ch.project_id
      AND ag.round_id = ch.round_id WHERE ch.conversation_id = t.id AND ag.state NOT IN (''succeeded'',''refunded''))')
  ) v(tbl, assignment, owned, ready) LOOP
    EXECUTE format('UPDATE public.%I t SET %s WHERE (%s) AND t.erased_at IS NULL AND (%s)',
      g.tbl, g.assignment, g.owned, g.ready) USING p_profile_id, now_at, session_ids, conversation_ids;
    GET DIAGNOSTICS n = ROW_COUNT;
    counts := counts || jsonb_build_object(g.tbl, n);
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s) AND t.erased_at IS NULL',
      g.tbl, g.owned) INTO n USING p_profile_id;
    counts := counts || jsonb_build_object(g.tbl || '_skipped', n);
  END LOOP;
  RETURN counts;
END $function$;

-- content_erasure_turn_check(uuid,bigint): what content_erasure_runtime_check is for an execution, for a turn. A reader that
-- copies a turn's output (saving a result, a report source) calls it under its own lock: unknown turn -> CONTENT_NOT_FOUND,
-- deleted conversation or erasing account -> CONTENT_ERASED.
CREATE OR REPLACE FUNCTION public.content_erasure_turn_check(a uuid, p_turn_id bigint)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns;
BEGIN
 SELECT * INTO t FROM turns WHERE actor_id=a AND id=p_turn_id;
 IF t.id IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=a)
  OR NOT EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=t.session_id AND s.actor_id=a
   AND s.content_deleted_at IS NULL AND s.erased_at IS NULL) THEN
  RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501';
 END IF;
END $function$;
REVOKE ALL ON FUNCTION public.content_erasure_turn_check(uuid,bigint) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
