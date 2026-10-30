-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-5b (the positioning mentor, the rest; docs/launch/tasks/CORE-PATH-V2.md 2.7, 4.2).
-- MIGRATION NUMBER IS A LOCAL PLACEHOLDER until the controller assigns one (after 0423).
--   turn_mentor_source_available  whether a suggestion written by a new-path mentor turn (turn_mentor_apply stores the turn's
--                        request id where the old path stored the execution id) is still shown: a completed mentor turn of
--                        this session, whose messages are still visible, that captured into this round. The new-path
--                        counterpart of the old runtime_executions / opc_turns / runtime_history_available check.
--   opc_query            0423 unchanged except that such suggestions (and withdrawn suggestions) are no longer hidden.
--   opc_capture_resolve  0423 unchanged except that such a suggestion can be accepted, ignored or dismissed; an old-path
--                        execution id keeps the old checks exactly.
-- Compatibility: additive; old-path suggestions keep exactly their rules. Repeatable: CREATE OR REPLACE throughout.
-- Recovery: re-apply 0423's opc_query and opc_capture_resolve and drop turn_mentor_source_available; no data changes.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_mentor_source_available(p_actor_id uuid, p_session_id uuid, p_request_id uuid,
  p_project_id uuid, p_round_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM turns t JOIN runtime_sessions s ON s.id = t.session_id AND s.actor_id = p_actor_id
    WHERE t.actor_id = p_actor_id AND t.request_id = p_request_id AND t.kind = 'mentor' AND t.session_id = p_session_id
      AND t.close_kind = 'completed' AND s.content_deleted_at IS NULL AND s.erased_at IS NULL
      -- Deleting the conversation (or the turn's messages) takes its suggestions out of view, as runtime_history_available did.
      AND EXISTS (SELECT 1 FROM session_messages m WHERE m.session_id = t.session_id AND m.turn_id = t.id AND m.visible
                  AND m.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM artifact_requests cap WHERE cap.project_id = p_project_id AND cap.round_id = p_round_id
                  AND cap.action = 'opc_capture'
                  AND cap.request_id = overlay(md5('opc_capture:' || p_request_id::text) placing 'f' from 13 for 1)::uuid))
$function$;

CREATE OR REPLACE FUNCTION public.opc_query(p_actor_id uuid, p_draft_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0249 readonly projection

DECLARE projection_result jsonb;information jsonb;binding opc_account_strategy_drafts;source_r artifact_rounds;source_information jsonb;capture_round artifact_rounds;st jsonb;step_id text;field_id text;meta jsonb;metas jsonb;ids uuid[];available_ids uuid[];
BEGIN
 -- D7 read boundary
 IF EXISTS(SELECT 1 FROM opc_drafts d JOIN artifact_projects p ON p.id=d.project_id WHERE d.actor_id=p_actor_id AND d.draft_id=p_draft_id AND p.erased_at IS NOT NULL) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 projection_result:=opc_query_before_entry_projection(p_actor_id,p_draft_id);
 IF p_draft_id IS NOT NULL THEN
  -- The predecessor already verifies actor ownership and source access. Only
  -- successful immutable writes of this same project/round/step can prove a
  -- field was confirmed; a revision may also inherit confirmed fields from its
  -- exact published predecessor. Reach alone includes deferred questions.
  SELECT jsonb_object_agg(info.key,info.value || jsonb_build_object('previouslyConfirmed',coalesce((
   SELECT jsonb_agg(field->>'id' ORDER BY ord)
   FROM jsonb_array_elements(info.value->'schema') WITH ORDINALITY fields(field,ord)
   WHERE EXISTS(SELECT 1 FROM artifact_requests a
    WHERE a.project_id=(projection_result->>'projectId')::uuid AND a.round_id=(projection_result->>'roundId')::uuid
     AND a.action='opc_information' AND a.payload->>'stepId'=info.key
     AND a.payload->'values'->(field->>'id')->>'status'='confirmed')
    OR EXISTS(SELECT 1 FROM artifact_requests revision
     JOIN artifact_rounds prior ON prior.id=(revision.payload->>'fromRoundId')::uuid
      AND prior.project_id=revision.project_id AND prior.state='published'
     WHERE revision.project_id=(projection_result->>'projectId')::uuid AND revision.round_id=(projection_result->>'roundId')::uuid
      AND revision.request_id=revision.round_id AND revision.action='opc_revision'
      AND prior.steps->info.key->'information'->(field->>'id')->>'status'='confirmed')
  ),'[]'::jsonb))) INTO information FROM jsonb_each(projection_result->'information') info;
  SELECT * INTO binding FROM opc_account_strategy_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
  IF binding.draft_id IS NOT NULL THEN
   SELECT r.* INTO source_r FROM artifact_versions v JOIN artifact_rounds r ON r.id=v.round_id WHERE v.id=binding.base_source_version_id;
   SELECT jsonb_object_agg(step->>'id',jsonb_build_object('title',step->>'title','schema',step->'information','values',source_r.steps->(step->>'id')->'information'))
    INTO source_information FROM jsonb_array_elements(source_r.workflow->'steps') step;
   projection_result:=projection_result||jsonb_build_object('accountRevision',jsonb_build_object('accountProjectId',binding.account_project_id,
    'sourceVersionId',binding.base_source_version_id,'officialVersion',jsonb_array_length(opc_account_strategy_history(p_actor_id,binding.account_project_id)),
    'methodConflict',source_r.workflow IS DISTINCT FROM (SELECT workflow FROM artifact_rounds WHERE id=(projection_result->>'roundId')::uuid) OR source_r.revision_id IS DISTINCT FROM (SELECT revision_id FROM artifact_rounds WHERE id=(projection_result->>'roundId')::uuid),
    'sourceInformation',source_information));
   IF NOT (projection_result->'accountRevision'->>'methodConflict')::boolean THEN
    SELECT jsonb_object_agg(info.key,info.value||jsonb_build_object(
     'reached',(SELECT jsonb_agg(field->>'id') FROM jsonb_array_elements(info.value->'schema') field),
     'previouslyConfirmed',(SELECT coalesce(jsonb_agg(field->>'id'),'[]') FROM jsonb_array_elements(info.value->'schema') field
      WHERE info.value->'previouslyConfirmed' ? (field->>'id') OR source_r.steps->info.key->'information'->(field->>'id')->>'status'='confirmed')))
     INTO information FROM jsonb_each(information) info;
   END IF;
  END IF;
  SELECT * INTO capture_round FROM artifact_rounds WHERE id=(projection_result->>'roundId')::uuid;
  SELECT coalesce(array_agg(e.id),'{}') INTO ids FROM runtime_executions e JOIN opc_turns t ON t.session_id=e.session_id AND t.request_id=e.request_id
   WHERE t.round_id=capture_round.id AND t.draft_id=p_draft_id AND t.purpose='mentor' AND t.token::text=e.payload->>'opcTurnToken'
    AND e.state='completed' AND e.payload->>'revisionId'=capture_round.revision_id::text
    AND e.payload->>'moduleId'=(SELECT module_id::text FROM artifact_projects WHERE id=capture_round.project_id)
    AND e.payload#>>'{scopeMaterial,content,work,roundId}'=capture_round.id::text
    AND e.session_id=(projection_result->>'sessionId')::uuid AND e.actor_id=p_actor_id
    AND EXISTS(SELECT 1 FROM jsonb_each(capture_round.steps) s,jsonb_each(coalesce(s.value->'fieldMeta','{}')) m
     WHERE e.id::text IN (m.value#>>'{suggestion,executionId}',m.value#>>'{withdrawnSuggestion,executionId}'));
  SELECT coalesce(array_agg(execution_id),'{}') INTO available_ids FROM runtime_history_availability(ids) WHERE available;
  -- V2-5b: suggestions a mentor turn of the new path wrote; their executionId is that turn's request id (turn_mentor_apply).
  SELECT available_ids||coalesce(array_agg(x.id),'{}') INTO available_ids FROM (
   SELECT DISTINCT (m.value#>>ARRAY[k,'executionId'])::uuid id FROM jsonb_each(capture_round.steps) s,
    jsonb_each(coalesce(s.value->'fieldMeta','{}')) m, unnest(ARRAY['suggestion','withdrawnSuggestion']) k
   WHERE m.value#>>ARRAY[k,'executionId'] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT coalesce((m.value#>>ARRAY[k,'executionId'])=ANY(available_ids::text[]),false)) x
  WHERE turn_mentor_source_available(p_actor_id,(projection_result->>'sessionId')::uuid,x.id,capture_round.project_id,capture_round.id);
  FOR step_id,st IN SELECT key,value FROM jsonb_each(capture_round.steps) LOOP
   metas:='{}';
   FOR field_id IN SELECT f->>'id' FROM jsonb_array_elements(information->step_id->'schema') f LOOP
    meta:=coalesce(st->'fieldMeta'->field_id,'{}')-'fp';
    IF meta ? 'suggestion' AND NOT coalesce((meta#>>'{suggestion,executionId}')=ANY(available_ids::text[]),false)
    THEN meta:=meta-'suggestion';END IF;
    -- v3 suggestion withdraw: hide a withdrawn record whose source conversation is unavailable.
    IF meta ? 'withdrawnSuggestion' AND NOT coalesce((meta#>>'{withdrawnSuggestion,executionId}')=ANY(available_ids::text[]),false)
    THEN meta:=meta-'withdrawnSuggestion';END IF;
    meta:=meta||jsonb_build_object('protected',NOT coalesce(NOT coalesce((st->>'valid')::boolean,false)
 AND coalesce(st->'information'->(field_id)->>'status','unknown') NOT IN ('confirmed','deferred') AND (
  (st->'fieldMeta'->(field_id)->>'source'='capture' AND st->'fieldMeta'->(field_id)->>'fp'=artifact_hash(st->'information'->(field_id))
   AND EXISTS(SELECT 1 FROM artifact_requests cap WHERE cap.project_id=capture_round.project_id AND cap.round_id=capture_round.id
    AND cap.request_id=overlay(md5('opc_capture:'||(st->'fieldMeta'->(field_id)->>'executionId')) placing 'f' from 13 for 1)::uuid
    AND cap.action='opc_capture' AND cap.payload->>'executionId'=st->'fieldMeta'->(field_id)->>'executionId'
    AND cap.response->'versions' ? (step_id)
    AND NOT EXISTS(SELECT 1 FROM artifact_requests manual WHERE manual.project_id=capture_round.project_id AND manual.round_id=capture_round.id
     AND manual.action='opc_information' AND manual.payload->>'stepId'=(step_id)
     AND (manual.payload->>'expectedVersion')::integer >= (cap.response->'versions'->>(step_id))::integer
     AND artifact_hash(manual.payload->'values'->(field_id)) IS DISTINCT FROM st->'fieldMeta'->(field_id)->>'fp')))
  OR (st->'fieldMeta'->(field_id)->>'source' IS NULL AND coalesce(st->'information'->(field_id)->>'value','')='' AND coalesce(st->'information'->(field_id)->>'status','unknown')='unknown'
   AND NOT EXISTS(SELECT 1 FROM artifact_requests history WHERE history.project_id=capture_round.project_id AND history.round_id=capture_round.id
    AND ((history.action='opc_information' AND history.payload->>'stepId'=(step_id)
      AND coalesce(history.payload->'values'->(field_id)->>'value','')<>'')
     OR (history.action='opc_capture' AND history.response->'fields'->(step_id) ? (field_id)))))
 ),false));
    metas:=metas||jsonb_build_object(field_id,meta);
   END LOOP;
   information:=jsonb_set(information,ARRAY[step_id],information->step_id||jsonb_build_object('meta',metas,'notes',coalesce(st->'notes','[]')));
  END LOOP;
  RETURN opc_readonly_projection(jsonb_set(projection_result,'{information}',coalesce(information,'{}'::jsonb)));
 END IF;
 projection_result:=jsonb_set(projection_result,'{drafts}',coalesce((SELECT jsonb_agg(entry || jsonb_build_object(
   'businessId',b.id,'businessName',b.name,'createdAt',p.created_at,'currentVersion',p.current_version,'state',r.state) ORDER BY p.created_at DESC,p.id)
  FROM jsonb_array_elements(projection_result->'drafts') entry
  JOIN opc_drafts d ON d.draft_id=(entry->>'draftId')::uuid AND d.actor_id=p_actor_id
  JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
  JOIN opc_businesses b ON b.id=db.business_id AND b.actor_id=p_actor_id
  JOIN artifact_projects p ON p.id=d.project_id AND p.actor_id=p_actor_id
  JOIN artifact_rounds r ON r.id=d.round_id),'[]'::jsonb));
 projection_result:=jsonb_set(projection_result,'{accounts}',coalesce((SELECT jsonb_agg(jsonb_set(account,'{items}',coalesce((
  SELECT jsonb_agg(item || jsonb_build_object('moduleId',p.module_id,'methodRevisionId',r.revision_id))
  FROM jsonb_array_elements(account->'items') item
  JOIN artifact_projects p ON p.id=(item->>'workItemId')::uuid AND p.actor_id=p_actor_id
  JOIN opc_items i ON i.work_item_id=p.id
  JOIN artifact_versions v ON v.id=i.source_version_id
  JOIN artifact_rounds r ON r.id=v.round_id
 ),'[]'::jsonb))) FROM jsonb_array_elements(projection_result->'accounts') account),'[]'::jsonb));
 RETURN projection_result;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_capture_resolve(p_actor_id uuid, p_draft_id uuid, p_request_id uuid, p_step_id text, p_field_id text, p_execution_id uuid, p_hash text, p_action text, p_expected_version integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- R9 accepted provenance

DECLARE d opc_drafts;r artifact_rounds;req artifact_requests;payload jsonb;st jsonb;meta jsonb;suggestion jsonb;
 value jsonb;information jsonb;version integer;response jsonb;e runtime_executions;t opc_turns;
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
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=d.session_id AND actor_id=p_actor_id;
 IF e.id IS NOT NULL THEN
  SELECT * INTO t FROM opc_turns WHERE session_id=d.session_id AND request_id=e.request_id;
  IF t.token::text IS DISTINCT FROM e.payload->>'opcTurnToken' OR t.purpose IS DISTINCT FROM 'mentor'
   OR NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 -- V2-5b: a suggestion of a mentor turn on the new path (its id is the turn's request id), still available in this round.
 ELSIF NOT turn_mentor_source_available(p_actor_id,d.session_id,p_execution_id,d.project_id,r.id) THEN
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
  OR suggestion IS NULL OR r.state<>'draft' OR (e.id IS NOT NULL AND t.round_id<>r.id) THEN RAISE EXCEPTION 'OPC_SUGGESTION_CHANGED';END IF;
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

DO $$
BEGIN
  EXECUTE 'REVOKE ALL ON FUNCTION public.turn_mentor_source_available(uuid,uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role';
END $$;

COMMIT;
