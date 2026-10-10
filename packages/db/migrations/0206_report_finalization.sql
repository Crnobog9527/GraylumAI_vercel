/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- AGENT-CORE R5. Number allocated by #783 issuecomment-6098712206.
-- Reuses existing immutable content, provenance and erasure mechanisms.
BEGIN;
CREATE OR REPLACE FUNCTION public.report_body_complete(body text,spec jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE headings jsonb;sections text[];
BEGIN
 IF body IS NULL OR char_length(body)>coalesce((spec->>'maxCharacters')::integer,0) THEN RETURN false; END IF;
 SELECT coalesce(jsonb_agg(trim(m[1]) ORDER BY n),'[]') INTO headings
 FROM regexp_matches(replace(body,E'\r\n',E'\n'),'^##[[:blank:]]+([^\n]+)$','gn') WITH ORDINALITY t(m,n);
 sections:=regexp_split_to_array(replace(body,E'\r\n',E'\n'),E'(?n)^##[[:blank:]]+[^\n]+$');
 RETURN headings=spec->'sections' AND jsonb_array_length(headings)>0 AND NOT EXISTS(
  SELECT 1 FROM unnest(sections[2:array_length(sections,1)]) s WHERE btrim(s,E' \n\r\t')='');
END $$;
REVOKE ALL ON FUNCTION public.report_body_complete(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Only the existing execution and immutable request rows are authoritative.
-- Lock the same parents as deletion, then re-read the original source and current confirmations.
CREATE OR REPLACE FUNCTION public.report_document_source(a uuid,eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;p artifact_projects;r artifact_rounds;source jsonb;spec jsonb;
 q artifact_requests;v artifact_versions;body text;revision bigint:=0;item jsonb;sid uuid;
BEGIN
 PERFORM bill2_actor(a);
 PERFORM id FROM profiles WHERE id=a FOR SHARE;
 SELECT session_id INTO sid FROM runtime_executions WHERE id=eid AND actor_id=a;
 IF sid IS NULL THEN RAISE EXCEPTION 'REPORT_EXECUTION_REQUIRED'; END IF;
 PERFORM id FROM runtime_sessions WHERE id=sid AND actor_id=a FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=eid AND actor_id=a FOR UPDATE;
 PERFORM content_erasure_runtime_check(a,eid);
 spec:=e.payload->'reportGeneration';
 IF spec IS NULL OR jsonb_typeof(spec)<>'object' THEN RAISE EXCEPTION 'REPORT_EXECUTION_REQUIRED'; END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=(spec->>'projectId')::uuid AND actor_id=a FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=(spec->>'roundId')::uuid AND project_id=p.id;
 IF p.id IS NULL OR r.id IS NULL THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 IF p.erased_at IS NOT NULL OR p.content_deleted_at IS NOT NULL OR r.erased_at IS NOT NULL THEN
  RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
 source:=report_source(a,sid,p.id,r.id);
 IF source->>'snapshotHash' IS DISTINCT FROM spec->>'snapshotHash'
  OR r.package_hash IS DISTINCT FROM spec->>'packageHash'
  OR r.workflow_hash IS DISTINCT FROM spec->>'workflowHash'
  OR r.template_hash IS DISTINCT FROM spec->>'templateHash'
  OR r.workflow#>'{reportGeneration,sections}' IS DISTINCT FROM spec->'sections'
  OR r.workflow#>'{reportGeneration,maxCharacters}' IS DISTINCT FROM spec->'maxCharacters' THEN
  RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 FOR item IN SELECT value FROM jsonb_each(source#>'{snapshot,steps}') LOOP
  IF item->>'valid' IS DISTINCT FROM 'true' OR item->>'confirmationId' IS NULL OR item->>'body' IS NULL
   OR item->>'available'='false' THEN RAISE EXCEPTION 'REPORT_CONFIRMATION_REQUIRED'; END IF;
 END LOOP;
 SELECT * INTO q FROM artifact_requests WHERE project_id=p.id AND round_id=r.id AND action='report_edit'
  AND payload->>'executionId'=eid::text AND erased_at IS NULL
  ORDER BY (response->>'revision')::bigint DESC LIMIT 1;
 body:=coalesce(q.payload->>'body',e.result->>'body','');
 revision:=coalesce((q.response->>'revision')::bigint,0);
 SELECT * INTO v FROM artifact_versions WHERE project_id=p.id AND round_id=r.id AND erased_at IS NULL;
 RETURN jsonb_build_object('executionId',eid,'projectId',p.id,'roundId',r.id,'moduleId',p.module_id,'skillId',p.skill_id,
  'draftId',(SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=p.id AND round_id=r.id),
  'revision',revision,'body',body,'bodyHash',encode(sha256(convert_to(body,'utf8')),'hex'),
  'manuallyEdited',revision>0,'completeness',e.result->>'completeness','state',r.state,
  'candidate',coalesce(e.state='completed' AND e.result->>'completeness'='complete'
    AND report_body_complete(e.result->>'body',spec) AND report_body_complete(body,spec),false),
  'finalized',v.id IS NOT NULL,'versionId',v.id,'version',v.version,
  'next',CASE WHEN v.id IS NOT NULL AND EXISTS(SELECT 1 FROM opc_drafts WHERE actor_id=a AND project_id=p.id AND round_id=r.id)
   THEN jsonb_build_object('kind','first_week_topics','draftId',
    (SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=p.id AND round_id=r.id),'sourceVersionId',v.id) ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION public.report_document_source(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- A published generated report points back to its producing execution. Reading the
-- full evidence catalogue here would ask that execution about itself. Published
-- rounds are immutable: use their confirmed fields and check only those inputs.
DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.report_source(uuid,uuid,uuid,uuid)'::regprocedure);
 IF position('-- R5 published confirmation snapshot' IN definition)=0 THEN
  needle:='source:=artifact_query(p_actor_id,''read'',p_project_id,p_round_id);';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'REPORT_SOURCE_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,$patch$
 -- R5 published confirmation snapshot
 IF r.state='published' AND EXISTS(SELECT 1 FROM artifact_versions WHERE round_id=r.id AND report ? 'generatedReport') THEN
  PERFORM read_skill_package(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=p_project_id),
   (SELECT skill_id FROM artifact_projects WHERE id=p_project_id),r.revision_id,r.package_hash,NULL);
  IF EXISTS(SELECT 1 FROM jsonb_each(r.steps) st WHERE st.value->>'valid' IS DISTINCT FROM 'true'
   OR NOT artifact_evidence_allowed(p_project_id,coalesce(st.value->'evidenceIds','[]')||coalesce(st.value->'provenanceIds','[]'))) THEN
   RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
  source:=jsonb_build_object('projectId',p_project_id,'roundId',p_round_id,'state',r.state,
   'skillId',(SELECT skill_id FROM artifact_projects WHERE id=p_project_id),
   'currentVersion',(SELECT current_version FROM artifact_projects WHERE id=p_project_id),
   'revisionId',r.revision_id,'packageHash',r.package_hash,'workflowHash',r.workflow_hash,'templateHash',r.template_hash,
   'workflow',r.workflow,'steps',r.steps,'evidence','[]'::jsonb,'candidates','[]'::jsonb,'confirmations','[]'::jsonb);
 ELSE
  source:=artifact_query(p_actor_id,'read',p_project_id,p_round_id);
 END IF;
$patch$);
 END IF;
END $$;

-- Called inside the existing atomic publication, before the immutable version is inserted.
-- The confirmed field snapshot stays unchanged for downstream topic/writing semantics.
CREATE OR REPLACE FUNCTION public.report_final_snapshot(a uuid,pid uuid,rid uuid,payload jsonb,snapshot jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE source jsonb;r artifact_rounds;ev uuid;eid uuid;
BEGIN
 SELECT * INTO r FROM artifact_rounds WHERE id=rid AND project_id=pid;
 IF NOT(r.workflow ? 'reportGeneration') THEN RETURN snapshot; END IF;
 IF payload->>'reportExecutionId' IS NULL THEN RAISE EXCEPTION 'REPORT_EXECUTION_REQUIRED'; END IF;
 source:=report_document_source(a,(payload->>'reportExecutionId')::uuid);
 IF source->>'projectId' IS DISTINCT FROM pid::text OR source->>'roundId' IS DISTINCT FROM rid::text THEN
  RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 IF source->>'candidate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'REPORT_NOT_COMPLETE'; END IF;
 IF source->'revision' IS DISTINCT FROM payload->'reportRevision'
  OR source->>'bodyHash' IS DISTINCT FROM payload->>'reportBodyHash' THEN RAISE EXCEPTION 'REPORT_VERSION_CONFLICT'; END IF;
 eid:=(source->>'executionId')::uuid;
 IF NOT runtime_history_available(eid) THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 SELECT evidence_id INTO ev FROM opc_result_links WHERE execution_id=eid AND round_id=rid AND step_id='report-final';
 IF ev IS NULL THEN
  ev:=gen_random_uuid();
  INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash)
   VALUES(ev,pid,'user',jsonb_build_object('executionId',eid),source->>'bodyHash');
  INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);
  INSERT INTO opc_result_links(evidence_id,execution_id,round_id,step_id) VALUES(ev,eid,rid,'report-final');
 END IF;
 RETURN snapshot||jsonb_build_object('sources',(snapshot->'sources')||jsonb_build_array(
  jsonb_build_object('id',ev,'kind','report','executionId',eid)),
  'generatedReport',jsonb_build_object('executionId',source->'executionId','evidenceId',ev,
  'revision',source->'revision','body',source->'body','bodyHash',source->'bodyHash','manuallyEdited',source->'manuallyEdited'),
  'limitations','Report text may be manually edited; downstream positioning uses the confirmed field snapshot.');
END $$;
REVOKE ALL ON FUNCTION public.report_final_snapshot(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.artifact_transition_before_reuse(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure);
 IF position('report_final_snapshot(' IN definition)=0 THEN
  needle:='INSERT INTO artifact_versions(id,project_id,round_id,version,report,report_hash,evidence_ids)';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'REPORT_PUBLISH_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'snap:=report_final_snapshot(p_actor_id,p.id,r.id,p_payload,snap); '
   ||'IF snap#>>''{generatedReport,evidenceId}'' IS NOT NULL THEN '
   ||'all_ids:=all_ids||jsonb_build_array(snap#>''{generatedReport,evidenceId}''); END IF; '||needle);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.report_document(p_actor_id uuid,p_execution_id uuid,p_action text,
 p_request_id uuid DEFAULT NULL,p_expected_revision bigint DEFAULT NULL,p_body text DEFAULT NULL,p_expected_body_hash text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source jsonb;request jsonb;prior artifact_requests;result jsonb;pid uuid;rid uuid;spec jsonb;
BEGIN
 IF p_action IS NULL OR p_action NOT IN ('read','save','finalize') THEN RAISE EXCEPTION 'REPORT_BODY_INVALID'; END IF;
 source:=report_document_source(p_actor_id,p_execution_id);
 pid:=(source->>'projectId')::uuid;rid:=(source->>'roundId')::uuid;
 IF p_action='read' THEN RETURN source; END IF;
 IF p_request_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<0 THEN
  RAISE EXCEPTION 'REPORT_BODY_INVALID'; END IF;
 IF p_action='save' THEN
  request:=jsonb_build_object('executionId',p_execution_id,'expectedRevision',p_expected_revision,'body',p_body);
  SELECT * INTO prior FROM artifact_requests WHERE project_id=pid AND request_id=p_request_id;
  IF FOUND THEN
   IF prior.erased_at IS NOT NULL THEN RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
   IF prior.round_id IS DISTINCT FROM rid OR prior.action<>'report_edit' OR prior.payload IS DISTINCT FROM request THEN
    RAISE EXCEPTION 'REPORT_REQUEST_CONFLICT'; END IF;
   -- Return the current document, never a stale body paired with a newer revision.
   RETURN source;
  END IF;
  IF source->>'finalized'='true' OR source->>'state'<>'draft' THEN RAISE EXCEPTION 'REPORT_ALREADY_FINALIZED'; END IF;
  IF (source->>'revision')::bigint<>p_expected_revision THEN RAISE EXCEPTION 'REPORT_VERSION_CONFLICT'; END IF;
  SELECT payload->'reportGeneration' INTO spec FROM runtime_executions WHERE id=p_execution_id;
  IF p_body IS NULL OR btrim(p_body)='' OR char_length(p_body)>(spec->>'maxCharacters')::integer THEN
   RAISE EXCEPTION 'REPORT_BODY_INVALID'; END IF;
  INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
   VALUES(pid,p_request_id,rid,'report_edit',request,jsonb_build_object('revision',p_expected_revision+1));
 ELSE
  request:=jsonb_build_object('reportExecutionId',p_execution_id,'reportRevision',p_expected_revision,'reportBodyHash',p_expected_body_hash);
  SELECT * INTO prior FROM artifact_requests WHERE project_id=pid AND request_id=p_request_id;
  IF FOUND THEN
   IF prior.erased_at IS NOT NULL THEN RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
   IF prior.round_id IS DISTINCT FROM rid OR prior.action<>'publish' OR prior.payload IS DISTINCT FROM request THEN
    RAISE EXCEPTION 'REPORT_REQUEST_CONFLICT'; END IF;
   RETURN source;
  END IF;
  IF source->>'finalized'='true' OR source->>'state'<>'draft' THEN RAISE EXCEPTION 'REPORT_ALREADY_FINALIZED'; END IF;
  IF source->>'candidate' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'REPORT_NOT_COMPLETE'; END IF;
  IF (source->>'revision')::bigint<>p_expected_revision OR source->>'bodyHash' IS DISTINCT FROM p_expected_body_hash THEN
   RAISE EXCEPTION 'REPORT_VERSION_CONFLICT'; END IF;
  result:=artifact_transition(p_actor_id,(source->>'moduleId')::uuid,(source->>'skillId')::uuid,
   'publish',pid,rid,p_request_id,request);
 END IF;
 RETURN report_document_source(p_actor_id,p_execution_id);
END $$;
REVOKE ALL ON FUNCTION public.report_document(uuid,uuid,text,uuid,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.report_document(uuid,uuid,text,uuid,bigint,text,text) TO service_role;
COMMIT;
