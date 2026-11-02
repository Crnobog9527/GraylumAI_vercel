-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 fix (Owner 2026-11-02, option A): after the positioning is updated, the old topic workspace is read-only and the user
-- could not start again. Now opc_topic_consent re-binds the SAME workspace (same conversation) to the latest formal version:
--   * the binding row opc_topic_workspaces was immutable (artifact_immutable). Owner-approved loosening, this one table only: the
--     trigger function artifact_immutable gets one branch that allows an UPDATE of opc_topic_workspaces only when the marker graylum.topic_rebind equals '<draft id>:<transaction id>' (set by
--     opc_topic_consent in that same transaction) AND nothing but source_version_id, source_hash, material_revision and the new
--     history_floor_seq changes. Without the marker, with another column changed, or for a DELETE, it refuses exactly as before.
--   * history_floor_seq = the last message seq at the re-bind; topic_turn_source returns it as historyFloor and the topic turn sends
--     the model only the messages after it. The old messages stay readable on the page; no new table.
--   * topic_turn_source refuses a workspace behind the latest formal version (OPC_TOPIC_SOURCE_CHANGED): a turn opens only on the new one.
--   * opc_topic_original (the one gate of saving and adopting a candidate) refuses a reply from before the floor, so an old candidate
--     cannot be saved or adopted on the new version.
--   * a re-bind needs the same pinned method revision, module and Skill as the workspace; otherwise it is refused (nothing is changed).
-- Compatible: the new column defaults to 0 (the whole history, as before); old pages ignore historyFloor.
-- Repeatable: ADD COLUMN IF NOT EXISTS, whole-function CREATE OR REPLACE (the trigger itself is untouched). A repeated consent after the
-- re-bind is the ordinary idempotent path. Recovery: re-apply the previous text of the three functions (artifact_immutable from git history);
-- the column may stay (nothing reads it then).
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.opc_topic_workspaces ADD COLUMN IF NOT EXISTS history_floor_seq bigint NOT NULL DEFAULT 0;

-- artifact_immutable stays the trigger function of the table (the erasure audits and the erasure allow-list work through it). It gains
-- exactly one branch, for this one table: the re-bind update described above. Everything else is the text of before.
CREATE OR REPLACE FUNCTION public.artifact_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE keep text[]:=ARRAY['source_version_id','source_hash','material_revision','history_floor_seq'];
BEGIN
  IF TG_OP='DELETE' AND public.erasure_business_delete_allowed(TG_TABLE_NAME,to_jsonb(OLD)) THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0
    AND public.erasure_update_allowed(to_jsonb(OLD), to_jsonb(NEW), TG_ARGV) THEN
    RETURN NEW;
  END IF;
  -- Owner 2026-11-02, option A: the topic workspace binding may be re-bound to the latest positioning, by opc_topic_consent only.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'opc_topic_workspaces' THEN
    IF current_setting('graylum.topic_rebind',true) IS NOT DISTINCT FROM (to_jsonb(OLD)->>'draft_id')||':'||txid_current()::text
      AND (to_jsonb(OLD)-keep)=(to_jsonb(NEW)-keep) THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'artifact history immutable';
END $function$;

CREATE OR REPLACE FUNCTION public.opc_topic_consent(p_actor_id uuid, p_draft_id uuid, p_source_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE w opc_topic_workspaces; result jsonb; d opc_drafts; ap artifact_projects; v artifact_versions; r artifact_rounds; old_version bigint;
 mat jsonb; n bigint; floor_seq bigint;
BEGIN
 -- 0324 archived business guard
 IF true THEN PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id)); END IF;

 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
 PERFORM bill2_actor(p_actor_id);
 IF NOT EXISTS(SELECT 1 FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_draft_id::text,113));
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF w.draft_id IS NOT NULL AND w.source_version_id IS DISTINCT FROM p_source_version_id THEN
  -- Owner 2026-11-02 (option A): after the positioning is updated the user can start the topic work again on the latest
  -- positioning. Only the newest formal version of this draft's project qualifies, and only the same pinned method revision.
  SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
  SELECT * INTO ap FROM artifact_projects WHERE id=d.project_id AND actor_id=p_actor_id;
  SELECT * INTO v FROM artifact_versions WHERE id=p_source_version_id AND project_id=d.project_id;
  SELECT version INTO old_version FROM artifact_versions WHERE id=w.source_version_id;
  IF ap.id IS NULL OR v.id IS NULL OR v.version IS DISTINCT FROM ap.current_version OR v.version<=coalesce(old_version,0)
   THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_CHANGED';END IF;
  IF NOT opc_source_allowed(p_actor_id,v.id) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_DENIED';END IF;
  SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND project_id=d.project_id;
  IF r.id IS NULL OR r.state<>'published' OR jsonb_typeof(r.workflow->'planResources') IS DISTINCT FROM 'array'
   OR jsonb_array_length(r.workflow->'planResources')=0 THEN RAISE EXCEPTION 'OPC_TOPIC_SKILL_MISSING';END IF;
  IF r.revision_id IS DISTINCT FROM w.revision_id OR ap.module_id IS DISTINCT FROM w.module_id OR ap.skill_id IS DISTINCT FROM w.skill_id
   THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_CHANGED';END IF;
  -- The same conversation, a new material revision; what the model is sent from the old conversation starts after floor_seq.
  SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=w.session_id;
  mat:=runtime_material(p_actor_id,w.session_id,'save',gen_random_uuid(),n,
   jsonb_build_object('brief','topic:first-week','material',opc_source_material(v.id,'topic:first-week'),'roundId',NULL));
  SELECT coalesce(max(seq),0) INTO floor_seq FROM session_messages WHERE session_id=w.session_id;
  -- The only update the binding's guard lets through: the marker names this draft and this transaction.
  PERFORM set_config('graylum.topic_rebind',p_draft_id::text||':'||txid_current()::text,true);
  UPDATE opc_topic_workspaces SET source_version_id=v.id,source_hash=coalesce(v.report_hash,''),
   material_revision=(mat->>'revision')::bigint,history_floor_seq=floor_seq WHERE draft_id=p_draft_id;
  PERFORM set_config('graylum.topic_rebind','',true);
  RETURN opc_topic_read(p_actor_id,p_draft_id);
 END IF;
 IF NOT opc_source_allowed(p_actor_id,p_source_version_id) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_DENIED';END IF;
 result:=opc_topic_bind(p_actor_id,p_draft_id,coalesce(w.request_id,gen_random_uuid()),p_source_version_id);
 -- Upgraded workspaces with any prior topic turn already started their work.
 -- Do not append an automatic opening to an existing conversation.
 IF NOT EXISTS(SELECT 1 FROM opc_turns t JOIN opc_topic_workspaces b ON b.session_id=t.session_id WHERE b.draft_id=p_draft_id AND t.purpose='topic') THEN
  INSERT INTO opc_topic_openings(draft_id,input) VALUES(p_draft_id,'请根据已确认的定位和选题方法，提出第一周选题候选；区分已确认事实与建议，缺少必要信息时先问我。') ON CONFLICT(draft_id) DO NOTHING;
 END IF;
 RETURN opc_topic_read(p_actor_id,p_draft_id);
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
 -- A turn opens only on the latest formal positioning: a workspace behind it is read-only until the user starts again on the new version.
 IF (SELECT v.version FROM artifact_versions v WHERE v.id=w.source_version_id)
  IS DISTINCT FROM (SELECT ap.current_version FROM artifact_projects ap WHERE ap.id=d.project_id) THEN
  RAISE EXCEPTION 'OPC_TOPIC_SOURCE_CHANGED';END IF;
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
  'historyFloor',w.history_floor_seq,
  'material',jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash,'content',m.content));
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
 -- A reply from before the workspace was re-bound to a newer positioning is no source: it cannot be saved or adopted on the new version.
 IF w.history_floor_seq>0 AND (e.id IS NOT NULL OR EXISTS(SELECT 1 FROM turns t JOIN session_messages m ON m.turn_id=t.id
   WHERE t.actor_id=a AND t.request_id=eid AND m.session_id=source_session AND m.seq<=w.history_floor_seq)) THEN
  RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
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

COMMIT;
