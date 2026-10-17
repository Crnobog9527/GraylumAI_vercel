/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- REPORT-VISUAL PR-2 (docs/launch/tasks/REPORT-VISUAL.md §3.3, §6.2, §7.2). Number 0300 assigned by the controller.
--
-- A report body may end with one fenced `graylum-report-data` block (one JSON field per line). This migration:
--   1. counts and checks the report TEXT only (the block left out) for completeness, hand edits and review
--      revisions: the 12000-character limit is the text's (Owner's choice B); the block is checked by the host;
--   2. keeps the block out of hand edits: a saved body must carry exactly the generated block (or none);
--   3. at 定稿, stores the host-checked strategy data in the formal version (generatedReport.data), accepted only
--      for the exact body being finalized; a report without data publishes exactly as before;
--   4. lets an adopted review revision keep the strategy data of the version it revises (text-only revision);
--   5. adds a read-only helper for the host (session, frozen benchmark hash, generated body, stored data).
-- Erasure needs nothing new: the data lives inside runtime_executions.result and artifact_versions.report, which the
-- existing account and content erasure already clear (packages/db/tests/report-visual-data covers it).
BEGIN;

-- Mirrors splitReportBody in packages/api/src/shared/reportData.ts: the LAST fence line opens the block (a fence typed
-- into the text stays text), the next bare ``` line closes it. No closing line: the text before it and no block.
CREATE OR REPLACE FUNCTION public.report_body_parts(body text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE lines text[];n integer;open_at integer;close_at integer;before text;after text;
 ws constant text:=E' \t\r\n\x0b\x0c';
BEGIN
 IF body IS NULL THEN RETURN NULL; END IF;
 lines:=string_to_array(body,E'\n');n:=coalesce(array_length(lines,1),0);
 FOR i IN REVERSE n..1 LOOP
  IF btrim(lines[i],ws)='```graylum-report-data' THEN open_at:=i; EXIT; END IF;
 END LOOP;
 IF open_at IS NULL THEN RETURN jsonb_build_object('text',body,'block',NULL); END IF;
 FOR i IN open_at+1..n LOOP
  IF btrim(lines[i],ws)='```' THEN close_at:=i; EXIT; END IF;
 END LOOP;
 before:=rtrim(coalesce(array_to_string(lines[1:open_at-1],E'\n'),''),ws);
 IF close_at IS NULL THEN RETURN jsonb_build_object('text',before,'block',NULL); END IF;
 after:=btrim(coalesce(array_to_string(lines[close_at+1:n],E'\n'),''),ws);
 RETURN jsonb_build_object('text',CASE WHEN after='' THEN before ELSE before||E'\n\n'||after END,
  'block',array_to_string(lines[open_at:close_at],E'\n'));
END $$;
REVOKE ALL ON FUNCTION public.report_body_parts(text) FROM PUBLIC,anon,authenticated,service_role;

-- 0206's check, on the text only (same as completeReportCandidate in TS).
CREATE OR REPLACE FUNCTION public.report_body_complete(body text,spec jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE headings jsonb;sections text[];t text;
BEGIN
 t:=report_body_parts(body)->>'text';
 IF t IS NULL OR char_length(t)>coalesce((spec->>'maxCharacters')::integer,0) THEN RETURN false; END IF;
 SELECT coalesce(jsonb_agg(trim(m[1]) ORDER BY n),'[]') INTO headings
 FROM regexp_matches(replace(t,E'\r\n',E'\n'),'^##[[:blank:]]+([^\n]+)$','gn') WITH ORDINALITY x(m,n);
 sections:=regexp_split_to_array(replace(t,E'\r\n',E'\n'),E'(?n)^##[[:blank:]]+[^\n]+$');
 RETURN headings=spec->'sections' AND jsonb_array_length(headings)>0 AND NOT EXISTS(
  SELECT 1 FROM unnest(sections[2:array_length(sections,1)]) s WHERE btrim(s,E' \n\r\t')='');
END $$;
REVOKE ALL ON FUNCTION public.report_body_complete(text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- The data passed by report_document for this transaction's 定稿 only (same pattern as graylum.report_revision).
-- Accepted only for the very body being finalized, and only when that body carries a data block.
CREATE OR REPLACE FUNCTION public.report_final_data(source jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE raw text:=current_setting('graylum.report_data',true);d jsonb;
BEGIN
 IF raw IS NULL OR raw='' THEN RETURN '{}'::jsonb; END IF;
 d:=raw::jsonb;
 IF jsonb_typeof(d) IS DISTINCT FROM 'object' OR d->>'bodyHash' IS DISTINCT FROM source->>'bodyHash'
  OR d->'dataVersion' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(d->'data') IS DISTINCT FROM 'object'
  OR jsonb_typeof(d->'dropped') IS DISTINCT FROM 'array' OR jsonb_typeof(d->'textEdited') IS DISTINCT FROM 'array'
  OR jsonb_typeof(d->'validatedAt') IS DISTINCT FROM 'string' OR octet_length(d::text)>65536
  OR report_body_parts(source->>'body')->>'block' IS NULL THEN
  RAISE EXCEPTION 'REPORT_DATA_INVALID'; END IF;
 RETURN jsonb_build_object('data',d-'bodyHash');
END $$;
REVOKE ALL ON FUNCTION public.report_final_data(jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.report_final_snapshot(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 IF position('report_final_data(' IN definition)=0 THEN
  needle:='''manuallyEdited'',source->''manuallyEdited''),';
  IF array_length(string_to_array(definition,needle),1)<>2 THEN RAISE EXCEPTION 'REPORT_DATA_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'''manuallyEdited'',source->''manuallyEdited'')||report_final_data(source),');
 END IF;
END $$;

-- An adopted review revision only changes text: it keeps the data of the version it revises (§6.1, until PR-5).
DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.report_revision_snapshot(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 IF position('''dataFrom''' IN definition)=0 THEN
  needle:='''manuallyEdited'',false,''fieldsSynced'',true),';
  IF array_length(string_to_array(definition,needle),1)<>2 THEN RAISE EXCEPTION 'REPORT_DATA_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'''manuallyEdited'',false,''fieldsSynced'',true)||coalesce((SELECT jsonb_build_object('
   ||'''data'',sv.report#>''{generatedReport,data}'',''dataFrom'',''source_version'') FROM artifact_versions sv '
   ||'WHERE sv.id=(rv.payload->>''sourceVersionId'')::uuid AND sv.erased_at IS NULL '
   ||'AND jsonb_typeof(sv.report#>''{generatedReport,data}'')=''object''),''{}''::jsonb),');
 END IF;
END $$;

-- 0206's document actions with the strategy data of 定稿. Hand edits keep the generated block unchanged.
DROP FUNCTION IF EXISTS public.report_document(uuid,uuid,text,uuid,bigint,text,text);
CREATE OR REPLACE FUNCTION public.report_document(p_actor_id uuid,p_execution_id uuid,p_action text,
 p_request_id uuid DEFAULT NULL,p_expected_revision bigint DEFAULT NULL,p_body text DEFAULT NULL,p_expected_body_hash text DEFAULT NULL,
 p_report_data jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source jsonb;request jsonb;prior artifact_requests;result jsonb;pid uuid;rid uuid;spec jsonb;generated text;parts jsonb;
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
  SELECT x.payload->'reportGeneration',x.result->>'body' INTO spec,generated FROM runtime_executions x WHERE x.id=p_execution_id;
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
END $$;
REVOKE ALL ON FUNCTION public.report_document(uuid,uuid,text,uuid,bigint,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.report_document(uuid,uuid,text,uuid,bigint,text,text,jsonb) TO service_role;

-- What the host needs to check a document's data, after the same ownership and erasure checks as reading it.
CREATE OR REPLACE FUNCTION public.report_document_data_source(a uuid,eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source jsonb;e runtime_executions;stored jsonb;
BEGIN
 source:=report_document_source(a,eid);
 SELECT * INTO e FROM runtime_executions WHERE id=eid AND actor_id=a;
 SELECT report#>'{generatedReport,data}' INTO stored FROM artifact_versions
  WHERE id=(source->>'versionId')::uuid AND erased_at IS NULL;
 RETURN jsonb_build_object('sessionId',e.session_id,'benchmarkHash',e.payload#>>'{reportGeneration,benchmarkHash}',
  'generatedBody',e.result->>'body','storedData',stored);
END $$;
REVOKE ALL ON FUNCTION public.report_document_data_source(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.report_document_data_source(uuid,uuid) TO service_role;
COMMIT;
