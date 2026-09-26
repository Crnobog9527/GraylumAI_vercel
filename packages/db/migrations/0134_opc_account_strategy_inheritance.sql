/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Account revisions inherit the exact published method and answers. No new
-- content store: the existing draft, requests, evidence and confirmations remain
-- authoritative. Existing drafts are repaired only on their explicit begin.
BEGIN;
CREATE OR REPLACE FUNCTION opc_account_strategy_begin(p_actor_id uuid,p_account_project_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a opc_accounts;binding opc_account_strategy_drafts;d opc_drafts;source_d opc_drafts;
 source_v artifact_versions;source_r artifact_rounds;r artifact_rounds;project uuid;round uuid;session jsonb;
 states jsonb;st jsonb;original jsonb;seed jsonb;values_now jsonb;field jsonb;k text;changed text[]:='{}';
 existing boolean:=false;untouched boolean;pass integer;ev uuid:=gen_random_uuid();payload jsonb;descriptor jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_account_project_id IS NULL THEN RAISE EXCEPTION 'OPC_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_account_project_id::text,125));
 SELECT * INTO a FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF a.project_id IS NULL OR NOT opc_source_allowed(p_actor_id,a.source_version_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF d.draft_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM opc_account_strategy_drafts WHERE draft_id=d.draft_id AND account_project_id=p_account_project_id)
   THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id);
 END IF;
 SELECT * INTO binding FROM opc_account_strategy_drafts WHERE account_project_id=p_account_project_id AND current FOR UPDATE;
 IF binding.draft_id IS NOT NULL THEN
  SELECT * INTO d FROM opc_drafts WHERE draft_id=binding.draft_id AND actor_id=p_actor_id;
  PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
  SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
  IF r.state='draft' THEN
   IF EXISTS(SELECT 1 FROM artifact_requests h WHERE h.project_id=d.project_id AND h.round_id=r.id AND (h.action='opc_account_inherit' OR (h.action='opc_revision' AND h.payload->>'fromRoundId'=(SELECT round_id::text FROM artifact_versions WHERE id=binding.base_source_version_id)))) THEN
    RETURN jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id);
   END IF;
   existing:=true;
  ELSIF r.state<>'published' THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 END IF;
 SELECT * INTO source_v FROM artifact_versions WHERE id=CASE WHEN existing THEN binding.base_source_version_id ELSE a.source_version_id END;
 IF NOT opc_source_allowed(p_actor_id,source_v.id) THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
 SELECT * INTO source_r FROM artifact_rounds WHERE id=source_v.round_id;
 SELECT * INTO source_d FROM opc_drafts WHERE project_id=source_v.project_id AND actor_id=p_actor_id;
 IF source_d.draft_id IS NULL OR a.business_id IS NULL THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
 IF existing AND (r.workflow IS DISTINCT FROM source_r.workflow OR r.revision_id IS DISTINCT FROM source_r.revision_id) THEN
  -- Never rewrite a pinned method or guess a cross-method field mapping.
  RETURN jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id);
 END IF;
 IF NOT existing THEN
  descriptor:=read_skill_package(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=source_v.project_id),
   (SELECT skill_id FROM artifact_projects WHERE id=source_v.project_id),source_r.revision_id,source_r.package_hash,NULL);
  PERFORM artifact_validate_workflow(source_r.workflow,descriptor);PERFORM opc_information_schema(source_r.workflow);
  project:=gen_random_uuid();round:=gen_random_uuid();
  session:=runtime_start(p_actor_id,p_request_id,jsonb_build_object('scope',jsonb_build_object('kind','positioning_draft')));
  INSERT INTO artifact_projects(id,actor_id,module_id,skill_id,work_kind)
   SELECT project,p_actor_id,module_id,skill_id,'positioning' FROM artifact_projects WHERE id=source_v.project_id;
  INSERT INTO opc_drafts VALUES((session->'scope'->>'draftId')::uuid,p_actor_id,project,round,(session->>'sessionId')::uuid,p_request_id,source_d.registration,'mentor') RETURNING * INTO d;
  INSERT INTO opc_draft_businesses VALUES(d.draft_id,a.business_id);
  INSERT INTO artifact_rounds(id,project_id,revision_id,package_hash,workflow,workflow_hash,template_hash,steps)
   VALUES(round,project,source_r.revision_id,source_r.package_hash,source_r.workflow,source_r.workflow_hash,source_r.template_hash,'{}') RETURNING * INTO r;
  IF binding.draft_id IS NOT NULL THEN UPDATE opc_account_strategy_drafts SET current=false WHERE draft_id=binding.draft_id;END IF;
  INSERT INTO opc_account_strategy_drafts(account_project_id,draft_id,actor_id,root_source_version_id,base_source_version_id,base_account_revision)
   VALUES(a.project_id,d.draft_id,p_actor_id,coalesce(binding.root_source_version_id,source_v.id),source_v.id,a.revision);
 END IF;
 IF source_v.project_id=d.project_id THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
 -- One local revision evidence references the exact immutable source. The
 -- normal evidence/scope checks below recheck that source on every use.
 payload:=jsonb_build_object('sourceVersionId',source_v.id,'sourceRoundId',source_r.id);
 INSERT INTO artifact_evidence(id,project_id,kind,payload,content_hash) VALUES(ev,d.project_id,'revision',payload,artifact_hash(payload));
 INSERT INTO artifact_evidence_restrictions(evidence_id) VALUES(ev);
 INSERT INTO artifact_requests VALUES(d.project_id,gen_random_uuid(),r.id,'opc_account_inherit',payload,jsonb_build_object('evidenceId',ev));
 states:='{}';
 FOR k,original IN SELECT * FROM jsonb_each(source_r.steps) LOOP
  st:=r.steps->k;values_now:=original->'information';untouched:=true;
  IF existing THEN
   -- Only the original legacy seed (version zero) proves which fields were
   -- mechanically projected. Any later distinct user value/status is retained.
   SELECT h.payload->'values' INTO seed FROM artifact_requests h
    WHERE h.project_id=d.project_id AND h.round_id=r.id AND h.action='opc_information'
     AND h.payload->>'stepId'=k AND h.payload->>'expectedVersion'='0';
   IF seed IS NULL THEN values_now:=st->'information';untouched:=false;
   ELSE
    FOR field IN SELECT x FROM jsonb_array_elements((SELECT x FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=k)->'information') x LOOP
     IF EXISTS(SELECT 1 FROM artifact_requests h WHERE h.project_id=d.project_id AND h.round_id=r.id AND h.action='opc_information'
      AND h.payload->>'stepId'=k AND (h.payload->>'expectedVersion')::int>0
      AND h.payload->'values'->(field->>'id') IS DISTINCT FROM seed->(field->>'id')) THEN
      values_now:=jsonb_set(values_now,ARRAY[field->>'id'],st->'information'->(field->>'id'));untouched:=false;
     END IF;
    END LOOP;
   END IF;
   IF EXISTS(SELECT 1 FROM artifact_requests h WHERE h.project_id=d.project_id AND h.round_id=r.id AND h.action IN ('save','confirm') AND h.payload->>'stepId'=k) THEN untouched:=false;END IF;
  END IF;
  IF untouched THEN
   st:=original||jsonb_build_object('information',values_now,'version',coalesce((st->>'version')::int,0)+1,'reviewVersion',coalesce((st->>'reviewVersion')::int,0)+1,
    'evidenceIds',jsonb_build_array(ev),'provenanceIds',jsonb_build_array(ev),'confirmationId',NULL,'valid',false);
  ELSE
   st:=st||jsonb_build_object('information',values_now,'version',(st->>'version')::int+1,'confirmationId',NULL,'valid',false);
   changed:=array_append(changed,k);
  END IF;
  states:=jsonb_set(states,ARRAY[k],st);
 END LOOP;
 FOREACH k IN ARRAY changed LOOP states:=artifact_invalidate(r.workflow,states,k);END LOOP;
 UPDATE artifact_rounds SET steps=states WHERE id=r.id;
 -- Rebind unchanged published confirmations via the existing validation path;
 -- dependencies, required information, evidence and body rules still apply.
 -- Workflow display order need not be dependency order. Each pass confirms
 -- only ready steps; the validated acyclic workflow has at most 32 steps.
 FOR pass IN 1..jsonb_array_length(r.workflow->'steps') LOOP
  FOR field IN SELECT x FROM jsonb_array_elements(r.workflow->'steps') x LOOP
   k:=field->>'id';
   SELECT steps INTO states FROM artifact_rounds WHERE id=r.id;st:=states->k;
   IF k=ANY(changed) OR coalesce((st->>'valid')::boolean,false)
    OR NOT coalesce((source_r.steps->k->>'valid')::boolean,false)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(field->'dependsOn') dep WHERE NOT coalesce((states->dep->>'valid')::boolean,false)) THEN CONTINUE;END IF;
   PERFORM artifact_transition(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),
    'confirm',d.project_id,r.id,gen_random_uuid(),jsonb_build_object('stepId',k,'expectedVersion',st->'version','expectedReviewVersion',st->'reviewVersion'));
  END LOOP;
 END LOOP;
 RETURN jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id);
END $$;
REVOKE ALL ON FUNCTION opc_account_strategy_begin(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION opc_account_strategy_begin(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION artifact_evidence_allowed(project uuid,ids jsonb) RETURNS boolean LANGUAGE sql VOLATILE SET search_path=public,pg_temp AS $$
 SELECT artifact_evidence_allowed_before_opc(project,ids) AND NOT EXISTS(SELECT 1 FROM opc_result_links l WHERE ids ? l.evidence_id::text AND NOT runtime_history_available(l.execution_id))
 AND NOT EXISTS(SELECT 1 FROM opc_account_strategy_drafts binding JOIN opc_drafts d ON d.draft_id=binding.draft_id
  WHERE d.project_id=project AND NOT opc_source_allowed(d.actor_id,binding.root_source_version_id))
 AND NOT EXISTS(SELECT 1 FROM artifact_requests h JOIN artifact_projects p ON p.id=h.project_id
  WHERE h.project_id=project AND h.action='opc_account_inherit' AND
   (NOT opc_source_allowed(p.actor_id,(h.payload->>'sourceVersionId')::uuid)
    OR NOT artifact_evidence_allowed_before_opc(project,jsonb_build_array(h.response->>'evidenceId'))))
$$;
REVOKE ALL ON FUNCTION artifact_evidence_allowed(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION bill2_scope_allowed(a uuid,s jsonb) RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT (bill2_scope_allowed_before_topic(a,s) OR (
  s->>'kind'='positioning_topic' AND (s?'draftId') AND NOT(s?'projectId') AND NOT(s?'workItemId') AND NOT(s?'account')
  AND EXISTS(
   SELECT 1 FROM opc_drafts d WHERE d.draft_id=(s->>'draftId')::uuid AND d.actor_id=a
   AND (NOT EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.draft_id=d.draft_id)
    OR EXISTS(SELECT 1 FROM opc_topic_workspaces t WHERE t.draft_id=d.draft_id AND t.actor_id=a AND opc_source_allowed(a,t.source_version_id))))) ) AND NOT EXISTS(SELECT 1 FROM opc_drafts d JOIN opc_account_strategy_drafts binding ON binding.draft_id=d.draft_id
  WHERE s->>'kind'='positioning_draft' AND d.draft_id::text=s->>'draftId' AND d.actor_id=a
   AND (NOT opc_source_allowed(a,binding.base_source_version_id) OR NOT artifact_evidence_allowed(d.project_id,'[]')))
$$;
REVOKE ALL ON FUNCTION bill2_scope_allowed(uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION opc_account_strategy_schema(p_actor_id uuid,p_account_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a opc_accounts;d opc_drafts;r artifact_rounds;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO a FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=p_actor_id;
 IF a.project_id IS NULL OR NOT opc_source_allowed(p_actor_id,a.source_version_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT draft.* INTO d FROM opc_account_strategy_drafts b JOIN opc_drafts draft ON draft.draft_id=b.draft_id JOIN artifact_rounds round ON round.id=draft.round_id
  WHERE b.account_project_id=a.project_id AND b.current AND round.state='draft';
 IF d.draft_id IS NOT NULL THEN SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 ELSE
  SELECT round.* INTO r FROM artifact_versions v JOIN artifact_rounds round ON round.id=v.round_id WHERE v.id=a.source_version_id;
  SELECT * INTO d FROM opc_drafts WHERE project_id=r.project_id AND actor_id=p_actor_id;
 END IF;
 IF d.draft_id IS NULL OR NOT artifact_evidence_allowed(d.project_id,'[]') THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
 RETURN jsonb_build_object('registrationId',d.registration,'workflow',r.workflow,'information',
  (SELECT jsonb_object_agg(step->>'id',jsonb_build_object('schema',step->'information','values',r.steps->(step->>'id')->'information')) FROM jsonb_array_elements(r.workflow->'steps') step));
END $$;
REVOKE ALL ON FUNCTION opc_account_strategy_schema(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION opc_account_strategy_schema(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION opc_query(p_actor_id uuid,p_draft_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;information jsonb;binding opc_account_strategy_drafts;source_r artifact_rounds;source_information jsonb;
BEGIN
 result:=opc_query_before_entry_projection(p_actor_id,p_draft_id);
 IF p_draft_id IS NOT NULL THEN
  -- The predecessor already verifies actor ownership and source access. Only
  -- successful immutable writes of this same project/round/step can prove a
  -- field was confirmed; a revision may also inherit confirmed fields from its
  -- exact published predecessor. Reach alone includes deferred questions.
  SELECT jsonb_object_agg(info.key,info.value || jsonb_build_object('previouslyConfirmed',coalesce((
   SELECT jsonb_agg(field->>'id' ORDER BY ord)
   FROM jsonb_array_elements(info.value->'schema') WITH ORDINALITY fields(field,ord)
   WHERE EXISTS(SELECT 1 FROM artifact_requests a
    WHERE a.project_id=(result->>'projectId')::uuid AND a.round_id=(result->>'roundId')::uuid
     AND a.action='opc_information' AND a.payload->>'stepId'=info.key
     AND a.payload->'values'->(field->>'id')->>'status'='confirmed')
    OR EXISTS(SELECT 1 FROM artifact_requests revision
     JOIN artifact_rounds prior ON prior.id=(revision.payload->>'fromRoundId')::uuid
      AND prior.project_id=revision.project_id AND prior.state='published'
     WHERE revision.project_id=(result->>'projectId')::uuid AND revision.round_id=(result->>'roundId')::uuid
      AND revision.request_id=revision.round_id AND revision.action='opc_revision'
      AND prior.steps->info.key->'information'->(field->>'id')->>'status'='confirmed')
  ),'[]'::jsonb))) INTO information FROM jsonb_each(result->'information') info;
  SELECT * INTO binding FROM opc_account_strategy_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
  IF binding.draft_id IS NOT NULL THEN
   SELECT r.* INTO source_r FROM artifact_versions v JOIN artifact_rounds r ON r.id=v.round_id WHERE v.id=binding.base_source_version_id;
   SELECT jsonb_object_agg(step->>'id',jsonb_build_object('title',step->>'title','schema',step->'information','values',source_r.steps->(step->>'id')->'information'))
    INTO source_information FROM jsonb_array_elements(source_r.workflow->'steps') step;
   result:=result||jsonb_build_object('accountRevision',jsonb_build_object('accountProjectId',binding.account_project_id,
    'sourceVersionId',binding.base_source_version_id,'officialVersion',jsonb_array_length(opc_account_strategy_history(p_actor_id,binding.account_project_id)),
    'methodConflict',source_r.workflow IS DISTINCT FROM (SELECT workflow FROM artifact_rounds WHERE id=(result->>'roundId')::uuid) OR source_r.revision_id IS DISTINCT FROM (SELECT revision_id FROM artifact_rounds WHERE id=(result->>'roundId')::uuid),
    'sourceInformation',source_information));
   IF NOT (result->'accountRevision'->>'methodConflict')::boolean THEN
    SELECT jsonb_object_agg(info.key,info.value||jsonb_build_object(
     'reached',(SELECT jsonb_agg(field->>'id') FROM jsonb_array_elements(info.value->'schema') field),
     'previouslyConfirmed',(SELECT coalesce(jsonb_agg(field->>'id'),'[]') FROM jsonb_array_elements(info.value->'schema') field
      WHERE info.value->'previouslyConfirmed' ? (field->>'id') OR source_r.steps->info.key->'information'->(field->>'id')->>'status'='confirmed')))
     INTO information FROM jsonb_each(information) info;
   END IF;
  END IF;
  RETURN jsonb_set(result,'{information}',coalesce(information,'{}'::jsonb));
 END IF;
 result:=jsonb_set(result,'{drafts}',coalesce((SELECT jsonb_agg(entry || jsonb_build_object(
   'businessId',b.id,'businessName',b.name,'createdAt',p.created_at,'currentVersion',p.current_version,'state',r.state) ORDER BY p.created_at DESC,p.id)
  FROM jsonb_array_elements(result->'drafts') entry
  JOIN opc_drafts d ON d.draft_id=(entry->>'draftId')::uuid AND d.actor_id=p_actor_id
  JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
  JOIN opc_businesses b ON b.id=db.business_id AND b.actor_id=p_actor_id
  JOIN artifact_projects p ON p.id=d.project_id AND p.actor_id=p_actor_id
  JOIN artifact_rounds r ON r.id=d.round_id),'[]'::jsonb));
 result:=jsonb_set(result,'{accounts}',coalesce((SELECT jsonb_agg(jsonb_set(account,'{items}',coalesce((
  SELECT jsonb_agg(item || jsonb_build_object('moduleId',p.module_id,'methodRevisionId',r.revision_id))
  FROM jsonb_array_elements(account->'items') item
  JOIN artifact_projects p ON p.id=(item->>'workItemId')::uuid AND p.actor_id=p_actor_id
  JOIN opc_items i ON i.work_item_id=p.id
  JOIN artifact_versions v ON v.id=i.source_version_id
  JOIN artifact_rounds r ON r.id=v.round_id
 ),'[]'::jsonb))) FROM jsonb_array_elements(result->'accounts') account),'[]'::jsonb));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_query(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION opc_query(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION opc_account_strategy_history(p_actor_id uuid,p_account_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a opc_accounts;binding opc_account_strategy_drafts;root artifact_versions;result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO a FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=p_actor_id;
 IF a.project_id IS NULL OR NOT opc_source_allowed(p_actor_id,a.source_version_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO binding FROM opc_account_strategy_drafts WHERE account_project_id=a.project_id AND current;
 SELECT * INTO root FROM artifact_versions WHERE id=coalesce(binding.root_source_version_id,a.source_version_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',history.id,'version',history.ordinal,'sourceVersion',history.version,
  'source',history.source,'profile',opc_profile(history.id),'createdAt',history.created_at,
  'information',(SELECT jsonb_object_agg(step->>'id',jsonb_build_object('title',step->>'title','schema',step->'information','values',r.steps->(step->>'id')->'information'))
   FROM artifact_versions v JOIN artifact_rounds r ON r.id=v.round_id CROSS JOIN LATERAL jsonb_array_elements(r.workflow->'steps') step WHERE v.id=history.id))
  ORDER BY history.ordinal DESC),'[]'::jsonb) INTO result FROM (
  SELECT v.id,v.version,v.created_at,CASE WHEN v.project_id=root.project_id THEN 'shared' ELSE 'account' END source,
   row_number() OVER (ORDER BY v.created_at,v.id)::integer ordinal
  FROM artifact_versions v WHERE opc_source_allowed(p_actor_id,v.id) AND
   (v.project_id=root.project_id AND v.version<=root.version OR
    v.project_id IN (SELECT d.project_id FROM opc_account_strategy_drafts h JOIN opc_drafts d ON d.draft_id=h.draft_id
      WHERE h.account_project_id=a.project_id AND h.actor_id=p_actor_id))
 ) history;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_account_strategy_history(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION opc_account_strategy_history(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION artifact_query(p_actor_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 IF EXISTS(SELECT 1 FROM opc_account_strategy_drafts b JOIN opc_drafts d ON d.draft_id=b.draft_id WHERE d.project_id=p_project_id)
  AND NOT artifact_evidence_allowed(p_project_id,'[]') THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED' USING ERRCODE='42501';END IF;
 IF p_action='resolve' AND EXISTS(SELECT 1 FROM artifact_projects WHERE id=p_project_id AND work_kind='result') THEN RAISE EXCEPTION 'artifact result is immutable' USING ERRCODE='42501';END IF;
 result:=artifact_query_before_opc(p_actor_id,p_action,p_project_id,p_round_id);
 IF p_action='read' AND EXISTS(SELECT 1 FROM artifact_projects WHERE id=p_project_id AND work_kind='result') THEN result:=jsonb_set(result,'{workflow,steps}','[]');END IF;
 IF p_action='projects' THEN
  SELECT coalesce(jsonb_agg(x),'[]') INTO result FROM jsonb_array_elements(result) x
  WHERE NOT EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=(x->>'projectId')::uuid AND (p.work_kind IN ('positioning','account','result') OR EXISTS(SELECT 1 FROM opc_items i WHERE i.work_item_id=p.id)));
 END IF;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION artifact_query_before_opc(uuid,text,uuid,uuid),artifact_query(uuid,text,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION artifact_query(uuid,text,uuid,uuid) TO service_role;

COMMIT;
