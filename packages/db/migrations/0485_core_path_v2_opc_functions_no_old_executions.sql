-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch R1a: positioning / topic / work-item functions drop their old-path branches (runtime_executions,
-- runtime_history_available/availability, bill2_runs/calls, fusion_billing_groups, fusion_review_fees), the same way 0458 did for
-- runtime_work_projection. Each removed branch reads a row that only the old path writes, so it is empty or false for turn-path data:
-- the results for turn-path data are unchanged. Staging holds old-path test rows only (0458's header); production was built new.
--   opc_query_before_mentor_basis / opc_query_before_entry_projection / opc_query: the turns projection and capture-availability read the
--     turn path's own bindings (the page adds them); 'informationVersion' stays a JSON null as before for turn-path rows.
--   opc_topic_read / opc_topic_original / opc_data_source_turn / opc_adopt_topics_with_source: a topic reply is a turn's reply only.
--   opc_content_allowed / opc_result_link_available: a link or version sourced from an old execution is no longer available (as 0462's rule).
--   opc_business_archive: the old provider-call busy check becomes a turn check (a running turn of the business makes archive BUSY);
--   opc_review_archive_guard / opc_target_business: the old provider-call (run / execution) branches go.
-- Repeatable: whole-function CREATE OR REPLACE. Recovery: re-apply the previous text from git history; nothing is written or removed.
BEGIN;
SET LOCAL lock_timeout='5s';

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

CREATE OR REPLACE FUNCTION public.opc_content_allowed(p_actor_id uuid, p_content_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE current_id uuid:=p_content_id;seen uuid[]:='{}';c opc_content_versions;i opc_items;p artifact_projects;
BEGIN
 -- D7 read boundary
 IF EXISTS(SELECT 1 FROM opc_content_versions WHERE id=p_content_id AND actor_id=p_actor_id AND erased_at IS NOT NULL) THEN RETURN false; END IF;
 LOOP
  IF current_id IS NULL THEN RETURN true;END IF;
  IF current_id=ANY(seen) THEN RETURN false;END IF;
  SELECT * INTO c FROM opc_content_versions WHERE id=current_id AND actor_id=p_actor_id;
  IF NOT FOUND OR c.erased_at IS NOT NULL THEN RETURN false;END IF;
  SELECT wi.* INTO i FROM opc_items wi WHERE wi.work_item_id=c.work_item_id;
  SELECT ap.* INTO p FROM artifact_projects ap WHERE ap.id=i.work_item_id AND ap.actor_id=p_actor_id;
  IF i.work_item_id IS NULL OR p.id IS NULL OR NOT opc_source_allowed(p_actor_id,i.source_version_id)
   OR c.execution_id IS NOT NULL
   OR (c.turn_id IS NOT NULL AND NOT opc_content_turn_available(p_actor_id,c.turn_id)) THEN RETURN false;END IF;
  seen:=array_append(seen,current_id);current_id:=c.source_content_id;
 END LOOP;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_data_source_turn(a uuid, eid uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT t.id FROM turns t WHERE t.actor_id=a AND t.request_id=eid AND t.kind='chat'
$function$;

CREATE OR REPLACE FUNCTION public.opc_result_link_available(l opc_result_links)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE tomb jsonb;
BEGIN
 IF l.execution_id IS NOT NULL THEN RETURN false; END IF;
 SELECT turn_tombstones(t.actor_id,t.session_id,'{}'::jsonb) INTO tomb FROM turns t
  WHERE t.actor_id=l.turn_actor_id AND t.id=l.turn_id AND t.state='closed' AND t.delivered;
 RETURN tomb IS NOT NULL AND NOT (tomb->>'sessionTombstoned')::boolean AND NOT (tomb->>'accountErasing')::boolean;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_query_before_entry_projection(p_actor_id uuid, p_draft_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE projection jsonb;turns jsonb;
BEGIN
 projection:=opc_query_before_mentor_basis(p_actor_id,p_draft_id);
 IF p_draft_id IS NULL THEN RETURN projection;END IF;
 SELECT coalesce(jsonb_agg(t.value||jsonb_build_object('informationVersion',NULL::jsonb) ORDER BY t.ord),'[]')
 INTO turns FROM jsonb_array_elements(projection->'turns') WITH ORDINALITY t(value,ord);
 RETURN jsonb_set(projection,'{turns}',turns);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_query_before_mentor_basis(p_actor_id uuid, p_draft_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0249 readonly list

-- 0249 readonly flag

-- 0249 readonly read

DECLARE d opc_drafts;result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_draft_id IS NULL THEN
  RETURN jsonb_build_object('drafts',(SELECT coalesce(jsonb_agg(jsonb_build_object('draftId',draft_id,'sessionId',session_id,'projectId',project_id,'roundId',round_id,'mode',mode,'conversationDeleted',opc_draft_readonly(p_actor_id,draft_id),
   'topicSessionId',(SELECT t.session_id FROM opc_topic_workspaces t WHERE t.draft_id=opc_drafts.draft_id AND t.actor_id=p_actor_id))),'[]') FROM opc_drafts
   WHERE actor_id=p_actor_id AND (NOT EXISTS(SELECT 1 FROM bill2_drafts b WHERE b.id=opc_drafts.draft_id AND b.revoked)
    OR (opc_draft_readonly(p_actor_id,draft_id) AND opc_draft_has_confirmed(draft_id)))),
   'accounts',(SELECT coalesce(jsonb_agg(jsonb_build_object('projectId',ac.project_id,'platform',platform,'account',account_key,'revision',revision,'sourceVersionId',ac.source_version_id,'profile',CASE WHEN opc_source_allowed(p_actor_id,ac.source_version_id) THEN opc_profile(ac.source_version_id) ELSE NULL END,
    'items',(SELECT coalesce(jsonb_agg(jsonb_build_object('workItemId',i.work_item_id,'title',w.work_title,'day',i.day,'brief',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) THEN i.brief ELSE NULL END,'sessionId',ss.id)),'[]') FROM opc_items i JOIN artifact_projects w ON w.id=i.work_item_id JOIN runtime_sessions ss ON ss.actor_id=p_actor_id AND ss.scope=jsonb_build_object('kind','work_item','projectId',ac.project_id,'workItemId',i.work_item_id) WHERE i.account_project_id=ac.project_id))),'[]') FROM opc_accounts ac WHERE actor_id=p_actor_id));
 END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR (NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id))
  AND NOT opc_draft_readonly(p_actor_id,d.draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 result:=artifact_query(p_actor_id,'read',d.project_id,d.round_id);
 RETURN jsonb_build_object('conversationDeleted',opc_draft_readonly(p_actor_id,d.draft_id),'draftId',d.draft_id,'sessionId',d.session_id,'projectId',d.project_id,'roundId',d.round_id,'mode',d.mode,'snapshot',result,'information',(SELECT jsonb_object_agg(x->>'id',jsonb_build_object('schema',x->'information','values',r.steps->(x->>'id')->'information','reached',opc_historical_reach(p_actor_id,d.draft_id,x->>'id'))) FROM artifact_rounds r,jsonb_array_elements(r.workflow->'steps') x WHERE r.id=d.round_id),
 'turns','[]'::jsonb,
 'report',artifact_transition(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),'report',d.project_id,d.round_id),
 'plans',(SELECT coalesce(jsonb_agg(jsonb_build_object('planId',id,'version',version,'sourceVersionId',source_version_id,'body',CASE WHEN opc_source_allowed(p_actor_id,source_version_id) THEN body ELSE NULL END) ORDER BY version DESC),'[]') FROM opc_plans WHERE draft_id=d.draft_id),
 'handoffs',(SELECT coalesce(jsonb_agg(jsonb_build_object('requestId',request_id,'result',h.result)),'[]') FROM opc_handoffs h WHERE draft_id=d.draft_id));
END $function$;

CREATE OR REPLACE FUNCTION public.opc_query(p_actor_id uuid, p_draft_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
-- 0249 readonly projection

DECLARE projection_result jsonb;information jsonb;binding opc_account_strategy_drafts;source_r artifact_rounds;source_information jsonb;capture_round artifact_rounds;st jsonb;step_id text;field_id text;meta jsonb;metas jsonb;available_ids uuid[];
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
  available_ids:='{}';
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
  'opening',CASE WHEN o.request_id IS NOT NULL THEN jsonb_build_object('draftId',p_draft_id,'requestId',o.request_id,'input',o.input,'executionId',(SELECT t.request_id FROM turns t WHERE t.actor_id=p_actor_id AND t.session_id=w.session_id AND t.request_id=o.request_id)) ELSE NULL END);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_topic_original(a uuid, did uuid, vid uuid, eid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE w opc_topic_workspaces;d opc_drafts;raw text;part text[];candidate jsonb;result jsonb;source_turn jsonb;source_session uuid;
BEGIN
 -- CORE-PATH-V2 V2-12: eid is a topic turn's request id (the page's handle, as for a report); an old execution is no source.
 IF opc_data_source_turn(a,eid) IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 source_turn:=opc_data_turn(a,eid);source_session:=(source_turn->>'sessionId')::uuid;raw:=source_turn->>'body';
 SELECT * INTO d FROM opc_drafts WHERE draft_id=did AND actor_id=a;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=did AND actor_id=a;
 IF d.draft_id IS NULL OR w.session_id IS DISTINCT FROM source_session OR w.source_version_id IS DISTINCT FROM vid
  OR NOT opc_source_allowed(a,vid) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 -- A reply from before the workspace was re-bound to a newer positioning is no source: it cannot be saved or adopted on the new version.
 IF w.history_floor_seq>0 AND (EXISTS(SELECT 1 FROM turns t JOIN session_messages m ON m.turn_id=t.id
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

CREATE OR REPLACE FUNCTION public.opc_business_archive(p_actor_id uuid, p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE b opc_businesses;
BEGIN
 -- 0326 Fusion run archive guard
 PERFORM bill2_actor(p_actor_id);
 -- Exactly the same user row lock as opc_start_b1: archive/count/insert serialize.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPC_DENIED'; END IF;
 -- Mutations/dispatch keep a KEY SHARE lock until commit. NOWAIT avoids reversing
 -- existing business -> financial profile lock order: the owner retries a busy archive.
 BEGIN
  SELECT * INTO b FROM opc_businesses WHERE id=p_business_id AND actor_id=p_actor_id
   AND erased_at IS NULL FOR UPDATE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END;
 IF b.id IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED'; END IF;
 IF b.archived_at IS NULL THEN
  -- A turn still running for this business must close first (its model call may be in flight and its freeze is open); the owner retries.
  IF EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_actor_id AND t.state IN ('opening','running','stopping')
   AND opc_target_business(p_actor_id,jsonb_build_object('sessionId',t.session_id))=b.id) THEN
   RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END IF;
  UPDATE opc_businesses SET archived_at=clock_timestamp(),revision=revision+1
   WHERE id=b.id RETURNING * INTO b;
 END IF;
 RETURN jsonb_build_object('businessId',b.id,'name',b.name,'archivedAt',b.archived_at,'isArchived',true);
END $function$;

CREATE OR REPLACE FUNCTION public.opc_target_business(a uuid, t jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE scope jsonb;bid uuid;pid uuid;did uuid;
BEGIN
 IF t->>'sessionId' IS NOT NULL THEN
  SELECT s.scope INTO scope FROM runtime_sessions s WHERE s.id=(t->>'sessionId')::uuid AND s.actor_id=a;
 ELSE scope:=t; END IF;
 did:=coalesce(scope->>'draftId',t->>'draftId')::uuid;
 pid:=coalesce(scope->>'workItemId',scope->>'projectId')::uuid;
 SELECT b.id INTO bid FROM opc_businesses b WHERE b.actor_id=a AND (
  b.id=(t->>'businessId')::uuid OR EXISTS(
   SELECT 1 FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id=db.draft_id
    WHERE db.business_id=b.id AND d.actor_id=a AND (d.draft_id=did OR d.project_id=pid)) OR EXISTS(
   SELECT 1 FROM opc_accounts ac WHERE ac.business_id=b.id AND ac.actor_id=a
    AND (ac.project_id=pid OR EXISTS(SELECT 1 FROM opc_items i
     WHERE i.account_project_id=ac.project_id AND i.work_item_id=pid))));
 RETURN bid;
END $function$;

CREATE OR REPLACE FUNCTION public.opc_review_archive_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL AND (
  EXISTS(SELECT 1 FROM fusion_reviews rv WHERE rv.actor_id=NEW.actor_id
   AND rv.state IN ('running','paused')
   AND opc_target_business(NEW.actor_id,jsonb_build_object('draftId',rv.draft_id))=NEW.id)
 ) THEN RAISE EXCEPTION 'OPC_BUSINESS_BUSY'; END IF;
 RETURN NEW;
END $function$;

COMMIT;
