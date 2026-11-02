-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch R1b: work-item, video, capture and conversation-list functions drop their old-path branches
-- (runtime_executions, bill2_runs, runtime_history_available). Each removed branch reads a row only the old path writes, so for
-- turn-path data it is empty or false and the result is unchanged; an old execution used as a source is refused instead
-- (opc_data_event_guard, opc_video_turn_check), as old histories go with the old path (staging holds test data of it only).
--   opc_capture_resolve: only a mentor turn's suggestion (turn_mentor_source_available) can be accepted, ignored or dismissed.
--   opc_free_conversations: a conversation is named by its first visible message (the turn path's rule); no execution row feeds the list.
--   opc_work_results, artifact_save_candidate, opc_step_material, opc_video_material_prepare: the old executions are not looked at.
-- Repeatable: whole-function CREATE OR REPLACE. Recovery: re-apply the previous text of the functions from git history.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.opc_step_material(p_actor_id uuid, p_draft_id uuid, p_request_id uuid, p_step_id text, p_purpose text, p_input text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts;m runtime_scope_material;n bigint;r artifact_rounds;t opc_turns;result jsonb;spec jsonb;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id)); END IF;

 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
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
 SELECT x INTO spec FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=p_step_id;
 IF p_purpose IN ('step','mentor') AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(spec->'dependsOn') dep WHERE (r.steps->dep->>'valid')::boolean IS DISTINCT FROM true) THEN RAISE EXCEPTION 'OPC_DEPENDENCIES_UNCONFIRMED';END IF;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=d.session_id;
 result:=runtime_material(p_actor_id,d.session_id,'save',p_request_id,n,jsonb_build_object('brief',p_purpose||':'||p_step_id,'material','','roundId',r.id));
 INSERT INTO opc_turns(draft_id,session_id,request_id,round_id,step_id,purpose,material_revision,input_hash) VALUES(d.draft_id,d.session_id,p_request_id,r.id,p_step_id,p_purpose,(result->>'revision')::bigint,artifact_hash(to_jsonb(p_input))) RETURNING * INTO t;
 RETURN result||jsonb_build_object('turnToken',t.token);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_video_material_prepare(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_source_script_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;script opc_content_versions;binding opc_video_material_bindings;m runtime_scope_material;result jsonb;n bigint;material_request uuid:=gen_random_uuid();
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('workItemId',p_work_item_id)); END IF;

 PERFORM bill2_actor(p_actor_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id);
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id) FOR UPDATE;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 IF i.work_item_id IS NULL OR s.id IS NULL OR script.id IS NULL OR NOT opc_content_allowed(p_actor_id,script.id) THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF binding.request_id IS NOT NULL THEN
  IF binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id OR binding.session_id<>s.id THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF m.session_id IS NULL OR m.revoked THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  RETURN jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash);
 END IF;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
 result:=runtime_material(p_actor_id,s.id,'save',material_request,n,jsonb_build_object('brief','已定稿口播稿：'||script.body,'material',coalesce(opc_profile(i.source_version_id)::text,''),'roundId',NULL));
 INSERT INTO opc_video_material_bindings(actor_id,request_id,work_item_id,source_script_id,session_id,material_revision)
  VALUES(p_actor_id,p_request_id,p_work_item_id,p_source_script_id,s.id,(result->>'revision')::bigint);
 RETURN result;
END $function$;

-- opc_video_material_prepare(uuid,uuid,uuid,uuid,boolean,boolean,bigint,bigint)
CREATE OR REPLACE FUNCTION public.opc_video_material_prepare(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_source_script_id uuid, p_storyboard boolean, p_editing boolean, p_expected_storyboard_version bigint, p_expected_editing_version bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;script opc_content_versions;source_story opc_content_versions;binding opc_video_material_bindings;m runtime_scope_material;result jsonb;n bigint;material_request uuid:=gen_random_uuid();conflict record;package jsonb;want_story boolean;want_edit boolean;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('workItemId',p_work_item_id)); END IF;

 PERFORM bill2_actor(p_actor_id);
 -- The all-false form is the terminal action for a material claim whose
 -- Runtime admission is now proven absent. It reuses the existing immutable
 -- request identity and material revocation; no second claim ledger exists.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,107));
 IF NOT coalesce(p_storyboard,false) AND NOT coalesce(p_editing,false) THEN
  SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF binding.request_id IS NULL OR binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id
   OR (binding.expected_storyboard_version IS NOT NULL AND binding.expected_storyboard_version<>p_expected_storyboard_version)
   OR (binding.expected_editing_version IS NOT NULL AND binding.expected_editing_version<>p_expected_editing_version)
   THEN RAISE EXCEPTION 'OPC_CONTENT_PENDING';END IF;
  -- Runtime admission uses the same request-then-session lock order. Once this
  -- lock is held, either an execution already froze this exact material and
  -- the claim stays recoverable, or a later admission observes the revocation.
  PERFORM 1 FROM runtime_sessions WHERE id=binding.session_id AND actor_id=p_actor_id FOR UPDATE;
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF m.session_id IS NULL OR EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_actor_id AND t.request_id=p_request_id)
  THEN RAISE EXCEPTION 'OPC_CONTENT_PENDING';END IF;
  result:=runtime_material(p_actor_id,binding.session_id,'revoke',NULL,binding.material_revision,NULL);
  RETURN result||jsonb_build_object('abandoned',true);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_work_item_id::text,119));
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id);
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id) FOR UPDATE;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 IF i.work_item_id IS NULL OR s.id IS NULL OR script.id IS NULL OR NOT opc_content_allowed(p_actor_id,script.id) THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF binding.request_id IS NOT NULL THEN
  IF binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id OR binding.session_id<>s.id
   OR (binding.storyboard IS NOT NULL AND binding.storyboard IS DISTINCT FROM p_storyboard)
   OR (binding.editing IS NOT NULL AND binding.editing IS DISTINCT FROM p_editing)
   OR (binding.expected_storyboard_version IS NOT NULL AND binding.expected_storyboard_version<>p_expected_storyboard_version)
   OR (binding.expected_editing_version IS NOT NULL AND binding.expected_editing_version<>p_expected_editing_version)
   THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF m.session_id IS NULL OR m.revoked THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  RETURN jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash);
 END IF;
 IF opc_item_content_type(p_work_item_id)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
 -- A new editing-only request must freeze the actual matching storyboard.
 -- The existing binding replay above intentionally retains old paid requests.
 IF p_editing AND NOT p_storyboard THEN
  SELECT * INTO source_story FROM opc_content_versions WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='storyboard' AND status='final' AND source_content_id=script.id ORDER BY version DESC LIMIT 1;
  IF source_story.id IS NULL OR NOT opc_content_allowed(p_actor_id,source_story.id) THEN RAISE EXCEPTION 'OPC_STORYBOARD_REQUIRED';END IF;
  IF source_story.version<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=p_actor_id AND c.work_item_id=p_work_item_id AND c.source_content_id=script.id
  AND ((p_storyboard AND c.kind='storyboard') OR (p_editing AND c.kind='editing'))) THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
 IF p_storyboard THEN SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='storyboard';IF n<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;END IF;
 IF p_editing THEN SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='editing';IF n<>p_expected_editing_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;END IF;
 -- A completed and saved binding no longer occupies the global kind/version
 -- slot. Cancelled or structurally invalid terminal output may be retried only
 -- under a new explicit request. Every other overlap is still recoverable and
 -- therefore blocks a second paid dispatch.
 FOR conflict IN
  -- The claimed request ran on the old path or as a turn: a turn that closed any other way than completed retries like a cancelled execution.
  SELECT b.*,t.id::text execution_id,
   CASE WHEN t.close_kind='completed' THEN 'completed' WHEN t.close_kind IS NOT NULL THEN 'cancelled' WHEN t.id IS NOT NULL THEN 'running' END execution_state,
   (SELECT string_agg(sm.content,E'\n\n' ORDER BY sm.seq) FROM session_messages sm WHERE sm.session_id=t.session_id AND sm.turn_id=t.id AND sm.role='assistant' AND sm.visible) raw,
   material_row.revoked material_revoked
  FROM opc_video_material_bindings b
  LEFT JOIN LATERAL opc_turn_latest(b.actor_id,b.request_id) t ON true
  LEFT JOIN runtime_scope_material material_row ON material_row.session_id=b.session_id AND material_row.revision=b.material_revision
  WHERE b.actor_id=p_actor_id AND b.work_item_id=p_work_item_id AND b.request_id<>p_request_id
   AND ((p_storyboard AND coalesce(b.storyboard,true)) OR (p_editing AND coalesce(b.editing,true)))
 LOOP
  IF coalesce(conflict.material_revoked,false) THEN CONTINUE;END IF;
  -- A claim whose request never opened (no execution, no turn) and is older than the window is abandoned: the page that made it opens
  -- the request at once, and nobody else can release it (another browser, cleared storage). Its material is revoked here, in this
  -- transaction under the session lock: the old request can no longer open (opc_work_check, and opc_work_verify after an open that
  -- raced this), so it cannot pay for what the new claim is about to make.
  IF conflict.execution_id IS NULL AND conflict.created_at < now() - interval '10 minutes' THEN
   PERFORM runtime_material(p_actor_id,conflict.session_id,'revoke',NULL,conflict.material_revision,NULL);CONTINUE;
  END IF;
  package:=NULL;
  IF conflict.execution_state='completed' THEN BEGIN package:=conflict.raw::jsonb;EXCEPTION WHEN others THEN package:=NULL;END;END IF;
  -- 0118 rows predate explicit choice columns. Infer only a structurally valid
  -- completed package; an unknown/nonterminal legacy row remains conservative.
  want_story:=coalesce(conflict.storyboard,true);want_edit:=coalesce(conflict.editing,true);
  IF conflict.storyboard IS NULL AND conflict.editing IS NULL THEN
   want_story:=jsonb_typeof(package)='object' AND package-ARRAY['storyboard']='{}'::jsonb
    AND jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000;
   want_edit:=jsonb_typeof(package)='object' AND package-ARRAY['editing']='{}'::jsonb
    AND jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000;
   IF jsonb_typeof(package)='object' AND package-ARRAY['storyboard','editing']='{}'::jsonb
    AND jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000
    AND jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000
   THEN want_story:=true;want_edit:=true;END IF;
   IF NOT want_story AND NOT want_edit THEN want_story:=true;want_edit:=true;END IF;
  END IF;
  -- A recovered legacy single-kind request releases only the kind proven by
  -- its exact terminal package and saved artifact. It must not reserve both
  -- kinds forever or block the same kind for a newly finalized script.
  IF (NOT want_story OR EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=conflict.actor_id AND c.request_id=conflict.request_id AND c.kind='storyboard' AND c.source_content_id=conflict.source_script_id))
   AND (NOT want_edit OR EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=conflict.actor_id AND c.request_id=conflict.request_id AND c.kind='editing' AND c.source_content_id=conflict.source_script_id))
  THEN CONTINUE;END IF;
  IF NOT ((p_storyboard AND want_story) OR (p_editing AND want_edit)) THEN CONTINUE;END IF;
  IF conflict.execution_id IS NULL OR conflict.execution_state NOT IN ('cancelled','completed') THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
  IF conflict.execution_state='cancelled' THEN CONTINUE;END IF;
  IF jsonb_typeof(package)='object'
   AND ((want_story AND want_edit AND package-ARRAY['storyboard','editing']='{}'::jsonb)
    OR (want_story AND NOT want_edit AND package-ARRAY['storyboard']='{}'::jsonb)
    OR (want_edit AND NOT want_story AND package-ARRAY['editing']='{}'::jsonb))
   AND (NOT want_story OR (jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000))
   AND (NOT want_edit OR (jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000))
   THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
 END LOOP;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
 result:=runtime_material(p_actor_id,s.id,'save',material_request,n,jsonb_build_object('brief','已定稿口播稿：'||script.body,'material',CASE WHEN source_story.id IS NULL THEN coalesce(opc_profile(i.source_version_id)::text,'') ELSE jsonb_build_object('positioning',opc_profile(i.source_version_id),'sourceStoryboardId',source_story.id,'storyboardVersion',source_story.version,'storyboard',source_story.body)::text END,'roundId',NULL));
 INSERT INTO opc_video_material_bindings(actor_id,request_id,work_item_id,source_script_id,session_id,material_revision,storyboard,editing,expected_storyboard_version,expected_editing_version)
  VALUES(p_actor_id,p_request_id,p_work_item_id,p_source_script_id,s.id,(result->>'revision')::bigint,p_storyboard,p_editing,p_expected_storyboard_version,p_expected_editing_version);
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_video_turn_check(p_actor_id uuid, p_work_item_id uuid, p_turn_id bigint, p_source_script_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;t turns;script opc_content_versions;m runtime_scope_material;
 ancestor opc_content_versions;current_id uuid;seen uuid[]:='{}';admitted boolean:=false;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id);
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 SELECT * INTO t FROM turns WHERE id=p_turn_id AND actor_id=p_actor_id AND session_id=s.id;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=s.id AND revision=(t.policy#>>'{workMaterial,revision}')::bigint AND NOT revoked;
 IF i.work_item_id IS NULL OR t.id IS NULL OR script.id IS NULL OR NOT opc_content_allowed(p_actor_id,script.id)
  OR m.session_id IS NULL OR t.policy#>>'{workMaterial,hash}' IS DISTINCT FROM m.content_hash
  OR m.content->>'brief' IS DISTINCT FROM '已定稿口播稿：'||script.body
  OR NOT (m.request_id=script.request_id OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=p_actor_id AND b.session_id=m.session_id AND b.material_revision=m.revision AND b.source_script_id=script.id))
  THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 -- Manual revisions deliberately have no execution_id. Validate every source
 -- edge in this work item's script chain, then require an available admitted
 -- execution. Do not accept a valid prefix of a broken or cyclic chain.
 current_id:=script.id;
 WHILE current_id IS NOT NULL LOOP
  IF current_id=ANY(seen) THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  SELECT * INTO ancestor FROM opc_content_versions WHERE id=current_id
   AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script';
  IF NOT FOUND THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  IF ancestor.turn_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM turns original WHERE id=ancestor.turn_id AND actor_id=p_actor_id AND session_id=s.id AND close_kind='completed')
    OR NOT opc_content_turn_available(p_actor_id,ancestor.turn_id)
    THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
   admitted:=true;
  END IF;
  IF ancestor.execution_id IS NOT NULL THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  seen:=array_append(seen,current_id);current_id:=ancestor.source_content_id;
 END LOOP;
 IF NOT admitted THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 RETURN jsonb_build_object('valid',true,'materialRevision',m.revision);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_free_conversations(p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0232 conversation name; 0444 conversations of the turn path

DECLARE conversations jsonb;memo_opened boolean;
BEGIN
 -- DB-PERF PR-7b-B memo scope: identical permission sub-checks of this list are evaluated once (0367).
 memo_opened:=runtime_check_memo_open();
 PERFORM bill2_actor(p_actor_id);
 WITH recent AS MATERIALIZED (
 SELECT s.id,first_turn.id AS execution_id,first_turn.payload,first_compare.id AS compare_id,first_compare.question AS compare_question,first_compare.created_at AS compare_at,
  first_msg.content AS message_text,first_msg.created_at AS message_at,activity.last_activity
 FROM (
  -- DB-PERF PR-7b-A exclusions first: the permission check runs only on sessions the list can show.
  SELECT candidate.* FROM (
   SELECT session.* FROM runtime_sessions session
   WHERE session.erased_at IS NULL AND session.content_deleted_at IS NULL AND session.actor_id=p_actor_id AND session.scope->>'kind'='positioning_draft'
    AND NOT EXISTS(SELECT 1 FROM opc_drafts draft WHERE draft.session_id=session.id)
    AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces topics WHERE topics.session_id=session.id)
   OFFSET 0
  ) candidate WHERE bill2_scope_allowed(p_actor_id,candidate.scope)
 ) s
 LEFT JOIN LATERAL (SELECT NULL::uuid AS id, NULL::jsonb AS payload WHERE false) first_turn ON true
 -- FUSION-COMPARE first message: a conversation that so far holds only a compare
 LEFT JOIN LATERAL (
  SELECT c.id,c.question,c.created_at FROM fusion_compares c
  WHERE c.session_id=s.id AND c.actor_id=p_actor_id AND c.state<>'refused' AND NOT (c.state='admitting' AND c.created_at<=clock_timestamp()-interval '5 minutes')
  ORDER BY c.created_at,c.id LIMIT 1
 ) first_compare ON true
 -- CORE-PATH-V2: a conversation of the turn path has no execution; its first visible user message names it.
 LEFT JOIN LATERAL (
  SELECT m.content,m.created_at FROM session_messages m
  WHERE m.session_id=s.id AND m.role='user' AND m.visible AND m.deleted_at IS NULL
  ORDER BY m.seq LIMIT 1
 ) first_msg ON true
 CROSS JOIN LATERAL (
  SELECT greatest((SELECT max(c.created_at) FROM fusion_compares c
   WHERE c.session_id=s.id AND c.actor_id=p_actor_id AND c.state<>'refused' AND NOT (c.state='admitting' AND c.created_at<=clock_timestamp()-interval '5 minutes')),
   (SELECT max(greatest(t.opened_at,t.closed_at)) FROM turns t WHERE t.session_id=s.id AND t.actor_id=p_actor_id),
   (SELECT max(m.created_at) FROM session_messages m WHERE m.session_id=s.id AND m.visible AND m.deleted_at IS NULL)) AS last_activity
 ) activity
 -- PR6 scheduled review list filter
 WHERE (first_turn.id IS NOT NULL OR first_compare.id IS NOT NULL OR first_msg.created_at IS NOT NULL)
 AND NOT coalesce(first_turn.payload ? 'weeklyReview',false)
 ORDER BY activity.last_activity DESC,s.id LIMIT 100
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'sessionId',s.id,
  'title',coalesce((SELECT n.name FROM runtime_session_names n WHERE n.session_id=s.id AND n.actor_id=p_actor_id),
   CASE WHEN s.message_at IS NOT NULL AND (s.compare_at IS NULL OR s.message_at<=s.compare_at)
      THEN left(coalesce(nullif(btrim(s.message_text),''),'新对话'),80)
     WHEN s.compare_question IS NOT NULL THEN left(coalesce(nullif(btrim(s.compare_question),''),'新对话'),80) ELSE '对话记录' END),
  'lastActivityAt',s.last_activity
 ) ORDER BY s.last_activity DESC,s.id),'[]'::jsonb) INTO conversations
 FROM recent s;
 PERFORM runtime_check_memo_close(memo_opened);
 RETURN conversations;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_work_results(p_actor_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR (s.content_deleted_at IS NULL AND NOT bill2_scope_allowed(p_actor_id,s.scope)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 RETURN (SELECT coalesce(jsonb_agg(jsonb_build_object('artifactId',v.id,'version',v.version,'sourceAvailable',artifact_evidence_allowed(v.project_id,v.evidence_ids),'body',CASE WHEN content_erasure_artifact_readable(p_actor_id,v.id) THEN v.report->'sections'->0->>'body' ELSE NULL END,'turnId',v.report->'turnId') ORDER BY v.created_at),'[]') FROM artifact_versions v
  -- CORE-PATH-V2 V2-10b: an old result's version is its execution; a turn's is named by its link (opc_work_result_turn).
  WHERE v.id IN (SELECT l.round_id FROM turns t JOIN opc_result_links l ON l.turn_actor_id=t.actor_id AND l.turn_id=t.id
    WHERE t.actor_id=p_actor_id AND t.session_id=s.id AND l.step_id='result'));
END $function$;

CREATE OR REPLACE FUNCTION public.artifact_save_candidate(p_actor_id uuid, p_module_id uuid, p_skill_id uuid, p_project_id uuid, p_round_id uuid, p_request_id uuid, p_step_id text, p_candidate_id uuid, p_expected_version integer, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r artifact_rounds;
BEGIN
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id FOR UPDATE;
 RETURN artifact_save_candidate_before_opc(p_actor_id,p_module_id,p_skill_id,p_project_id,p_round_id,p_request_id,p_step_id,p_candidate_id,p_expected_version,p_body);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_data_event_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'OPC_DATA_IMMUTABLE';END IF;
 IF NEW.turn_id IS NOT NULL THEN PERFORM opc_data_turn(NEW.actor_id,opc_data_event_source(NEW));
 ELSE RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED'; END IF;
 IF NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM artifact_projects
  WHERE id=NEW.project_id AND actor_id=NEW.actor_id AND erased_at IS NULL AND content_deleted_at IS NULL)
 THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_capture_resolve(p_actor_id uuid, p_draft_id uuid, p_request_id uuid, p_step_id text, p_field_id text, p_execution_id uuid, p_hash text, p_action text, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 accepted provenance

DECLARE d opc_drafts;r artifact_rounds;req artifact_requests;payload jsonb;st jsonb;meta jsonb;suggestion jsonb;
 value jsonb;information jsonb;version integer;response jsonb;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id)); END IF;

 PERFORM bill2_actor(p_actor_id);
 IF substr(p_request_id::text,15,1)='f' THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)),false)
 THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 -- V2-5: the draft's session row first, the lock a mentor turn's close holds while it writes this checklist (the main-path
 -- serialization point), so a manual save and a mentor capture never overwrite each other; then the project, as before.
 PERFORM 1 FROM runtime_sessions WHERE id=d.session_id AND actor_id=p_actor_id FOR UPDATE;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 payload:=jsonb_build_object('stepId',p_step_id,'fieldId',p_field_id,'executionId',p_execution_id,
  'hash',p_hash,'action',p_action,'expectedVersion',p_expected_version);
 IF NOT turn_mentor_source_available(p_actor_id,d.session_id,p_execution_id,d.project_id,r.id) THEN
  RAISE EXCEPTION 'OPC_CAPTURE_DENIED';
 END IF;
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND request_id=p_request_id;
 IF FOUND THEN
  IF req.action IS DISTINCT FROM 'opc_capture_resolve' OR req.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN req.response;
 END IF;
 st:=r.steps->p_step_id;meta:=st->'fieldMeta'->p_field_id;
 -- v3 suggestion withdraw: dismiss binds to the withdrawn record; accept/ignore to the pending one.
 suggestion:=CASE WHEN p_action='dismiss' THEN meta->'withdrawnSuggestion' ELSE meta->'suggestion' END;
 IF suggestion->>'executionId' IS DISTINCT FROM p_execution_id::text OR suggestion->>'hash' IS DISTINCT FROM p_hash
  OR suggestion IS NULL OR r.state<>'draft' THEN RAISE EXCEPTION 'OPC_SUGGESTION_CHANGED';END IF;
 IF p_request_id IS NULL OR p_hash IS NULL OR p_action IS NULL OR p_action NOT IN ('accept','ignore','dismiss')
 THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 version:=(st->>'version')::integer;
 IF p_action='accept' THEN
  IF version IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'OPC_INFORMATION_CONFLICT';END IF;
  value:=jsonb_build_object('value',suggestion->'value','status',suggestion->'status','nature',suggestion->'nature');
  information:=st->'information'||jsonb_build_object(p_field_id,value);
  IF octet_length(information::text)>12000 THEN RAISE EXCEPTION 'OPC_INFORMATION_CONFLICT';END IF;
  IF st->'information'->p_field_id IS DISTINCT FROM value THEN
   version:=version+1;
   st:=st||jsonb_build_object('information',information,'version',version,'informationUpdatedAt',clock_timestamp());
  END IF;
  meta:=jsonb_build_object('source','user','fp',artifact_hash(value),'basis',suggestion->'basis',
   'executionId',p_execution_id,'acceptedAt',clock_timestamp(),'createdAt',suggestion->'createdAt');
 ELSIF p_action='dismiss' THEN meta:=meta-'withdrawnSuggestion';
 ELSE meta:=meta-'suggestion';END IF;
 IF meta='{}' THEN st:=st #- ARRAY['fieldMeta',p_field_id];
 ELSE st:=jsonb_set(st,ARRAY['fieldMeta',p_field_id],meta);END IF;
 r.steps:=jsonb_set(r.steps,ARRAY[p_step_id],st);
 IF p_action='accept' AND version<>p_expected_version THEN r.steps:=artifact_invalidate(r.workflow,r.steps,p_step_id);END IF;
 UPDATE artifact_rounds SET steps=r.steps WHERE id=r.id;
 response:=jsonb_build_object('version',version,'result',p_action);
 INSERT INTO artifact_requests VALUES(d.project_id,p_request_id,r.id,'opc_capture_resolve',payload,response);
 RETURN response;
END $function$;

COMMIT;
