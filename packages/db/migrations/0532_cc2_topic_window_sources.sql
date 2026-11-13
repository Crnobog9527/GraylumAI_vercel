-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CONTENT-CONVERSATION-2 PR1 (Owner 2026-11-14: the topic window becomes a conversation like free chat; the fixed
-- "storyboard and editing" choice goes, the user asks in the conversation). Number 0532 assigned by the controller.
-- In a topic window the model loads a writing Skill during the turn (load_skill), so the host cannot know before the open whether
-- a storyboard or editing advice will be written. A video item's turn is therefore given both possible sources up front and the
-- turn freezes them as policy.workSources = [{contentId, kind, ...}] (script first, then its storyboard when there is one):
--   * opc_work_check: whole current definition plus 'sources' in its answer (video items only; none for a turn that claimed
--     video material, whose old package flow keeps its own source). Read only, as before (opc_content_source_pick with no lock).
--   * opc_content_from_turn: whole current definition; a storyboard or editing save takes its source from policy.workSources
--     when the turn has one of the needed kind, otherwise from the single policy.workSource exactly as before.
--   * opc_work_verify: whole current definition; every source in policy.workSources must still be allowed (opc_content_allowed).
--   * content_erasure_scope: whole current definition; deleting a script or storyboard also reaches the turns given it in
--     policy.workSources (as it already reaches a turn given it as policy.workSource).
--   * opc_topic_read: whole current definition; 'sourceVersion' (shown as "绑定正式定位 v{n}" on the topic page) becomes the
--     bound version's ordinal in the account strategy history, the number the library rail ("当前 v{n}") and the strategy history
--     show, instead of the project's publish counter (staging validation batch 6: v10 against v9). Same key, same type.
-- Compatibility: old code never writes workSources and ignores the new 'sources' key (zod object, unknown keys dropped); every
-- existing turn reads exactly as before. Repeatable: CREATE OR REPLACE only; signatures and privileges unchanged.
-- Recovery: re-apply the previous definitions (packages/db/functions at the parent commit of this migration).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.opc_work_check(p_actor_id uuid, p_session_id uuid, p_video_required boolean, p_request_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;item uuid;work jsonb;m runtime_scope_material;binding opc_video_material_bindings;sources jsonb:='[]'::jsonb;pick jsonb;k text;
BEGIN
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR s.scope->>'kind' IS DISTINCT FROM 'work_item' THEN RETURN jsonb_build_object('work',NULL); END IF; -- turn_open refuses another account's conversation
 -- By read only: opc_assert_business_writable takes a row lock, which the read client refuses.
 IF EXISTS(SELECT 1 FROM opc_businesses b WHERE b.id=opc_target_business(p_actor_id,jsonb_build_object('sessionId',p_session_id))
   AND b.actor_id=p_actor_id AND b.archived_at IS NOT NULL) THEN
  RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED' USING ERRCODE='42501';
 END IF;
 item:=(s.scope->>'workItemId')::uuid;
 IF p_video_required AND opc_item_content_type(item)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED'; END IF;
 -- The work method is the Skill revision of the round the item came from (opc_query's methodRevisionId), never the module's latest.
 SELECT jsonb_build_object('moduleId',p.module_id,'skillId',p.skill_id,'revisionId',r.revision_id) INTO work
  FROM artifact_projects p JOIN opc_items i ON i.work_item_id=p.id JOIN artifact_versions v ON v.id=i.source_version_id
  JOIN artifact_rounds r ON r.id=v.round_id WHERE p.id=item AND p.actor_id=p_actor_id;
 -- A request that claimed video material (opc_video_material_prepare) reads exactly that revision.
 IF p_request_id IS NOT NULL THEN
  SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
 END IF;
 IF binding.request_id IS NOT NULL THEN
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF binding.session_id<>s.id OR binding.work_item_id<>item OR m.session_id IS NULL OR m.revoked OR m.erased_at IS NOT NULL THEN
   RAISE EXCEPTION 'OPC_CONTENT_BINDING' USING ERRCODE='42501';
  END IF;
 ELSE
  -- The brief and material the old path froze for the next turn: the newest of this conversation not revoked. A claimed revision that
  -- has not opened its turn does not hold other requests back: a turn reads the material and does not use it up.
  SELECT * INTO m FROM runtime_scope_material
   WHERE session_id=s.id AND NOT revoked AND erased_at IS NULL ORDER BY revision DESC LIMIT 1;
 END IF;
 -- CONTENT-CONVERSATION-2 (0532): a video item's conversation is given its current final script and that script's newest storyboard on
 -- every turn, so a writing Skill the model loads during the turn can write a storyboard or editing advice from them and the reply can
 -- be saved as one (opc_content_from_turn reads the kind it needs from policy.workSources). Not for a turn that claimed video material
 -- (the old package flow keeps its own source); a storyboard of an older script is not given (opc_content_source_pick's STALE refusal).
 IF binding.request_id IS NULL AND opc_item_content_type(item)='video' THEN
  FOREACH k IN ARRAY ARRAY['script','storyboard'] LOOP
   pick:=opc_content_source_pick(p_actor_id,item,k,NULL,false);
   EXIT WHEN pick->>'status' IS DISTINCT FROM 'ready';
   sources:=sources||jsonb_build_array(pick-'status');
  END LOOP;
 END IF;
 RETURN jsonb_build_object('work',work||jsonb_build_object('brief',m.content->'brief','material',m.content->'material','sources',sources,
  'videoPackage',binding.request_id IS NOT NULL,'materialRevision',m.revision,'materialHash',m.content_hash));
END $function$;;

CREATE OR REPLACE FUNCTION public.opc_content_from_turn(p_actor_id uuid, p_work_item_id uuid, p_request_id uuid, p_expected_version bigint, p_kind text, p_status text, p_turn_id bigint, p_source_content_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE i opc_items;s runtime_sessions;t turns;c opc_content_versions;n bigint;source opc_content_versions;body text;frozen uuid;
BEGIN
 PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('workItemId',p_work_item_id));
 IF EXISTS(SELECT 1 FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind=p_kind AND erased_at IS NOT NULL) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 PERFORM bill2_actor(p_actor_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id;
 -- The session first, then the turn (turn_open's order): a delete that marked this conversation is seen below, one that waits
 -- sees the version committed and cleans it (opc_work_result_turn).
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id) FOR SHARE;
 SELECT * INTO t FROM turns WHERE actor_id=p_actor_id AND id=p_turn_id AND session_id=s.id FOR UPDATE;
 IF i.work_item_id IS NULL OR t.id IS NULL OR t.kind<>'chat' OR t.close_kind IS DISTINCT FROM 'completed'
   OR NOT opc_content_turn_available(p_actor_id,p_turn_id) THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 SELECT string_agg(m.content,E'\n\n' ORDER BY m.seq) INTO body FROM session_messages m
  WHERE m.session_id=s.id AND m.turn_id=p_turn_id AND m.role='assistant' AND m.visible;
 IF p_kind NOT IN ('brief','script','storyboard','editing') OR p_status NOT IN ('draft','final') OR char_length(coalesce(body,'')) NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 -- A storyboard reads the script, editing the storyboard, as supplied to the turn that wrote it (policy.workSource).
 IF p_kind IN ('storyboard','editing') THEN
  frozen:=CASE WHEN t.policy#>>'{workSource,kind}'=CASE p_kind WHEN 'storyboard' THEN 'script' ELSE 'storyboard' END THEN (t.policy#>>'{workSource,contentId}')::uuid END;
  -- CONTENT-CONVERSATION-2 (0532): a topic-window turn was given its sources as a list (opc_work_check); the one of the kind this
  -- save needs is the frozen source. The single workSource of a turn that chose a derived method is read as before.
  frozen:=coalesce((SELECT (e->>'contentId')::uuid FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.policy->'workSources')='array' THEN t.policy->'workSources' ELSE '[]'::jsonb END) e
   WHERE e->>'kind'=CASE p_kind WHEN 'storyboard' THEN 'script' ELSE 'storyboard' END LIMIT 1),frozen);
  IF p_source_content_id IS NULL THEN p_source_content_id:=frozen;
  ELSIF p_source_content_id IS DISTINCT FROM frozen THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';
  END IF;
  IF p_source_content_id IS NULL OR NOT opc_content_allowed(p_actor_id,p_source_content_id) THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
 END IF;
 SELECT * INTO c FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind=p_kind;
 IF FOUND THEN
  IF c.work_item_id<>p_work_item_id OR c.turn_id IS DISTINCT FROM p_turn_id OR c.status<>p_status OR c.source_content_id IS DISTINCT FROM p_source_content_id OR c.version<>p_expected_version+1 THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 ELSE
  IF p_kind IN ('script','storyboard','editing') AND opc_item_content_type(p_work_item_id)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind=p_kind;
  IF n<>p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF p_source_content_id IS NOT NULL THEN SELECT * INTO source FROM opc_content_versions WHERE id=p_source_content_id AND work_item_id=p_work_item_id;IF source.id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,turn_actor_id,turn_id,request_id)
   VALUES(p_actor_id,p_work_item_id,p_kind,n+1,p_status,body,p_source_content_id,p_actor_id,p_turn_id,p_request_id) RETURNING * INTO c;
 END IF;
 RETURN jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'body',c.body);
END $function$;;

CREATE OR REPLACE FUNCTION public.opc_work_verify(p_actor_id uuid, p_turn_id bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns;m runtime_scope_material;
BEGIN
 SELECT * INTO t FROM turns WHERE actor_id=p_actor_id AND id=p_turn_id;
 IF t.id IS NULL THEN RETURN false; END IF;
 IF t.policy ? 'workSource' AND NOT opc_content_allowed(p_actor_id,(t.policy#>>'{workSource,contentId}')::uuid) THEN RETURN false; END IF;
 -- CONTENT-CONVERSATION-2 (0532): every source a topic-window turn was given must still be allowed.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.policy->'workSources')='array' THEN t.policy->'workSources' ELSE '[]'::jsonb END) e
   WHERE NOT opc_content_allowed(p_actor_id,(e->>'contentId')::uuid)) THEN RETURN false; END IF;
 IF t.policy ? 'workMaterial' THEN
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=t.session_id AND revision=(t.policy#>>'{workMaterial,revision}')::bigint;
  IF m.session_id IS NULL OR m.revoked OR m.erased_at IS NOT NULL OR m.content_hash IS DISTINCT FROM t.policy#>>'{workMaterial,hash}' THEN RETURN false; END IF;
 END IF;
 RETURN true;
END $function$;;

CREATE OR REPLACE FUNCTION public.content_erasure_scope(a uuid, k text, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 erasure preview

DECLARE sessions uuid[]:='{}'; executions uuid[]:='{}'; projects uuid[]:='{}'; versions uuid[]:='{}';
 content_ids uuid[]:='{}'; refs uuid[]:='{}'; turn_ids bigint[]:='{}';
 root_s runtime_sessions;root_p artifact_projects;root_c opc_content_versions;
 deleted boolean:=false;more uuid[];n integer;preserved bigint;dependents jsonb;
BEGIN
 IF a IS NULL OR target IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF k='answer' THEN
  -- CORE-PATH-V2 V2-12 F: an answer was one old execution; none exists any more.
  RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501';
 ELSIF k='session' THEN
  SELECT * INTO root_s FROM runtime_sessions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  sessions:=ARRAY[root_s.id];deleted:=root_s.content_deleted_at IS NOT NULL OR root_s.erased_at IS NOT NULL;
 ELSIF k='artifact' THEN
  SELECT * INTO root_p FROM artifact_projects WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  projects:=ARRAY[root_p.id];deleted:=root_p.content_deleted_at IS NOT NULL OR root_p.erased_at IS NOT NULL;
  -- Account-specific strategy drafts are private copies in separate projects.
  projects:=projects||ARRAY(SELECT d.project_id FROM opc_account_strategy_drafts b
   JOIN opc_drafts d ON d.draft_id=b.draft_id JOIN artifact_projects p ON p.id=d.project_id
   WHERE b.account_project_id=root_p.id AND b.actor_id=a AND d.actor_id=a AND p.actor_id=a);
  versions:=ARRAY(SELECT id FROM artifact_versions WHERE project_id=ANY(projects) ORDER BY id);
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY id);
 ELSIF k='content' THEN
  SELECT * INTO root_c FROM opc_content_versions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=root_c.work_item_id AND kind=root_c.kind);
  deleted:=NOT EXISTS(SELECT 1 FROM opc_content_versions WHERE id=ANY(content_ids) AND erased_at IS NULL);
 ELSE RAISE EXCEPTION 'CONTENT_TARGET_INVALID' USING ERRCODE='22023'; END IF;
 -- The original producing execution predates the saved content UUID. Follow its
 -- persisted identity for the selected family only, not independent descendants.
 executions:=executions||ARRAY(SELECT execution_id FROM opc_content_versions
  WHERE actor_id=a AND id=ANY(content_ids) AND execution_id IS NOT NULL);
 -- Independent saved descendants stay intact, while their copied source contexts are invalidated.
 WITH RECURSIVE descendants(id) AS (
  SELECT id FROM opc_content_versions WHERE id=ANY(content_ids)
  UNION SELECT c.id FROM opc_content_versions c JOIN descendants d ON c.source_content_id=d.id WHERE c.actor_id=a
 ) SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO refs FROM descendants;
 refs:=refs||executions||sessions||projects||versions||content_ids||
  ARRAY(SELECT id FROM artifact_evidence WHERE project_id=ANY(projects))||
  ARRAY(SELECT operation_id FROM artifact_evidence WHERE project_id=ANY(projects) AND operation_id IS NOT NULL)||
  ARRAY(SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=ANY(projects))||
  ARRAY(SELECT conversation_id FROM artifact_chats WHERE project_id=ANY(projects))||
  ARRAY(SELECT work_item_id FROM opc_items WHERE source_version_id=ANY(versions))||
  ARRAY(SELECT session_id FROM opc_topic_workspaces WHERE actor_id=a AND source_version_id=ANY(versions))||ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 -- CORE-PATH-V2 V2-12 F: the executions are only the ids a saved version still names (rows of other tables keep them as plain values).
 -- CORE-PATH-V2 V2-10b C2: the turns of the same dependency, by what a turn can hold: the producing turn of a selected version, a turn
 -- given a script as material (any turn that read a claimed revision) or as source, every turn of a conversation in scope; then
 -- every later turn of those conversations, whose history held the reply.
 turn_ids:=ARRAY(SELECT t.id FROM turns t WHERE t.actor_id=a AND (t.session_id=ANY(sessions)
   OR t.id IN (SELECT c.turn_id FROM opc_content_versions c WHERE c.actor_id=a AND c.id=ANY(content_ids) AND c.turn_id IS NOT NULL)
   OR t.request_id IN (SELECT b.request_id FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.source_script_id=ANY(refs))
   OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.session_id=t.session_id AND b.source_script_id=ANY(refs)
    AND b.material_revision::text=t.policy#>>'{workMaterial,revision}')
   OR t.policy#>>'{workSource,contentId}'=ANY(refs::text[])
   -- CONTENT-CONVERSATION-2 (0532): a topic-window turn given a script or storyboard among its sources.
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.policy->'workSources')='array' THEN t.policy->'workSources' ELSE '[]'::jsonb END) e WHERE e->>'contentId'=ANY(refs::text[]))
   OR t.session_id IN (SELECT rs.id FROM runtime_sessions rs WHERE rs.actor_id=a AND content_erasure_references(rs.scope,refs)))
  ORDER BY t.id);
 -- A resumed turn's raw responses before the pause are on the turns it continues.
 WITH RECURSIVE chain(id,resume_of) AS (SELECT t.id,t.resume_of FROM turns t WHERE t.actor_id=a AND t.id=ANY(turn_ids)
   UNION SELECT p.id,p.resume_of FROM chain c JOIN turns p ON p.actor_id=a AND p.id=c.resume_of)
 SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO turn_ids FROM chain;
 turn_ids:=ARRAY(SELECT t.id FROM turns t WHERE t.actor_id=a AND EXISTS(SELECT 1 FROM turns src
   WHERE src.actor_id=a AND src.id=ANY(turn_ids) AND src.session_id=t.session_id AND src.id<=t.id) ORDER BY t.id);
 SELECT count(*) INTO preserved FROM opc_content_versions c0 WHERE c0.actor_id=a AND c0.erased_at IS NULL
  AND NOT c0.id=ANY(content_ids) AND (c0.execution_id=ANY(executions) OR c0.turn_id=ANY(turn_ids) OR c0.source_content_id=ANY(content_ids));
 preserved:=preserved+(SELECT count(*) FROM artifact_versions v WHERE NOT v.project_id=ANY(projects)
  AND EXISTS(SELECT 1 FROM artifact_projects p0 WHERE p0.id=v.project_id AND p0.actor_id=a)
  AND (EXISTS(SELECT 1 FROM artifact_work_references r WHERE r.project_id=v.project_id AND r.source_version_id=ANY(versions))
   OR EXISTS(SELECT 1 FROM opc_result_links l WHERE l.round_id=v.round_id AND l.execution_id=ANY(executions))
   -- CORE-PATH-V2 V2-7a2: the same for a report finalized from a turn of these conversations.
   OR EXISTS(SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id
    WHERE l.round_id=v.round_id AND t.actor_id=a AND t.session_id=ANY(sessions))));
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id) ORDER BY kind,id),'[]') INTO dependents FROM (
  SELECT 'account' kind,p.project_id id FROM opc_accounts p WHERE p.actor_id=a AND p.source_version_id=ANY(versions)
  UNION SELECT 'work_item',i.work_item_id FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
   WHERE p.actor_id=a AND i.source_version_id=ANY(versions)
  UNION SELECT 'reference',r.project_id FROM artifact_work_references r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.source_version_id=ANY(versions)
  UNION SELECT 'content',c.id FROM opc_content_versions c WHERE c.actor_id=a AND NOT c.id=ANY(content_ids)
   AND (c.execution_id=ANY(executions) OR c.turn_id=ANY(turn_ids) OR c.id=ANY(refs))
 ) affected;
 -- Canonical sets make the preview hash independent of query plans and physical row order.
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO sessions FROM unnest(sessions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO executions FROM unnest(executions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO projects FROM unnest(projects) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO versions FROM unnest(versions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO content_ids FROM unnest(content_ids) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO refs FROM unnest(refs) id WHERE id IS NOT NULL;
 RETURN jsonb_build_object('kind',k,'id',target,'alreadyDeleted',deleted,
  'sessions',to_jsonb(sessions),'executions',to_jsonb(executions),'turns',to_jsonb(turn_ids),'projects',to_jsonb(projects),
  'versions',to_jsonb(versions),'contents',to_jsonb(content_ids),'references',to_jsonb(refs),
  'affectedSources',dependents,'preservedSavedVersions',preserved,
  'dataEvents',coalesce((SELECT jsonb_agg(jsonb_build_array(request_id,item_key,created_at) ORDER BY request_id,item_key)
   FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(executions) OR project_id=ANY(projects)
    OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
    OR target_project_id=ANY(projects) OR source_version_id=ANY(versions))),'[]'::jsonb));
END $function$;;

CREATE OR REPLACE FUNCTION public.opc_topic_read(p_actor_id uuid, p_draft_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;w opc_topic_workspaces;o opc_topic_openings;v artifact_versions;ordinal integer;acct uuid;
BEGIN
 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
 result:=opc_topic_read_before_opening(p_actor_id,p_draft_id);
 IF NOT (result->>'bound')::boolean THEN RETURN result;END IF;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO v FROM artifact_versions WHERE id=w.source_version_id;
 SELECT * INTO o FROM opc_topic_openings WHERE draft_id=p_draft_id;
 -- CONTENT-CONVERSATION-2 (0532): the version shown to the user is the one the library rail and the strategy history show, its
 -- ordinal in an account's strategy history (opc_account_strategy_history 'version'), not the project's publish counter: staging
 -- validation batch 6 saw "绑定 v10" here against "当前 v9" in the rail. The first account of this user whose history holds the bound
 -- version gives it; an account that cannot be read is skipped. With none, the count of allowed versions of the bound version's
 -- project up to it (the shared part of every account's history).
 FOR acct IN SELECT a.project_id FROM opc_accounts a WHERE a.actor_id=p_actor_id ORDER BY a.project_id LOOP
  BEGIN
   SELECT (h->>'version')::integer INTO ordinal FROM jsonb_array_elements(opc_account_strategy_history(p_actor_id,acct)) h
    WHERE h->>'id'=w.source_version_id::text;
  EXCEPTION WHEN OTHERS THEN ordinal:=NULL;
  END;
  EXIT WHEN ordinal IS NOT NULL;
 END LOOP;
 IF ordinal IS NULL AND v.id IS NOT NULL THEN
  SELECT count(*)::integer INTO ordinal FROM artifact_versions x WHERE x.project_id=v.project_id
   AND (x.created_at,x.id)<=(v.created_at,v.id) AND opc_source_allowed(p_actor_id,x.id);
 END IF;
 RETURN result||jsonb_build_object('sourceRoundId',v.round_id,'sourceVersion',ordinal,
  'opening',CASE WHEN o.request_id IS NOT NULL THEN jsonb_build_object('draftId',p_draft_id,'requestId',o.request_id,'input',o.input,'executionId',(SELECT t.request_id FROM turns t WHERE t.actor_id=p_actor_id AND t.session_id=w.session_id AND t.request_id=o.request_id)) ELSE NULL END);
END $function$;;

COMMIT;
