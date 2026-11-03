-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-7a2 (number 0432 assigned by the controller; the functions are rebuilt whole on their text after 0429):
-- a report generated on the turn path can be finalized into artifact_versions. opc_result_links, which registers the finalized report,
-- only accepted runtime_executions; it now also accepts a turn, and every reader of the table decides through the turn branch:
--   opc_result_link_available            the one check: an old row reads runtime_history_available exactly as before; a turn row needs
--                                        a closed, delivered turn, its conversation not deleted and the account not erasing
--   report_final_snapshot                registers the turn (evidence payload keeps executionId = the turn's request id, adds turnId)
--   artifact_evidence_allowed_before_memo, content_erasure_artifact_readable
--                                        a deleted conversation's finalized report stays readable and stops being a source, as before
--   content_erasure_scope, _mark_session, _confirm
--                                        a conversation's turn links count like its executions; deleting it erases the evidence copy
--                                        and the report edits (found by the turn's request id, which is their executionId)
--   erasure_business_owner               a turn link names its owner, so account erasure removes it before the evidence
-- artifact_save_candidate, opc_save_result and opc_work_result only ever handle execution rows and are unchanged.
-- Compatibility: old rows and old readers are untouched; old code reads execution_id only and ignores turn rows. Nothing writes a turn
-- row until the page switches (V2-10). jury_adopt can register its turn the same way, with its own step_id.
-- Repeatable: IF NOT EXISTS / DROP CONSTRAINT IF EXISTS and CREATE OR REPLACE throughout.
-- Recovery (forward only): keep the columns and the nullable execution_id; re-apply the previous full function texts from
-- packages/db/functions and drop opc_result_link_available. Turn rows are then ignored, so reports finalized from turns are temporarily
-- unreadable and nothing is lost; apply the fixed functions to bring them back. Never delete link rows to recover.
-- Retention: the link holds its turn with ON DELETE NO ACTION. turns are kept 3 years as billing records and nothing deletes them today;
-- the future retention job must handle the links first.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.opc_result_links ADD COLUMN IF NOT EXISTS turn_actor_id uuid, ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.opc_result_links ALTER COLUMN execution_id DROP NOT NULL;
ALTER TABLE public.opc_result_links DROP CONSTRAINT IF EXISTS opc_result_links_turn_fkey;
ALTER TABLE public.opc_result_links ADD CONSTRAINT opc_result_links_turn_fkey FOREIGN KEY (turn_actor_id, turn_id)
  REFERENCES public.turns(actor_id, id) ON DELETE NO ACTION;
ALTER TABLE public.opc_result_links DROP CONSTRAINT IF EXISTS opc_result_links_one_source;
ALTER TABLE public.opc_result_links ADD CONSTRAINT opc_result_links_one_source CHECK
  ((execution_id IS NOT NULL AND turn_actor_id IS NULL AND turn_id IS NULL)
   OR (execution_id IS NULL AND turn_actor_id IS NOT NULL AND turn_id IS NOT NULL));
ALTER TABLE public.opc_result_links DROP CONSTRAINT IF EXISTS opc_result_links_turn_round_step_key;
ALTER TABLE public.opc_result_links ADD CONSTRAINT opc_result_links_turn_round_step_key UNIQUE (turn_id, round_id, step_id);

CREATE OR REPLACE FUNCTION public.opc_result_link_available(l public.opc_result_links)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE tomb jsonb;
BEGIN
 IF l.execution_id IS NOT NULL THEN RETURN runtime_history_available(l.execution_id); END IF;
 SELECT turn_tombstones(t.actor_id,t.session_id,'{}'::jsonb) INTO tomb FROM turns t
  WHERE t.actor_id=l.turn_actor_id AND t.id=l.turn_id AND t.state='closed' AND t.delivered;
 RETURN tomb IS NOT NULL AND NOT (tomb->>'sessionTombstoned')::boolean AND NOT (tomb->>'accountErasing')::boolean;
END $function$;

CREATE OR REPLACE FUNCTION public.report_final_snapshot(a uuid, pid uuid, rid uuid, payload jsonb, snapshot jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE source jsonb;r artifact_rounds;ev uuid;eid uuid;tid bigint;l opc_result_links;
BEGIN
 SELECT * INTO r FROM artifact_rounds WHERE id=rid AND project_id=pid;
 IF NOT(r.workflow ? 'reportGeneration') THEN RETURN snapshot; END IF;
 -- R14 review revision
 IF payload ? 'reviewRevisionId' THEN RETURN report_revision_snapshot(a,pid,rid,payload,snapshot); END IF;
 IF payload->>'reportExecutionId' IS NULL THEN RAISE EXCEPTION 'REPORT_EXECUTION_REQUIRED'; END IF;
 source:=report_document_source(a,(payload->>'reportExecutionId')::uuid);
 IF source->>'projectId' IS DISTINCT FROM pid::text OR source->>'roundId' IS DISTINCT FROM rid::text THEN
  RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 IF source->>'candidate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'REPORT_NOT_COMPLETE'; END IF;
 IF source->'revision' IS DISTINCT FROM payload->'reportRevision'
  OR source->>'bodyHash' IS DISTINCT FROM payload->>'reportBodyHash' THEN RAISE EXCEPTION 'REPORT_VERSION_CONFLICT'; END IF;
 eid:=(source->>'executionId')::uuid;
 -- CORE-PATH-V2 V2-7a2: a report generated on the turn path has no old execution; its link names the turn (report_document_source
 -- prefers an old execution, so the same order here).
 IF NOT EXISTS(SELECT 1 FROM runtime_executions WHERE id=eid AND actor_id=a) THEN
  SELECT id INTO tid FROM turns WHERE actor_id=a AND request_id=eid AND kind='report' AND state='closed';
 END IF;
 IF tid IS NULL THEN l.execution_id:=eid; ELSE l.turn_actor_id:=a; l.turn_id:=tid; END IF;
 IF NOT opc_result_link_available(l) THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 SELECT evidence_id INTO ev FROM opc_result_links WHERE round_id=rid AND step_id='report-final'
  AND (execution_id=eid OR (turn_actor_id=a AND turn_id=tid));
 IF ev IS NULL THEN
  IF (SELECT count(*) FROM artifact_evidence WHERE project_id=pid)>=128 THEN
   RAISE EXCEPTION 'REPORT_EVIDENCE_CAPACITY'; END IF;
  ev:=gen_random_uuid();
  INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash)
   VALUES(ev,pid,'user',jsonb_strip_nulls(jsonb_build_object('executionId',eid,'turnId',tid)),source->>'bodyHash');
  INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);
  INSERT INTO opc_result_links(evidence_id,execution_id,turn_actor_id,turn_id,round_id,step_id)
   VALUES(ev,l.execution_id,l.turn_actor_id,l.turn_id,rid,'report-final');
 END IF;
 RETURN snapshot||jsonb_build_object('sources',(snapshot->'sources')||jsonb_build_array(
  jsonb_build_object('id',ev,'kind','report','executionId',eid)),
  'generatedReport',jsonb_build_object('executionId',source->'executionId','evidenceId',ev,
  'revision',source->'revision','body',source->'body','bodyHash',source->'bodyHash','manuallyEdited',source->'manuallyEdited')||report_final_data(source),
  'limitations','Report text may be manually edited; downstream positioning uses the confirmed field snapshot.');
END $function$;

CREATE OR REPLACE FUNCTION public.artifact_evidence_allowed_before_memo(project uuid, ids jsonb)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO 'public', 'pg_temp'
AS $function$
 -- D7 source tombstones
 SELECT NOT EXISTS(SELECT 1 FROM artifact_projects WHERE id=project AND erased_at IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM artifact_evidence WHERE ids ? id::text AND erased_at IS NOT NULL)
 AND artifact_evidence_allowed_before_opc(project,ids) AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE ids ? l.evidence_id::text AND NOT opc_result_link_available(l))
 AND NOT EXISTS(SELECT 1 FROM opc_account_strategy_drafts binding JOIN opc_drafts d ON d.draft_id=binding.draft_id
  WHERE d.project_id=project AND NOT opc_source_allowed(d.actor_id,binding.root_source_version_id))
 AND NOT EXISTS(SELECT 1 FROM artifact_requests h JOIN artifact_projects p ON p.id=h.project_id
  WHERE h.project_id=project AND h.action='opc_account_inherit' AND
   (NOT opc_source_allowed(p.actor_id,(h.payload->>'sourceVersionId')::uuid)
    OR NOT artifact_evidence_allowed_before_opc(project,jsonb_build_array(h.response->>'evidenceId'))))
$function$;

CREATE OR REPLACE FUNCTION public.content_erasure_artifact_readable(a uuid, vid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v artifact_versions;p artifact_projects;r artifact_rounds;eid text;
BEGIN
 SELECT * INTO v FROM artifact_versions WHERE id=vid AND erased_at IS NULL;
 SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a AND erased_at IS NULL;
 SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND erased_at IS NULL AND state='published';
 IF v.id IS NULL OR p.id IS NULL OR r.id IS NULL THEN RETURN false; END IF;
 PERFORM bill2_actor(a);
 PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
 IF artifact_evidence_allowed(p.id,v.evidence_ids) THEN RETURN true; END IF;
 FOR eid IN SELECT jsonb_array_elements_text(v.evidence_ids) LOOP
  IF EXISTS(SELECT 1 FROM artifact_evidence_restrictions WHERE evidence_id::text=eid
   AND (deleted OR expires_at<=clock_timestamp())) THEN RETURN false; END IF;
  IF NOT artifact_evidence_allowed(p.id,jsonb_build_array(eid)) AND NOT EXISTS(
   SELECT 1 FROM opc_result_links l JOIN runtime_executions e ON e.id=l.execution_id
    JOIN artifact_evidence ev ON ev.id=l.evidence_id
   WHERE l.evidence_id::text=eid AND ev.project_id=p.id AND e.actor_id=a AND e.content_deleted_at IS NOT NULL
   UNION ALL
   -- CORE-PATH-V2 V2-7a2: a report finalized from a turn stays readable when its conversation is deleted, as above.
   SELECT 1 FROM opc_result_links l JOIN turns t ON t.actor_id=l.turn_actor_id AND t.id=l.turn_id JOIN runtime_sessions s ON s.id=t.session_id
    JOIN artifact_evidence ev ON ev.id=l.evidence_id
   WHERE l.evidence_id::text=eid AND ev.project_id=p.id AND t.actor_id=a AND s.content_deleted_at IS NOT NULL
   UNION ALL
   SELECT 1 FROM artifact_work_references ref JOIN artifact_versions src ON src.id=ref.source_version_id
    JOIN artifact_projects owner ON owner.id=src.project_id
   WHERE ref.evidence_id::text=eid AND ref.project_id=p.id AND owner.actor_id=a AND owner.content_deleted_at IS NOT NULL
  ) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
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

CREATE OR REPLACE FUNCTION public.erasure_business_owner(t text, j jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result uuid;
BEGIN
 -- LIB-2a public erasure
 -- PUBLISH-MONITOR erasure
 -- 0262 library references
 -- PAY-FOUNDER erasure
 -- PAY-NOTIFY erasure
 -- ANALYTICS erasure
 -- VOICE erasure
 -- VOICE references
 CASE
 WHEN t='runtime_voice_references' THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('voice_profiles','voice_profile_versions','voice_billing_scrubs') THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('analytics_checkout_ids','analytics_consent_withdrawals') THEN RETURN (j->>'user_id')::uuid;
 WHEN t='payment_notices' THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('founder_wall_entries','founder_community_status') THEN RETURN (j->>'user_id')::uuid;
 WHEN t='runtime_library_references' THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('social_monitor_settings','social_connections','social_posts',
  'social_metric_snapshots','social_review_runs','social_connect_requests','social_publish_jobs')
  THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('library_documents','library_document_segments',
  'library_upload_reservations','library_recognition_units') THEN RETURN (j->>'actor_id')::uuid;
 WHEN t IN ('opc_content_versions','opc_handoffs','opc_library_requests','opc_topic_workspaces',
  'opc_topic_draft_versions','opc_video_material_bindings','opc_account_strategy_request_bases',
  'opc_account_strategy_drafts','opc_accounts','opc_businesses','opc_drafts','artifact_projects',
  'runtime_sessions','runtime_executions') THEN RETURN (j->>'actor_id')::uuid;
 -- 0271 legacy chat tables
 WHEN t='conversations' THEN RETURN (j->>'user_id')::uuid;
 WHEN t IN ('messages','conversation_context_snapshots','artifact_chat_turns','artifact_chats') THEN
  SELECT user_id INTO result FROM conversations WHERE id=(j->>'conversation_id')::uuid;
 WHEN t IN ('artifact_versions','artifact_requests','artifact_evidence','artifact_work_references','artifact_rounds') THEN
  SELECT actor_id INTO result FROM artifact_projects WHERE id=(j->>'project_id')::uuid;
 WHEN t IN ('artifact_confirmations','artifact_candidates','agent_slice_links') THEN
  SELECT p.actor_id INTO result FROM artifact_rounds r JOIN artifact_projects p ON p.id=r.project_id
   WHERE r.id=(j->>'round_id')::uuid;
 -- CORE-PATH-V2 V2-7a2: a report finalized from a turn names its owner on the link.
 WHEN t='opc_result_links' AND j->>'turn_actor_id' IS NOT NULL THEN RETURN (j->>'turn_actor_id')::uuid;
 WHEN t IN ('runtime_tool_calls','runtime_history_dependencies','opc_result_links') THEN
  SELECT actor_id INTO result FROM runtime_executions WHERE id=(j->>'execution_id')::uuid;
 WHEN t IN ('runtime_scope_material','runtime_session_history','runtime_session_batches') THEN
  SELECT actor_id INTO result FROM runtime_sessions WHERE id=(j->>'session_id')::uuid;
 WHEN t IN ('opc_turns','opc_topic_openings','opc_plans','opc_draft_businesses') THEN
  SELECT actor_id INTO result FROM opc_drafts WHERE draft_id=(j->>'draft_id')::uuid;
 WHEN t IN ('opc_items','opc_item_edits') THEN
  SELECT actor_id INTO result FROM artifact_projects WHERE id=(j->>'work_item_id')::uuid;
 WHEN t='artifact_evidence_restrictions' THEN
  SELECT p.actor_id INTO result FROM artifact_evidence e JOIN artifact_projects p ON p.id=e.project_id
   WHERE e.id=(j->>'evidence_id')::uuid;
 ELSE RETURN NULL;
 END CASE;
 RETURN result;
END $function$;

REVOKE ALL ON FUNCTION public.opc_result_link_available(public.opc_result_links) FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
