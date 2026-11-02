-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 B6: the report document functions no longer read runtime_executions. report_document, report_document_source and
-- report_document_data_source took the page's "execution id" as either an old execution or the request id of a report turn; the old
-- branch is dropped, so the id is the report turn's request id only. A report of the old path (an old execution id) now answers
-- REPORT_EXECUTION_REQUIRED (staging holds test data only; the page no longer asks for one, #1605). Signatures and results are unchanged.
-- Compatible: the new page (#1605) only passes turn request ids; an old page asking for an old execution is refused as said above.
-- Repeatable: whole-function CREATE OR REPLACE. Recovery: re-apply 0324/0300/V2-7a text of the three functions from git history
-- (the old branch); no data is written or removed, so nothing needs restoring.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.report_document(p_actor_id uuid, p_execution_id uuid, p_action text, p_request_id uuid DEFAULT NULL::uuid, p_expected_revision bigint DEFAULT NULL::bigint, p_body text DEFAULT NULL::text, p_expected_body_hash text DEFAULT NULL::text, p_report_data jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE source jsonb;request jsonb;prior artifact_requests;result jsonb;pid uuid;rid uuid;spec jsonb;generated text;parts jsonb;
BEGIN
 -- 0324 archived business guard
 -- CORE-PATH-V2 V2-12 B6: p_execution_id is the report turn's request id; its conversation names the business.
 IF p_action IS DISTINCT FROM 'read' THEN PERFORM opc_assert_business_writable(p_actor_id,
  jsonb_build_object('sessionId',report_turn_source(p_actor_id,p_execution_id)->>'sessionId')); END IF;

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
  -- The report turn of that request id (report_document_source has already proved it is the actor's).
  SELECT n->'spec',n->>'body' INTO spec,generated FROM report_turn_source(p_actor_id,p_execution_id) n;
  parts:=report_body_parts(p_body);
  IF p_body IS NULL OR btrim(parts->>'text')='' OR char_length(parts->>'text')>(spec->>'maxCharacters')::integer
   OR parts->>'block' IS DISTINCT FROM report_body_parts(generated)->>'block' THEN
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
  PERFORM set_config('graylum.report_data',coalesce(p_report_data::text,''),true);
  result:=artifact_transition(p_actor_id,(source->>'moduleId')::uuid,(source->>'skillId')::uuid,
   'publish',pid,rid,p_request_id,request);
  PERFORM set_config('graylum.report_data','',true);
 END IF;
 RETURN report_document_source(p_actor_id,p_execution_id);
END $function$;

CREATE OR REPLACE FUNCTION public.report_document_source(a uuid, eid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p artifact_projects;r artifact_rounds;source jsonb;spec jsonb;
 q artifact_requests;v artifact_versions;body text;revision bigint:=0;item jsonb;sid uuid;
 nt jsonb;gen_body text;gen_completeness text;gen_done boolean;
BEGIN
 PERFORM bill2_actor(a);
 PERFORM id FROM profiles WHERE id=a FOR SHARE;
 -- CORE-PATH-V2 V2-12 B6: a report is found by its turn's request id (the page's handle for it); there is no other source.
 nt:=report_turn_source(a,eid);sid:=(nt->>'sessionId')::uuid;
 IF sid IS NULL THEN RAISE EXCEPTION 'REPORT_EXECUTION_REQUIRED'; END IF;
 PERFORM id FROM runtime_sessions WHERE id=sid AND actor_id=a FOR UPDATE;
 -- Read again under the session lock; a deleted conversation or an erasing account has no report to edit or publish.
 nt:=report_turn_source(a,eid);
 IF nt IS NULL OR (turn_tombstones(a,sid,'{}'::jsonb)->>'sessionTombstoned')::boolean
  OR (turn_tombstones(a,sid,'{}'::jsonb)->>'accountErasing')::boolean THEN RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
 spec:=nt->'spec';
 gen_body:=nt->>'body';gen_completeness:=nt->>'completeness';gen_done:=(nt->>'completed')::boolean;
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
 body:=coalesce(q.payload->>'body',gen_body,'');
 revision:=coalesce((q.response->>'revision')::bigint,0);
 SELECT * INTO v FROM artifact_versions WHERE project_id=p.id AND round_id=r.id AND erased_at IS NULL;
 RETURN jsonb_build_object('executionId',eid,'projectId',p.id,'roundId',r.id,'moduleId',p.module_id,'skillId',p.skill_id,
  'draftId',(SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=p.id AND round_id=r.id),
  'revision',revision,'body',body,'bodyHash',encode(sha256(convert_to(body,'utf8')),'hex'),
  'manuallyEdited',revision>0,'completeness',gen_completeness,'state',r.state,'sessionId',sid,
  'candidate',coalesce(gen_done AND gen_completeness='complete'
    AND report_body_complete(gen_body,spec) AND report_body_complete(body,spec),false),
  'finalized',v.id IS NOT NULL,'versionId',v.id,'version',v.version,
  'next',CASE WHEN v.id IS NOT NULL AND EXISTS(SELECT 1 FROM opc_drafts WHERE actor_id=a AND project_id=p.id AND round_id=r.id)
   THEN jsonb_build_object('kind','first_week_topics','draftId',
    (SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=p.id AND round_id=r.id),'sourceVersionId',v.id) ELSE NULL END);
END $function$;

CREATE OR REPLACE FUNCTION public.report_document_data_source(a uuid, eid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE source jsonb;stored jsonb;nt jsonb;
BEGIN
 source:=report_document_source(a,eid);
 SELECT report#>'{generatedReport,data}' INTO stored FROM artifact_versions
  WHERE id=(source->>'versionId')::uuid AND erased_at IS NULL;
 -- CORE-PATH-V2 V2-12 B6: the report turn's frozen report identity and text.
 nt:=report_turn_source(a,eid);
 RETURN jsonb_build_object('sessionId',nt->>'sessionId','benchmarkHash',nt#>>'{spec,benchmarkHash}',
  'generatedBody',nt->>'body','storedData',stored);
END $function$;

COMMIT;
