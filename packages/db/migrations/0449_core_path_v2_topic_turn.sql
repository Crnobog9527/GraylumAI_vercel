-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-10b B (provisional number 0446, applied after A's migration; the controller sets the final one; functions rebuilt
-- whole on their text as staging has it after 0445): the topic workspace on the turn path. A topic turn is kind=chat in the workspace's
-- conversation (one metered call, the ordinary start threshold; turn_open is unchanged). Its saved reply feeds the topic draft and
-- the adoption, which only knew executions. As for a report (0429, 0432), the page's handle stays one uuid: an execution id, or a
-- turn's request id.
--   opc_data_events        takes a turn as its source: turn_actor_id, turn_id, execution_id nullable, exactly one source
--   opc_data_turn          the turn counterpart of opc_data_execution: a completed, delivered chat turn the actor can still read
--   opc_data_source_turn   the turn a handle names, NULL when it names an old execution (or nothing)
--   opc_data_event_source  a data event's handle, whichever source it has
--   opc_data_event_guard, opc_topic_original, opc_topic_draft_from_execution, opc_adopt_topics_with_source, opc_topic_read
--                          accept either source; old rows and old requests behave exactly as before
--   content_erasure_scope, _mark_session, _confirm
--                          a conversation's turn events and topic drafts are erased like its execution's
--   turn_open, runtime_admit, runtime_admit_commit
--                          one request id on one path only while both exist: each refuses, under the conversation's lock, a request the
--                          other holds (turn_open for a topic turn, the old admission for any turn), so no retry pays twice
--   turn_session_view      each message names its turn's request id, the page's handle of a reply
--   topic_turn_source      what a topic turn reads before it opens, on the read client (the old prepareTopicTurn checks: writable,
--                          bound workspace, allowed source, the Skill resources, the frozen material)
-- Compatibility: old code reads execution_id only and ignores turn rows, and nothing writes one until the page switches.
-- Repeatable: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS and CREATE OR REPLACE throughout.
-- Recovery (forward only): keep the columns and the nullable execution_id; re-apply the previous full function texts from
-- packages/db/functions. Turn rows are then ignored and nothing is lost; never delete event rows to recover.
-- Retention: the event holds its turn with ON DELETE NO ACTION; events go with the content they describe (content and account
-- erasure delete them), and the future turns retention job must handle them first, as opc_result_links.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.opc_data_events ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.opc_data_events ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE public.opc_data_events DROP CONSTRAINT IF EXISTS opc_data_events_turn_fkey;
ALTER TABLE public.opc_data_events ADD CONSTRAINT opc_data_events_turn_fkey FOREIGN KEY (turn_actor_id, turn_id)
  REFERENCES public.turns(actor_id, id) ON DELETE NO ACTION;
ALTER TABLE public.opc_data_events DROP CONSTRAINT IF EXISTS opc_data_events_one_source;
ALTER TABLE public.opc_data_events ADD CONSTRAINT opc_data_events_one_source CHECK
  ((execution_id IS NOT NULL AND turn_actor_id IS NULL AND turn_id IS NULL)
   OR (execution_id IS NULL AND turn_actor_id IS NOT NULL AND turn_id IS NOT NULL));
CREATE INDEX IF NOT EXISTS opc_data_events_turn ON public.opc_data_events(turn_id) WHERE turn_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.opc_data_source_turn(a uuid, eid uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT t.id FROM turns t WHERE t.actor_id=a AND t.request_id=eid AND t.kind='chat'
  AND NOT EXISTS(SELECT 1 FROM runtime_executions e WHERE e.id=eid AND e.actor_id=a)
$function$;

CREATE OR REPLACE FUNCTION public.opc_data_event_source(e opc_data_events)
 RETURNS uuid
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce(e.execution_id,(SELECT t.request_id FROM turns t WHERE t.actor_id=e.turn_actor_id AND t.id=e.turn_id))
$function$;

CREATE OR REPLACE FUNCTION public.opc_data_turn(a uuid, rid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns;s runtime_sessions;body text;tomb jsonb;
BEGIN
 PERFORM 1 FROM profiles WHERE id=a FOR SHARE;
 PERFORM bill2_actor(a);
 SELECT * INTO t FROM turns WHERE actor_id=a AND request_id=rid AND kind='chat';
 IF t.id IS NULL THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=t.session_id AND actor_id=a FOR SHARE;
 tomb:=turn_tombstones(a,t.session_id,'{}'::jsonb);
 IF s.id IS NULL OR t.state<>'closed' OR t.close_kind<>'completed' OR NOT t.delivered
  OR s.content_deleted_at IS NOT NULL OR (tomb->>'sessionTombstoned')::boolean OR (tomb->>'accountErasing')::boolean
  OR NOT coalesce(bill2_scope_allowed(a,s.scope),false) THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 SELECT m.content INTO body FROM session_messages m
  WHERE m.session_id=t.session_id AND m.turn_id=t.id AND m.role='assistant' AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 1;
 RETURN jsonb_build_object('turnId',t.id,'sessionId',t.session_id,'body',body);
END $function$;

CREATE OR REPLACE FUNCTION public.topic_turn_source(p_actor_id uuid, p_draft_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts;w opc_topic_workspaces;r artifact_rounds;m runtime_scope_material;
BEGIN
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 -- An archived business is read-only (0324), a deleted conversation's draft too (0249), as opc_topic_material; without its row locks.
 IF EXISTS(SELECT 1 FROM opc_draft_businesses db JOIN opc_businesses b ON b.id=db.business_id AND b.actor_id=p_actor_id
   WHERE db.draft_id=d.draft_id AND b.archived_at IS NOT NULL) THEN RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED';END IF;
 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501';END IF;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF w.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 IF NOT opc_source_allowed(p_actor_id,w.source_version_id) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_REVOKED';END IF;
 -- The same request admitted on the old path (a page switched mid-request): never a second charge. V2-12 drops this.
 IF EXISTS(SELECT 1 FROM runtime_executions e WHERE e.actor_id=p_actor_id AND e.request_id=p_request_id) THEN
  RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=w.session_id AND revision=w.material_revision;
 IF m.session_id IS NULL OR m.revoked THEN RAISE EXCEPTION 'OPC_TOPIC_MATERIAL_MISSING';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=(SELECT round_id FROM artifact_versions WHERE id=w.source_version_id);
 IF r.id IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_UNBOUND';END IF;
 IF jsonb_typeof(r.workflow->'planResources') IS DISTINCT FROM 'array' OR jsonb_array_length(r.workflow->'planResources')=0 THEN
  RAISE EXCEPTION 'OPC_TOPIC_SKILL_MISSING';END IF;
 RETURN jsonb_build_object('sessionId',w.session_id,'moduleId',w.module_id,'skillId',w.skill_id,'revisionId',w.revision_id,
  'packageHash',r.package_hash,'resources',r.workflow->'planResources','sourceVersionId',w.source_version_id,
  'material',jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash,'content',m.content));
END $function$;

CREATE OR REPLACE FUNCTION public.opc_data_event_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'OPC_DATA_IMMUTABLE';END IF;
 IF NEW.turn_id IS NOT NULL THEN PERFORM opc_data_turn(NEW.actor_id,opc_data_event_source(NEW));
 ELSE PERFORM opc_data_execution(NEW.actor_id,NEW.execution_id); END IF;
 IF NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM artifact_projects
  WHERE id=NEW.project_id AND actor_id=NEW.actor_id AND erased_at IS NULL AND content_deleted_at IS NULL)
 THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_topic_original(a uuid, did uuid, vid uuid, eid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e runtime_executions;w opc_topic_workspaces;d opc_drafts;raw text;part text[];candidate jsonb;result jsonb;source_turn jsonb;source_session uuid;
BEGIN
 -- CORE-PATH-V2 V2-10b: eid is an old execution, or a turn path topic turn's request id (the page's handle, as for a report).
 IF opc_data_source_turn(a,eid) IS NULL THEN
  e:=opc_data_execution(a,eid);source_session:=e.session_id;raw:=coalesce(e.result->>'body',e.primary_result->>'body');
 ELSE
  source_turn:=opc_data_turn(a,eid);source_session:=(source_turn->>'sessionId')::uuid;raw:=source_turn->>'body';
 END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=did AND actor_id=a;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=did AND actor_id=a;
 IF d.draft_id IS NULL OR w.session_id IS DISTINCT FROM source_session OR w.source_version_id IS DISTINCT FROM vid
  OR NOT opc_source_allowed(a,vid) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 IF raw IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 FOR part IN SELECT regexp_matches(raw,'```(?:json)?\s*(\[[\s\S]*?\])\s*```','g') LOOP
  BEGIN
   candidate:=part[1]::jsonb;
   IF jsonb_typeof(candidate)='array' AND jsonb_array_length(candidate) BETWEEN 1 AND 28 THEN result:=candidate;END IF;
  EXCEPTION WHEN invalid_text_representation THEN NULL;END;
 END LOOP;
 BEGIN
  candidate:=btrim(raw)::jsonb;
  IF jsonb_typeof(candidate)='array' AND jsonb_array_length(candidate) BETWEEN 1 AND 28 THEN result:=candidate;END IF;
 EXCEPTION WHEN invalid_text_representation THEN NULL;END;
 IF result IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(result) x
  WHERE jsonb_typeof(x)<>'object' OR coalesce(x->>'id','')!~*'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR nullif(btrim(x->>'title'),'') IS NULL OR nullif(btrim(x->>'brief'),'') IS NULL)
  OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(result) x)<>jsonb_array_length(result)
 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_topic_draft_from_execution(p_actor_id uuid, p_draft_id uuid, p_request_id uuid, p_expected_version bigint, p_source_version_id uuid, p_execution_id uuid, p_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE original jsonb;result jsonb;prior opc_data_events;project uuid;source_turn bigint;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id)); END IF;

 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
 original:=opc_topic_original(p_actor_id,p_draft_id,p_source_version_id,p_execution_id);
 source_turn:=opc_data_source_turn(p_actor_id,p_execution_id);
 SELECT project_id INTO project FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 PERFORM 1 FROM artifact_projects WHERE id=project FOR UPDATE;
 IF jsonb_typeof(p_body) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_body) x
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(original) o WHERE o->>'id'=x->>'id'))
 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 SELECT * INTO prior FROM opc_data_events WHERE actor_id=p_actor_id AND request_id=p_request_id AND item_key='';
 IF FOUND AND (prior.action<>'topic_draft' OR opc_data_event_source(prior)<>p_execution_id OR prior.project_id<>project
  OR prior.source_version_id<>p_source_version_id OR prior.adopted IS DISTINCT FROM p_body)
 THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 result:=opc_topic_draft_save(p_actor_id,p_draft_id,p_request_id,p_expected_version,p_source_version_id,p_body);
 IF prior.request_id IS NULL THEN
  INSERT INTO opc_data_events(actor_id,request_id,item_key,action,execution_id,turn_actor_id,turn_id,project_id,source_version_id,original,adopted)
  VALUES(p_actor_id,p_request_id,'','topic_draft',CASE WHEN source_turn IS NULL THEN p_execution_id END,
   CASE WHEN source_turn IS NOT NULL THEN p_actor_id END,source_turn,project,p_source_version_id,original,p_body);
 END IF;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_adopt_topics_with_source(p_actor_id uuid, p_draft_id uuid, p_request_id uuid, p_expected_version bigint, p_source_version_id uuid, p_body jsonb, p_accounts jsonb, p_sources jsonb DEFAULT NULL::jsonb, p_source_draft_version_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE item jsonb;original jsonb;eid uuid;ids uuid[];project uuid;result jsonb;bound jsonb:='[]';prior opc_data_events;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id)); END IF;

 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
 PERFORM 1 FROM profiles WHERE id=p_actor_id FOR SHARE;PERFORM bill2_actor(p_actor_id);
 -- Same actor lock as the existing adoption RPC, before project locking.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text,107));
 SELECT project_id INTO project FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF project IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 IF jsonb_typeof(p_body) IS DISTINCT FROM 'array' OR jsonb_array_length(p_body) NOT BETWEEN 1 AND 28
 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 IF p_sources IS NOT NULL AND (jsonb_typeof(p_sources) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_sources)<>jsonb_array_length(p_body)
  OR (SELECT count(DISTINCT x->>'itemId') FROM jsonb_array_elements(p_sources) x)<>jsonb_array_length(p_body)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources) x WHERE x-ARRAY['itemId','executionId']<>'{}'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_body) i WHERE i->>'id'=x->>'itemId')))
 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_body) LOOP
  SELECT * INTO prior FROM opc_data_events WHERE actor_id=p_actor_id AND request_id=p_request_id AND item_key=item->>'id';
  IF p_sources IS NOT NULL THEN
   SELECT (x->>'executionId')::uuid INTO eid FROM jsonb_array_elements(p_sources) x WHERE x->>'itemId'=item->>'id';
  ELSIF p_source_draft_version_id IS NULL AND prior.request_id IS NOT NULL THEN eid:=opc_data_event_source(prior);
  ELSE
   -- Bind the submitted immutable draft identity even after another tab saves a revision.
   -- Old requests without identity must prove a unique source across history or fail closed.
   WITH submitted AS (
    SELECT * FROM opc_topic_draft_versions WHERE actor_id=p_actor_id AND draft_id=p_draft_id
     AND (p_source_draft_version_id IS NULL OR id=p_source_draft_version_id)
   )
   SELECT array_agg(DISTINCT candidate.id) INTO ids FROM (
    SELECT opc_data_event_source(event) AS id FROM submitted v JOIN opc_data_events event ON event.request_id=v.request_id
    WHERE event.actor_id=p_actor_id AND event.project_id=project AND event.source_version_id=p_source_version_id
     AND event.action='topic_draft' AND v.erased_at IS NULL AND v.source_version_id=p_source_version_id
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.body) o WHERE o->>'id'=item->>'id')
    UNION
    -- Before R9 the client already used execution UUID as its save request UUID.
    SELECT e.id FROM submitted v JOIN runtime_executions e ON e.id=v.request_id
     JOIN opc_topic_workspaces w ON w.draft_id=v.draft_id AND w.session_id=e.session_id
    WHERE e.actor_id=p_actor_id AND v.source_version_id=p_source_version_id
     AND v.erased_at IS NULL AND e.state='completed' AND runtime_history_available(e.id)
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.body) o WHERE o->>'id'=item->>'id')
   ) candidate;
   IF cardinality(ids) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_REQUIRED';END IF;
   eid:=ids[1];
  END IF;
  original:=opc_topic_original(p_actor_id,p_draft_id,p_source_version_id,eid);
  SELECT o INTO original FROM jsonb_array_elements(original) o WHERE o->>'id'=item->>'id';
  IF original IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
  IF prior.request_id IS NOT NULL AND (prior.action<>'topic_adoption' OR prior.project_id<>project
   OR opc_data_event_source(prior)<>eid OR prior.adopted IS DISTINCT FROM item OR prior.source_version_id<>p_source_version_id)
  THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  bound:=bound||jsonb_build_array(jsonb_build_object('executionId',eid,'turnId',opc_data_source_turn(p_actor_id,eid),'original',original,'adopted',item));
 END LOOP;
 result:=opc_adopt_topics(p_actor_id,p_draft_id,p_request_id,p_expected_version,p_source_version_id,p_body,p_accounts);
 FOR item IN SELECT value FROM jsonb_array_elements(bound) LOOP
  INSERT INTO opc_data_events(actor_id,request_id,item_key,action,execution_id,turn_actor_id,turn_id,project_id,target_project_id,
   source_version_id,original,adopted)
  SELECT p_actor_id,p_request_id,item#>>'{adopted,id}','topic_adoption',
   CASE WHEN item->>'turnId' IS NULL THEN (item->>'executionId')::uuid END,
   CASE WHEN item->>'turnId' IS NOT NULL THEN p_actor_id END,(item->>'turnId')::bigint,project,
   i.work_item_id,p_source_version_id,item->'original',item->'adopted'
  FROM opc_items i WHERE i.plan_id=(result->>'planId')::uuid AND i.item_key=(item#>>'{adopted,id}')::uuid
  ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_topic_read(p_actor_id uuid, p_draft_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;w opc_topic_workspaces;o opc_topic_openings;v artifact_versions;
BEGIN
 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
 result:=opc_topic_read_before_opening(p_actor_id,p_draft_id);
 IF NOT (result->>'bound')::boolean THEN RETURN result;END IF;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO v FROM artifact_versions WHERE id=w.source_version_id;
 SELECT * INTO o FROM opc_topic_openings WHERE draft_id=p_draft_id;
 RETURN result||jsonb_build_object('sourceRoundId',v.round_id,'sourceVersion',v.version,
  'opening',CASE WHEN o.request_id IS NOT NULL THEN jsonb_build_object('draftId',p_draft_id,'requestId',o.request_id,'input',o.input,'executionId',coalesce((SELECT e.id FROM runtime_executions e WHERE e.session_id=w.session_id AND e.request_id=o.request_id),
   (SELECT t.request_id FROM turns t WHERE t.actor_id=p_actor_id AND t.session_id=w.session_id AND t.request_id=o.request_id))) ELSE NULL END);
END $function$;

CREATE OR REPLACE FUNCTION public.content_erasure_scope(a uuid, k text, target uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 erasure preview

DECLARE sessions uuid[]:='{}'; executions uuid[]:='{}'; projects uuid[]:='{}'; versions uuid[]:='{}';
 content_ids uuid[]:='{}'; refs uuid[]:='{}';
 root_e runtime_executions;root_s runtime_sessions;root_p artifact_projects;root_c opc_content_versions;
 deleted boolean:=false;more uuid[];n integer;preserved bigint;dependents jsonb;
BEGIN
 IF a IS NULL OR target IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF k='answer' THEN
  SELECT * INTO root_e FROM runtime_executions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  executions:=ARRAY[root_e.id];deleted:=root_e.content_deleted_at IS NOT NULL OR root_e.erased_at IS NOT NULL;
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
 executions:=ARRAY(SELECT DISTINCT ex.id FROM runtime_executions ex WHERE ex.actor_id=a AND
  (ex.id=ANY(executions) OR ex.session_id=ANY(sessions) OR content_erasure_references(ex.payload,refs)
   -- A2 injected source
   OR content_erasure_references(ex.injected_source,refs)
   OR EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=ex.session_id AND content_erasure_references(rs.scope,refs))
   -- 0218 workspace tool copies
   OR EXISTS(SELECT 1 FROM runtime_tool_calls tc WHERE tc.execution_id=ex.id AND tc.name IN ('read_source','read_history') AND content_erasure_references(tc.result,refs))
   -- 0228 read_history copies
   OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.source_script_id=ANY(refs)
    AND b.session_id=ex.session_id AND b.request_id=ex.request_id)
   -- ERASE-SPEED material key: read once per execution (OFFSET 0 keeps it from being re-read per material row).
   OR EXISTS(SELECT 1 FROM (SELECT ex.payload#>>'{scopeMaterial,sessionId}' sid,ex.payload#>>'{scopeMaterial,revision}' rev
     OFFSET 0) k
    JOIN runtime_scope_material mat ON mat.session_id=CASE WHEN k.sid ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     THEN k.sid::uuid END AND mat.session_id::text=k.sid AND mat.revision::text=k.rev WHERE
    (mat.request_id=ANY(refs) OR content_erasure_references(mat.request,refs) OR content_erasure_references(mat.content,refs)
     OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.session_id=mat.session_id
      AND b.material_revision=mat.revision AND b.source_script_id=ANY(refs)))
    )));
 -- Exact dependency closure; UNION bounds malformed cycles.
 LOOP
  n:=cardinality(executions);
  more:=ARRAY(SELECT DISTINCT ex.id FROM runtime_executions ex WHERE ex.actor_id=a AND
   (EXISTS(SELECT 1 FROM runtime_history_dependencies d WHERE d.execution_id=ex.id AND d.dependency_id=ANY(executions))
    OR content_erasure_references(ex.payload,executions)
    OR EXISTS(SELECT 1 FROM runtime_executions src WHERE src.id=ANY(executions)
     AND src.actor_id=a AND src.session_id=ex.session_id AND (src.created_at,src.id)<(ex.created_at,ex.id)
     AND content_erasure_capture_copy(ex.payload,src.result))));
  executions:=ARRAY(SELECT DISTINCT x FROM unnest(executions||more) x ORDER BY x);
  EXIT WHEN cardinality(executions)=n;
 END LOOP;
 SELECT count(*) INTO preserved FROM opc_content_versions c0 WHERE c0.actor_id=a AND c0.erased_at IS NULL
  AND NOT c0.id=ANY(content_ids) AND (c0.execution_id=ANY(executions) OR c0.source_content_id=ANY(content_ids));
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
   AND (c.execution_id=ANY(executions) OR c.id=ANY(refs))
 ) affected;
 -- Canonical sets make the preview hash independent of query plans and physical row order.
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO sessions FROM unnest(sessions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO executions FROM unnest(executions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO projects FROM unnest(projects) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO versions FROM unnest(versions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO content_ids FROM unnest(content_ids) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO refs FROM unnest(refs) id WHERE id IS NOT NULL;
 RETURN jsonb_build_object('kind',k,'id',target,'alreadyDeleted',deleted,
  'sessions',to_jsonb(sessions),'executions',to_jsonb(executions),'projects',to_jsonb(projects),
  'versions',to_jsonb(versions),'contents',to_jsonb(content_ids),'references',to_jsonb(refs),
  'affectedSources',dependents,'preservedSavedVersions',preserved,
  'dataEvents',coalesce((SELECT jsonb_agg(jsonb_build_array(request_id,item_key,created_at) ORDER BY request_id,item_key)
   FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(executions) OR project_id=ANY(projects)
    OR turn_id IN (SELECT t.id FROM turns t WHERE t.actor_id=a AND t.session_id=ANY(sessions))
    OR target_project_id=ANY(projects) OR source_version_id=ANY(versions))),'[]'::jsonb));
END $function$;

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
  AND NOT EXISTS(SELECT 1 FROM opc_data_events d JOIN turns t ON t.actor_id=d.turn_actor_id AND t.id=d.turn_id WHERE t.actor_id=a AND t.session_id=target)
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE l.execution_id=ANY(ids))
  AND NOT EXISTS(SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id WHERE t.actor_id=a AND t.session_id=target)
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

CREATE OR REPLACE FUNCTION public.turn_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text, p_policy jsonb, p_resume_of bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s runtime_sessions; t turns; prof profiles; existing turns;
  v_day date := (now() AT TIME ZONE 'UTC')::date; v_bucket smallint; total numeric; band numeric;
  u_turn numeric; g integer; h integer; available integer; hold uuid; frozen jsonb; history jsonb;
  carried integer := 0;
BEGIN
  IF p_kind NOT IN ('chat','mentor','report','plan','compare','jury','jury_adopt','review') THEN
    RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_policy) <> 'object'
    OR jsonb_typeof(p_policy->'q') <> 'number' OR (p_policy->>'q')::numeric <= 0
    OR jsonb_typeof(p_policy->'uTurnUsd') <> 'number' OR (p_policy->>'uTurnUsd')::numeric < 0
    OR jsonb_typeof(p_policy->'gCredits') <> 'number' OR (p_policy->>'gCredits')::numeric <> floor((p_policy->>'gCredits')::numeric)
    OR (p_policy->>'gCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'minCredits') <> 'number' OR (p_policy->>'minCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'historyItems') <> 'number' OR (p_policy->>'historyItems')::numeric NOT BETWEEN 0 AND 200
    OR jsonb_typeof(p_policy->'limits') <> 'object'
    OR coalesce((p_policy->'limits'->>'model')::numeric, 0) < 1
    OR coalesce((p_policy->'limits'->>'paidTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'freeTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'decisions')::numeric, 0) < 0
    OR jsonb_typeof(p_policy->'stopLoss') <> 'object'
    OR coalesce((p_policy->'stopLoss'->>'limitUsd')::numeric, 0) <= 0
    OR coalesce((p_policy->'stopLoss'->>'p')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'poolSize')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'uFastUsd')::numeric, -1) < 0
    OR coalesce((p_policy->'stopLoss'->>'uBigUsd')::numeric, -1) < 0
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits','carriedCredits'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;

  -- 1. The account row first, then the session: one turn at a time per conversation (3a). The account comes first as in the
  -- erasure functions (they hold it before the session), so an open and a deletion of the same conversation never deadlock.
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  -- 2. The same request again: the turn it opened, unchanged.
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.session_id IS DISTINCT FROM p_session_id OR existing.kind <> p_kind
      OR existing.resume_of IS DISTINCT FROM p_resume_of THEN
      RAISE EXCEPTION 'TURN_REQUEST_CONFLICT' USING ERRCODE='22023';
    END IF;
    -- A replay reads the history too: a deleted conversation or an erasing account is refused here as for a new request,
    -- so the same old request can never read back deleted content (as runtime_session_context).
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    t := existing;
  ELSE
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    IF p_resume_of IS NULL THEN
      -- A jury (or its adoption) runs on the report's draft conversation without occupying it (V2-7b): the conversation stays
      -- usable while a review advances or waits, as before; one review per user is the review record's own rule.
      IF s.active_turn_id IS NOT NULL AND p_kind NOT IN ('jury','jury_adopt') THEN RAISE EXCEPTION 'TURN_SESSION_BUSY' USING ERRCODE='55P03'; END IF;
      -- V2-5c: the mentor's read before this turn is bound to it: a turn that closed since then makes that read stale (it could pay
      -- again for what that turn fetched, or use a grant it spent). Under this session's lock, so no close can slip in after it.
      IF p_kind = 'mentor' AND p_policy->'mentor'->>'preparedAt' IS NOT NULL AND EXISTS (SELECT 1 FROM turns x
          WHERE x.actor_id = p_actor_id AND x.session_id = p_session_id AND x.closed_at > (p_policy->'mentor'->>'preparedAt')::timestamptz) THEN
        RAISE EXCEPTION 'TURN_PREPARE_STALE' USING ERRCODE='55P03';
      END IF;
      -- V2-10b: a topic turn's request id admitted on the old path, under this session's lock (runtime_admit refuses the other way).
      -- V2-12 drops this with the old table.
      IF p_kind = 'chat' AND p_policy ? 'topic' AND EXISTS (SELECT 1 FROM runtime_executions e
          WHERE e.actor_id = p_actor_id AND e.request_id = p_request_id) THEN
        RAISE EXCEPTION 'TURN_TOPIC_REQUEST_CONFLICT' USING ERRCODE='22023';
      END IF;
    ELSE
      -- Resume (V2-8): the paused turn is checked, locked and priced by turn_resume_carry.
      carried := public.turn_resume_carry(p_actor_id, p_session_id, s.active_turn_id, p_resume_of, p_kind, p_policy);
    END IF;
    -- The same account check as bill2_actor: active and not deleted.
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
    END IF;

    -- 3. Stop-loss (2.5.1): reserve U_turn on the own bucket row first, then read the day's sum, then check with the band B.
    -- On a resume the paused turn's reservation is still counted here (it is released by its close below): refusing earlier,
    -- never later.
    IF (p_policy->'stopLoss'->>'p')::int < (p_policy->'stopLoss'->>'poolSize')::int THEN
      RAISE EXCEPTION 'TURN_STOP_LOSS_CONFIG' USING ERRCODE='22023';
    END IF;
    u_turn := (p_policy->>'uTurnUsd')::numeric;
    v_bucket := CASE WHEN p_kind IN ('report','compare','jury','jury_adopt') THEN -1 ELSE abs(hashtext(p_actor_id::text)) % 16 END;
    INSERT INTO daily_spend AS d (day, bucket, reserved_usd) VALUES (v_day, v_bucket, u_turn)
      ON CONFLICT (day, bucket) DO UPDATE SET reserved_usd = d.reserved_usd + excluded.reserved_usd;
    SELECT sum(reserved_usd + spent_usd) INTO total FROM daily_spend WHERE daily_spend.day = v_day;
    band := ((p_policy->'stopLoss'->>'p')::numeric - 1) * (p_policy->'stopLoss'->>'uFastUsd')::numeric
      + (p_policy->'stopLoss'->>'uBigUsd')::numeric;
    IF total + band > (p_policy->'stopLoss'->>'limitUsd')::numeric THEN
      RAISE EXCEPTION 'STOP_LOSS_REACHED' USING ERRCODE='P0001';
    END IF;

    -- The paused turn closes before the new freeze is sized: its whole freeze comes back (refund_all; what it would have charged
    -- is carried above) and counts in the balance read below. Its receipts stay its own for the stop-loss. Not delivered, no
    -- messages: the turn that continues it saves the conversation.
    IF p_resume_of IS NOT NULL THEN
      PERFORM public.turn_resume_close(p_actor_id, p_resume_of, carried);
    END IF;

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The balance is read under the
    -- account lock taken first: two sessions of one account in different stop-loss buckets never size H on the same balance.
    -- The account is checked again here (same lock) before anything is frozen.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    -- The freeze covers the carried credits too (the continuation settles them).
    IF p_kind = 'report' THEN PERFORM public.turn_report_admit(p_actor_id, p_session_id, p_policy); END IF;
    g := (p_policy->>'gCredits')::int + carried;
    available := greatest(public.credit_available(p_actor_id), 0);
    -- The balance, not the freeze, is held against the start threshold L (as bill2_payg_claim): a balance that covers one
    -- normal turn starts it, and the freeze H may be below L when one call's bound G is (Owner 10-28, restating 10-01).
    -- On a resume the carried credits are owed already: the balance left after them must still cover one normal turn.
    IF available - carried < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    h := least(g, available);
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h)
      || CASE WHEN carried > 0 THEN jsonb_build_object('carriedCredits', carried) ELSE '{}'::jsonb END;
    INSERT INTO turns (actor_id, session_id, request_id, kind, state, resume_of, policy, reserved_credits, reserved_usd, input_bytes)
      -- reserved_credits is the freeze this turn's calls may use (turn_call_begin pauses on it); the carried part is added back
      -- at the close (turn_close), and the hold itself is the whole H (policy.heldCredits).
      VALUES (p_actor_id, p_session_id, p_request_id, p_kind, 'running', p_resume_of, frozen, h - carried, u_turn,
        (p_policy->>'inputBytes')::int)
      RETURNING * INTO t;
    IF p_kind NOT IN ('jury','jury_adopt') THEN UPDATE runtime_sessions SET active_turn_id = t.id WHERE id = s.id; END IF;
  END IF;

  -- 5. The visible history, newest N in order.
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'content', m.content, 'contentHash', m.content_hash)
    ORDER BY m.seq), '[]'::jsonb) INTO history
  FROM (SELECT seq, role, content, content_hash FROM session_messages
        WHERE session_id = p_session_id AND visible AND deleted_at IS NULL
        ORDER BY seq DESC LIMIT (t.policy->>'historyItems')::int) m;
  -- 6. What the turn's prompt needs from the account, read here instead of in more round trips: the reply language and, for a
  -- free chat, the positioning gate (confirmed positioning; refusals in 24 hours, counted on the turns refused for it).
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'replay', existing.id IS NOT NULL,
    'reservedCredits', t.reserved_credits, 'reservedUsd', t.reserved_usd, 'history', history, 'resumeOf', t.resume_of,
    'replyLanguage', prof.reply_language,
    'positioning', CASE WHEN p_kind = 'chat' THEN jsonb_build_object(
      'positioned', public.turn_positioned(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', CASE p_kind WHEN 'mentor' THEN public.turn_mentor_context(p_actor_id, p_session_id, p_policy->'mentor')
      WHEN 'plan' THEN public.turn_plan_context(p_actor_id, p_session_id, p_policy) END);
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
 -- CORE-PATH-V2 V2-10b: under this session's lock, as turn_open: a request id the turn path holds is never admitted here too.
 IF EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_actor_id AND t.request_id=p_request_id) THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
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
 -- CORE-PATH-V2 V2-10b: under this session's lock, as turn_open: a request id the turn path holds is never admitted here too.
 IF EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_actor_id AND t.request_id=p_request_id) THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
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

CREATE OR REPLACE FUNCTION public.turn_session_view(p_actor_id uuid, p_session_id uuid, p_after_seq integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions; a turns; l turns;
BEGIN
  -- A disabled or deleted account reads nothing, as every other read (bill2_actor) and turn_open refuse it.
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_actor_id AND status = 'active' AND is_deleted::text = 'false') THEN
    RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
  -- The conversation's whole scope is session_view_allowed, called first by Node (view.ts); a draft revoked since then is refused
  -- here, in the same snapshot as the messages.
  IF s.scope->>'kind' = 'positioning_draft' AND NOT (turn_mentor_draft_allowed(p_actor_id, (s.scope->>'draftId')::uuid)
      AND turn_mentor_source_live((s.scope->>'draftId')::uuid)) THEN
    RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501';
  END IF;
  IF s.active_turn_id IS NOT NULL THEN SELECT * INTO a FROM turns WHERE actor_id = p_actor_id AND id = s.active_turn_id; END IF;
  SELECT * INTO l FROM turns WHERE session_id = p_session_id AND actor_id = p_actor_id AND state = 'closed'
    ORDER BY opened_at DESC LIMIT 1;
  RETURN jsonb_build_object(
    'activeTurn', CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('turnId', a.id, 'kind', a.kind, 'state', a.state,
      'pauseReason', a.pause_reason, 'openedAt', a.opened_at, 'updatedAt', a.updated_at) END,
    'lastTurn', CASE WHEN l.id IS NULL THEN NULL ELSE jsonb_build_object('turnId', l.id, 'kind', l.kind, 'closeKind', l.close_kind,
      'failureCode', l.failure_code, 'settlement', l.settlement, 'chargedCredits', l.charged_credits, 'closedAt', l.closed_at) END,
    'messages', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'turnId', m.turn_id, 'content', m.content,
          -- The page's handle of a topic reply (V2-10b): its turn's request id, what the topic draft and the adoption name.
          'requestId', (SELECT r.request_id FROM turns r WHERE r.actor_id = p_actor_id AND r.id = m.turn_id))
        ORDER BY m.seq), '[]'::jsonb)
      FROM (SELECT seq, role, turn_id, content FROM session_messages
            WHERE session_id = p_session_id AND visible AND deleted_at IS NULL AND seq > greatest(coalesce(p_after_seq, 0), 0)
            ORDER BY seq LIMIT 50) m),
    -- The paid tool calls behind those replies, for the work rows a reload shows again (Owner 10-02): a reply's own turn and the
    -- paused turns it continued. What was asked is the tool call in the model receipt just before; a receipt that holds none
    -- gives null. Owner's key only; nothing is written.
    'calls', (WITH RECURSIVE shown AS (
        SELECT DISTINCT m.turn_id AS reply, m.turn_id AS id FROM (SELECT seq, turn_id FROM session_messages
            WHERE session_id = p_session_id AND visible AND deleted_at IS NULL AND seq > greatest(coalesce(p_after_seq, 0), 0)
            ORDER BY seq LIMIT 50) m
        UNION ALL
        SELECT x.reply, t.resume_of FROM shown x JOIN turns t ON t.actor_id = p_actor_id AND t.id = x.id WHERE t.resume_of IS NOT NULL)
      SELECT coalesce(jsonb_agg(jsonb_build_object('turnId', x.reply, 'seq', c.seq, 'toolName', c.tool_name, 'status', c.status,
          'usage', c.usage, 'q', t.policy->'q', 'multiplier', c.multiplier,
          -- The model call that asked: a benchmark lookup settles in several rows, so not always the row just before.
          -- Along the resume chain: a resumed turn's first real call may follow the model receipt of the turn it continued.
          'arguments', (WITH RECURSIVE up AS (SELECT t.id AS id, 0 AS depth, t.resume_of AS previous
              UNION ALL SELECT p.id, u.depth + 1, p.resume_of FROM up u JOIN turns p ON p.actor_id = p_actor_id AND p.id = u.previous)
            SELECT r.body::jsonb #>> '{choices,0,message,tool_calls,0,function,arguments}' FROM up u
              JOIN turn_calls m ON m.turn_id = u.id AND m.call_kind = 'model' AND (u.depth > 0 OR m.seq < c.seq)
              JOIN turn_call_raw r ON r.turn_id = m.turn_id AND r.seq = m.seq
              ORDER BY u.depth, m.seq DESC LIMIT 1)) ORDER BY t.id, c.seq), '[]'::jsonb)
      FROM shown x JOIN turns t ON t.actor_id = p_actor_id AND t.id = x.id AND t.session_id = p_session_id
      JOIN turn_calls c ON c.turn_id = t.id AND c.call_kind = 'tool' AND c.upper_usd > 0 AND c.status IN ('ok', 'unusable')));
END $function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['opc_data_turn(uuid,uuid)','opc_data_source_turn(uuid,uuid)','opc_data_event_source(opc_data_events)',
    'topic_turn_source(uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.topic_turn_source(uuid,uuid,uuid) TO service_role';
END $$;

COMMIT;
