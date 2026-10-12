/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- AGENT-CORE R8b PR-1. Number allocated by the controller (#874).
-- A Skill with steps and information fields but no profileKey runs through the same mentor flow
-- (drafts, rounds, capture, confirmation) as positioning, as a 'step_skill' project. It is never a
-- positioning: no business is attached, and its versions are never accepted where a positioning
-- source is required (business pointer, free-chat source, topics, plans, account strategy).
-- A workflow with profileKey fields is a positioning workflow, under the unchanged rules.
BEGIN;
ALTER TABLE artifact_projects DROP CONSTRAINT IF EXISTS artifact_projects_work_kind_check;
ALTER TABLE artifact_projects ADD CONSTRAINT artifact_projects_work_kind_check
 CHECK(work_kind IN ('legacy','script','positioning','account','result','step_skill'));

-- Same per-step and per-field rules; profileKey fields are optional, at most 24 and unique.
CREATE OR REPLACE FUNCTION opc_information_schema(flow jsonb) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE step jsonb;field jsonb;
BEGIN
 FOR step IN SELECT * FROM jsonb_array_elements(flow->'steps') LOOP
  IF jsonb_typeof(step->'information') IS DISTINCT FROM 'array' OR jsonb_array_length(step->'information') NOT BETWEEN 1 AND 24 THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(step->'information') x)<>jsonb_array_length(step->'information') THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
  FOR field IN SELECT * FROM jsonb_array_elements(step->'information') LOOP
   IF coalesce(field->>'id','')!~'^[a-z][a-z0-9_-]{0,63}$' OR char_length(coalesce(field->>'title','')) NOT BETWEEN 1 AND 160 OR jsonb_typeof(field->'required') IS DISTINCT FROM 'boolean'
    OR (field?'profileKey' AND coalesce(field->>'profileKey','')!~'^[a-z][a-z0-9_-]{0,63}$') THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
  END LOOP;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_array_elements(flow->'steps') s,jsonb_array_elements(s->'information') f WHERE f?'profileKey')>24 THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
 IF (SELECT count(*) FROM jsonb_array_elements(flow->'steps') s,jsonb_array_elements(s->'information') f WHERE f?'profileKey')<>(SELECT count(DISTINCT f->>'profileKey') FROM jsonb_array_elements(flow->'steps') s,jsonb_array_elements(s->'information') f WHERE f?'profileKey') THEN RAISE EXCEPTION 'OPC_METHOD_INFORMATION_REQUIRED';END IF;
END $$;

DO $$ DECLARE definition text;needle text;
BEGIN
 -- The project kind follows the frozen workflow.
 definition:=pg_get_functiondef('public.opc_start(uuid,uuid,text,text)'::regprocedure);
 IF position('''step_skill''' IN definition)=0 THEN
  needle:='VALUES(project,p_actor_id,w.module_id,w.skill_id,''positioning'');';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'STEP_SKILL_START_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'VALUES(project,p_actor_id,w.module_id,w.skill_id,'
   ||'CASE WHEN opc_is_positioning_workflow(w.workflow) THEN ''positioning'' ELSE ''step_skill'' END);');
 END IF;

 -- A step Skill never gets a business, so publishing it never moves a current positioning.
 definition:=pg_get_functiondef('public.opc_start_b1(uuid,uuid,text,text,uuid,text)'::regprocedure);
 IF position('-- R8b step skill' IN definition)=0 THEN
  needle:=' result:=opc_start(p_actor_id,p_request_id,p_registration,p_mode);';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'STEP_SKILL_B1_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,needle||E'\n -- R8b step skill\n'
   ||' IF EXISTS(SELECT 1 FROM artifact_projects WHERE id=(result->>''projectId'')::uuid AND work_kind=''step_skill'') THEN'
   ||E'\n  IF p_business_id IS NOT NULL THEN RAISE EXCEPTION ''OPC_BUSINESS_DENIED''; END IF;'
   ||E'\n  RETURN result;\n END IF;');
 END IF;

 -- Only a positioning version is a positioning source. Inlined (not opc_is_positioning_workflow) so a
 -- caller without that helper's grant cannot turn a permission error into a silent false.
 definition:=pg_get_functiondef('public.opc_source_allowed(uuid,uuid)'::regprocedure);
 IF position('-- R8b positioning only' IN definition)=0 THEN
  needle:=' IF p.id IS NULL OR r.id IS NULL OR NOT artifact_evidence_allowed(p.id,v.evidence_ids) THEN RETURN false;END IF;';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'STEP_SKILL_SOURCE_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,needle||E'\n -- R8b positioning only\n'
   ||' IF p.work_kind=''step_skill'' OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->''steps'') s,'
   ||'jsonb_array_elements(CASE WHEN jsonb_typeof(s->''information'')=''array'' THEN s->''information'' ELSE ''[]'' END) f'
   ||' WHERE jsonb_typeof(f->''profileKey'')=''string'' AND f->>''profileKey''<>'''') THEN RETURN false;END IF;');
 END IF;

 -- The legacy saved-project list already hides positioning, account and result projects.
 definition:=pg_get_functiondef('public.artifact_query(uuid,text,uuid,uuid)'::regprocedure);
 IF position('''step_skill''' IN definition)=0 THEN
  needle:='p.work_kind IN (''positioning'',''account'',''result'')';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'STEP_SKILL_QUERY_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'p.work_kind IN (''positioning'',''account'',''result'',''step_skill'')');
 END IF;

 -- Owner 2026-10-13 (R8b decision 1): a finalized step Skill report is a result, not a positioning, so
 -- finalization offers no first-week topics next step.
 definition:=pg_get_functiondef('public.report_document_source(uuid,uuid)'::regprocedure);
 IF position('''step_skill''' IN definition)=0 THEN
  needle:='''next'',CASE WHEN v.id IS NOT NULL AND EXISTS(';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'STEP_SKILL_REPORT_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'''next'',CASE WHEN v.id IS NOT NULL AND p.work_kind<>''step_skill'' AND EXISTS(');
 END IF;

 -- A social-kind step Skill round is bound to its draft exactly like a positioning round.
 definition:=pg_get_functiondef('public.artifact_round_account_guard()'::regprocedure);
 IF position('''step_skill''' IN definition)=0 THEN
  needle:='IF p.work_kind=''positioning'' AND EXISTS(SELECT 1 FROM opc_drafts d';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'STEP_SKILL_GUARD_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,'IF p.work_kind IN (''positioning'',''step_skill'') AND EXISTS(SELECT 1 FROM opc_drafts d');
 END IF;
END $$;
-- Modules whose enabled registration is a step flow (every step declares information fields). They start
-- only from their own entry, so the flat Skill list leaves them out. No package reads and no registry cap,
-- unlike the catalog; module ids only.
CREATE OR REPLACE FUNCTION public.opc_step_flow_modules() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(DISTINCT w.module_id),'[]') FROM artifact_workflows w
 WHERE w.enabled AND jsonb_typeof(w.workflow->'steps')='array' AND jsonb_array_length(w.workflow->'steps')>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(w.workflow->'steps') s
   WHERE jsonb_typeof(s->'information') IS DISTINCT FROM 'array' OR jsonb_array_length(s->'information')=0)
$$;
REVOKE ALL ON FUNCTION public.opc_step_flow_modules() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.opc_step_flow_modules() TO service_role;
COMMIT;
