-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- B1: existing JSONB state and immutable request history remain authoritative.
-- Capture receipts reserve UUID version F, which client UUID validation rejects.
-- Manual information/resolve SQL also rejects that namespace before any write.
BEGIN;
DO $$
DECLARE sig text; before_md5 text; after_md5 text;
BEGIN
 FOR sig,before_md5,after_md5 IN SELECT * FROM (VALUES
  ('opc_information(uuid,uuid,text,uuid,integer,jsonb)','2b2414a7b77824c94460886e8de28102','facb1a24394a78ce3ccef78871bae75e'),
  ('opc_query(uuid,uuid)','a897e051632d08666e9e42327c501e81','8f7d9b04d0f95ea595dbc49bdf82e4a9'),
  ('runtime_work_projection(uuid,uuid,uuid)','5a5bfa688cb801fec9b1dbdaa0ce9627','fcb191fa3d9135c42509cd1395a6e025'),
  ('runtime_material_allowed_before_b1(uuid,jsonb)','d9733d393816cf74ae0ae04088b87d80','0a1bac81b4214c2151f8ac32660b8d76')
 ) v(signature,before_hash,after_hash) LOOP
  IF to_regprocedure(sig) IS NULL OR md5(pg_get_functiondef(to_regprocedure(sig))) NOT IN (before_md5,after_md5)
  THEN RAISE EXCEPTION 'OPC_CAPTURE_SOURCE_MISMATCH: %',sig;END IF;
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION opc_capture_apply(p_actor_id uuid,p_draft_id uuid,p_execution_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;p artifact_projects;e runtime_executions;t opc_turns;req artifact_requests;
 ids uuid[];available_ids uuid[];execution_id uuid;processed jsonb:='[]';response jsonb;payload jsonb;capture_request_id uuid;
 output jsonb;code text;patch jsonb;step_id text;field_id text;st jsonb;meta jsonb;value jsonb;candidate jsonb;
 changed jsonb:='{}';fields jsonb:='{}';discarded jsonb:='[]';versions jsonb:='{}';old_steps jsonb;
 protected boolean;material_changed boolean;seq jsonb;suggestion jsonb;remaining integer;patch_index integer:=0;
BEGIN
 -- Match existing OPC lock order; never acquire a runtime session/run update lock.
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND (draft_id=p_draft_id OR
  (p_draft_id IS NULL AND session_id=(SELECT session_id FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id)));
 IF d.draft_id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)),false)
 THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 -- Refresh the draft after waiting: a concurrent revision may have advanced it.
 SELECT * INTO d FROM opc_drafts WHERE draft_id=d.draft_id AND actor_id=p_actor_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 IF p_execution_id IS NULL THEN
  SELECT coalesce(array_agg(ex.id ORDER BY ex.created_at,ex.id),'{}') INTO ids
  FROM opc_turns turn JOIN runtime_executions ex ON ex.session_id=turn.session_id AND ex.request_id=turn.request_id
  WHERE turn.session_id=d.session_id AND turn.draft_id=d.draft_id AND turn.round_id=r.id AND turn.purpose='mentor'
   AND ex.actor_id=p_actor_id AND ex.state='completed'
   AND CASE WHEN (ex.payload#>>'{attachedOrganizer,input}') IS JSON OBJECT
    THEN (ex.payload#>>'{attachedOrganizer,input}')::jsonb->>'captureFormat'='v2' ELSE false END
   AND NOT EXISTS(SELECT 1 FROM artifact_requests a WHERE a.project_id=d.project_id
    AND a.request_id=overlay(md5('opc_capture:'||ex.id::text) placing 'f' from 13 for 1)::uuid AND a.action='opc_capture'
    AND a.payload=jsonb_build_object('executionId',ex.id,'ruleVersion',1));
  SELECT coalesce(array_agg(x.id ORDER BY x.ord),'{}') INTO available_ids
  FROM unnest(ids) WITH ORDINALITY x(id,ord)
  JOIN runtime_history_availability(ids) a ON a.execution_id=x.id AND a.available;
  -- Recursive calls share this transaction: any storage error rolls back ALL five.
  FOREACH execution_id IN ARRAY available_ids[1:5] LOOP
   response:=opc_capture_apply(p_actor_id,p_draft_id,execution_id);
   processed:=processed||jsonb_build_array(jsonb_build_object('executionId',execution_id,'result',response->>'result'));
  END LOOP;
  SELECT count(*)::integer INTO remaining FROM unnest(available_ids) x(id)
  WHERE NOT EXISTS(SELECT 1 FROM artifact_requests a WHERE a.project_id=d.project_id
   AND a.request_id=overlay(md5('opc_capture:'||x.id::text) placing 'f' from 13 for 1)::uuid);
  RETURN jsonb_build_object('processed',processed,'remaining',remaining,'hasMore',remaining>0);
 END IF;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=d.session_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 capture_request_id:=overlay(md5('opc_capture:'||e.id::text) placing 'f' from 13 for 1)::uuid;
 payload:=jsonb_build_object('executionId',e.id,'ruleVersion',1);
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND artifact_requests.request_id=capture_request_id;
 IF FOUND THEN
  IF req.action IS DISTINCT FROM 'opc_capture' OR req.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  IF NOT runtime_history_available(e.id) THEN RETURN jsonb_build_object('result','unavailable');END IF;
  RETURN req.response;
 END IF;
 IF e.state<>'completed' THEN RETURN jsonb_build_object('result','not_ready');END IF;
 code:=NULL;
 IF NOT coalesce((CASE WHEN (e.payload#>>'{attachedOrganizer,input}') IS JSON OBJECT
  THEN (e.payload#>>'{attachedOrganizer,input}')::jsonb->>'captureFormat'='v2' ELSE false END),false)
 THEN code:='skipped_format';END IF;
 SELECT * INTO t FROM opc_turns WHERE session_id=d.session_id AND request_id=e.request_id;
 IF code IS NULL AND (t.token IS NULL OR t.token::text IS DISTINCT FROM e.payload->>'opcTurnToken'
  OR t.draft_id<>d.draft_id OR t.purpose<>'mentor'
  OR e.payload->>'revisionId' IS DISTINCT FROM (SELECT revision_id::text FROM artifact_rounds WHERE id=t.round_id)
  OR e.payload->>'moduleId' IS DISTINCT FROM p.module_id::text) THEN code:='denied_binding';END IF;
 IF code IS NULL AND (t.round_id<>r.id OR e.payload#>>'{scopeMaterial,content,work,roundId}' IS DISTINCT FROM r.id::text
  OR r.state<>'draft') THEN code:='stale_round';END IF;
 IF code IS NULL AND NOT runtime_history_available(e.id) THEN RETURN jsonb_build_object('result','unavailable');END IF;
 IF code IS NULL THEN
  -- Only malformed JSON is caught. Storage, permission, lock and transaction errors escape.
  BEGIN output:=(e.result->>'summary')::jsonb;
  EXCEPTION WHEN invalid_text_representation THEN output:=NULL;END;
  IF jsonb_typeof(output) IS DISTINCT FROM 'object'
   OR coalesce(output->>'inputKind','') NOT IN ('answer','acknowledgement','uncertainty','request','revision_request')
   OR jsonb_typeof(output->'patches') IS DISTINCT FROM 'array'
   OR jsonb_typeof(output->'notes') IS DISTINCT FROM 'array'
   THEN code:='invalid_output';
  ELSIF jsonb_array_length(output->'patches')>12 THEN code:='invalid_output';END IF;
 END IF;
 IF code IS NULL THEN
  old_steps:=r.steps;
  material_changed:=EXISTS(SELECT 1 FROM jsonb_each(r.steps) s
   WHERE s.value->'version' IS DISTINCT FROM e.payload#>ARRAY['scopeMaterial','content','work','steps',s.key,'version']);
  FOR patch IN SELECT * FROM jsonb_array_elements(output->'patches') LOOP
   patch_index:=patch_index+1;
   step_id:=patch->>'stepId';field_id:=patch->>'fieldId';st:=r.steps->step_id;
   IF jsonb_typeof(patch) IS DISTINCT FROM 'object' OR jsonb_typeof(patch->'value') IS DISTINCT FROM 'string'
    OR char_length(btrim(coalesce(patch->>'value','')))=0 OR char_length(patch->>'value')>400
    OR coalesce(patch->>'status','') NOT IN ('provisional','unclear')
    OR coalesce(patch->>'nature','') NOT IN ('fact','decision','hypothesis','unknown')
    OR coalesce(patch->>'basis','') NOT IN ('user_statement','agent_proposal')
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.workflow->'steps') s,jsonb_array_elements(s->'information') f
      WHERE s->>'id'=step_id AND f->>'id'=field_id)
   THEN discarded:=discarded||jsonb_build_array(jsonb_build_object('index',patch_index,'reason','invalid_patch'));CONTINUE;END IF;
   value:=patch-ARRAY['stepId','fieldId','basis'];
   value:=jsonb_build_object('value',value->'value','status',value->'status','nature',value->'nature');
   meta:=coalesce(st->'fieldMeta'->field_id,'{}');
   protected:=NOT coalesce(NOT coalesce((st->>'valid')::boolean,false)
 AND coalesce(st->'information'->(field_id)->>'status','unknown') NOT IN ('confirmed','deferred') AND (
  (st->'fieldMeta'->(field_id)->>'source'='capture' AND st->'fieldMeta'->(field_id)->>'fp'=artifact_hash(st->'information'->(field_id))
   AND EXISTS(SELECT 1 FROM artifact_requests cap WHERE cap.project_id=d.project_id AND cap.round_id=r.id
    AND cap.request_id=overlay(md5('opc_capture:'||(st->'fieldMeta'->(field_id)->>'executionId')) placing 'f' from 13 for 1)::uuid
    AND cap.action='opc_capture' AND cap.payload->>'executionId'=st->'fieldMeta'->(field_id)->>'executionId'
    AND cap.response->'versions' ? (step_id)
    AND NOT EXISTS(SELECT 1 FROM artifact_requests manual WHERE manual.project_id=d.project_id AND manual.round_id=r.id
     AND manual.action='opc_information' AND manual.payload->>'stepId'=(step_id)
     AND (manual.payload->>'expectedVersion')::integer >= (cap.response->'versions'->>(step_id))::integer
     AND artifact_hash(manual.payload->'values'->(field_id)) IS DISTINCT FROM st->'fieldMeta'->(field_id)->>'fp')))
  OR (st->'fieldMeta'->(field_id)->>'source' IS NULL AND coalesce(st->'information'->(field_id)->>'value','')='' AND coalesce(st->'information'->(field_id)->>'status','unknown')='unknown'
   AND NOT EXISTS(SELECT 1 FROM artifact_requests history WHERE history.project_id=d.project_id AND history.round_id=r.id
    AND ((history.action='opc_information' AND history.payload->>'stepId'=(step_id)
      AND coalesce(history.payload->'values'->(field_id)->>'value','')<>'')
     OR (history.action='opc_capture' AND history.response->'fields'->(step_id) ? (field_id)))))
 ),false);
   candidate:=coalesce(st->'information','{}')||jsonb_build_object(field_id,value);
   IF NOT material_changed AND NOT protected AND octet_length(candidate::text)<=12000 THEN
    IF st->'information'->field_id IS DISTINCT FROM value THEN
     st:=st||jsonb_build_object('information',candidate,'informationUpdatedAt',clock_timestamp());
     changed:=changed||jsonb_build_object(step_id,true);
     fields:=jsonb_set(fields,ARRAY[step_id],coalesce(fields->step_id,'[]')||to_jsonb(field_id));
     meta:=jsonb_build_object('source','capture','executionId',e.id,'fp',artifact_hash(value));
    END IF;
   ELSE
    seq:=jsonb_build_array(e.created_at,e.id);
    suggestion:=jsonb_build_object('executionId',e.id,'seq',seq,'value',value->'value',
     'status',value->'status','nature',value->'nature','basis',patch->'basis');
    suggestion:=suggestion||jsonb_build_object('hash',artifact_hash(suggestion));
    IF meta->'suggestion' IS NULL OR ((meta#>>'{suggestion,seq,0}')::timestamptz,(meta#>>'{suggestion,seq,1}')::uuid) < (e.created_at,e.id)
    THEN meta:=meta||jsonb_build_object('suggestion',suggestion);END IF;
   END IF;
   st:=st||jsonb_build_object('fieldMeta',coalesce(st->'fieldMeta','{}')||jsonb_build_object(field_id,meta));
   r.steps:=jsonb_set(r.steps,ARRAY[step_id],st);
  END LOOP;
  FOR step_id IN SELECT jsonb_object_keys(changed) LOOP
   r.steps:=jsonb_set(r.steps,ARRAY[step_id,'version'],to_jsonb((old_steps->step_id->>'version')::integer+1));
   r.steps:=artifact_invalidate(r.workflow,r.steps,step_id);
   versions:=versions||jsonb_build_object(step_id,r.steps->step_id->'version');
  END LOOP;
  UPDATE artifact_rounds SET steps=r.steps WHERE id=r.id;
  code:=CASE WHEN changed='{}' THEN 'suggested' ELSE 'applied' END;
 END IF;
 response:=jsonb_build_object('executionId',e.id,'result',code,'ruleVersion',1,'versions',versions,'fields',fields,'discarded',discarded);
 INSERT INTO artifact_requests VALUES(d.project_id,capture_request_id,r.id,'opc_capture',payload,response);
 RETURN response;
END $$;
CREATE OR REPLACE FUNCTION opc_information(p_actor_id uuid,p_draft_id uuid,p_step_id text,p_request_id uuid,p_expected_version integer,p_values jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;step jsonb;field jsonb;value jsonb;st jsonb;req artifact_requests;payload jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF substr(p_request_id::text,15,1)='f' THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND draft_id=p_draft_id;
 IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 PERFORM read_skill_package(p_actor_id,(SELECT module_id FROM artifact_projects WHERE id=d.project_id),(SELECT skill_id FROM artifact_projects WHERE id=d.project_id),r.revision_id,r.package_hash,NULL);
 payload:=jsonb_build_object('stepId',p_step_id,'expectedVersion',p_expected_version,'values',p_values);
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND request_id=p_request_id;
 IF FOUND THEN IF req.action<>'opc_information' OR req.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN req.response;END IF;
 SELECT x INTO step FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=p_step_id;
 st:=r.steps->p_step_id;
 IF r.state<>'draft' OR step IS NULL OR p_request_id IS NULL OR (st->>'version')::int IS DISTINCT FROM p_expected_version OR jsonb_typeof(p_values) IS DISTINCT FROM 'object' OR octet_length(p_values::text)>12000 THEN RAISE EXCEPTION 'OPC_INFORMATION_CONFLICT';END IF;
 FOR field IN SELECT * FROM jsonb_array_elements(step->'information') LOOP
  value:=p_values->(field->>'id');
  IF value IS NULL OR value-ARRAY['status','value','nature']<>'{}' OR coalesce(value->>'status','') NOT IN ('unknown','unclear','provisional','confirmed','deferred') OR coalesce(value->>'nature','') NOT IN ('fact','decision','hypothesis','unknown') OR char_length(coalesce(value->>'value',''))>400 OR (value->>'status' IN ('confirmed','deferred') AND char_length(btrim(coalesce(value->>'value','')))=0) THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
 END LOOP;
 IF (SELECT count(*) FROM jsonb_object_keys(p_values))<>jsonb_array_length(step->'information') THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
 FOR field IN SELECT * FROM jsonb_array_elements(step->'information') LOOP
  value:=p_values->(field->>'id');
  IF st->'information'->(field->>'id') IS DISTINCT FROM value THEN
   st:=st||jsonb_build_object('fieldMeta',coalesce(st->'fieldMeta','{}')||jsonb_build_object(field->>'id',
    coalesce(st->'fieldMeta'->(field->>'id'),'{}')||jsonb_build_object('source','user','fp',artifact_hash(value))));
  END IF;
 END LOOP;
 st:=st||jsonb_build_object('information',p_values,'informationUpdatedAt',clock_timestamp(),'version',p_expected_version+1);
 UPDATE artifact_rounds SET steps=artifact_invalidate(r.workflow,jsonb_set(r.steps,ARRAY[p_step_id],st),p_step_id) WHERE id=r.id;
 INSERT INTO artifact_requests VALUES(d.project_id,p_request_id,r.id,'opc_information',payload,jsonb_build_object('version',p_expected_version+1));RETURN jsonb_build_object('version',p_expected_version+1);
END $$;
CREATE OR REPLACE FUNCTION opc_query(p_actor_id uuid,p_draft_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE projection_result jsonb;information jsonb;binding opc_account_strategy_drafts;source_r artifact_rounds;source_information jsonb;capture_round artifact_rounds;st jsonb;step_id text;field_id text;meta jsonb;metas jsonb;ids uuid[];available_ids uuid[];
BEGIN
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
     WHERE m.value#>>'{suggestion,executionId}'=e.id::text);
  SELECT coalesce(array_agg(execution_id),'{}') INTO available_ids FROM runtime_history_availability(ids) WHERE available;
  FOR step_id,st IN SELECT key,value FROM jsonb_each(capture_round.steps) LOOP
   metas:='{}';
   FOR field_id IN SELECT f->>'id' FROM jsonb_array_elements(information->step_id->'schema') f LOOP
    meta:=coalesce(st->'fieldMeta'->field_id,'{}')-'fp';
    IF meta ? 'suggestion' AND NOT coalesce((meta#>>'{suggestion,executionId}')=ANY(available_ids::text[]),false)
    THEN meta:=meta-'suggestion';END IF;
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
  RETURN jsonb_set(projection_result,'{information}',coalesce(information,'{}'::jsonb));
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
END $$;
CREATE OR REPLACE FUNCTION runtime_work_projection(p_actor_id uuid,p_session_id uuid,p_round_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;context jsonb;st jsonb;step_id text;field_id text;metas jsonb;
BEGIN
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND session_id=p_session_id AND project_id=(SELECT project_id FROM artifact_rounds WHERE id=p_round_id);
 IF NOT FOUND THEN RETURN runtime_work_projection_before_opc(p_actor_id,p_session_id,p_round_id);END IF;
 IF NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',d.draft_id)) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id;
 FOR step_id,st IN SELECT key,value FROM jsonb_each(r.steps) LOOP
  metas:='{}';
  FOR field_id IN SELECT f->>'id' FROM jsonb_array_elements(r.workflow->'steps') s,
   jsonb_array_elements(s->'information') f WHERE s->>'id'=step_id LOOP
   metas:=metas||jsonb_build_object(field_id,jsonb_build_object('protected',NOT coalesce(NOT coalesce((st->>'valid')::boolean,false)
 AND coalesce(st->'information'->(field_id)->>'status','unknown') NOT IN ('confirmed','deferred') AND (
  (st->'fieldMeta'->(field_id)->>'source'='capture' AND st->'fieldMeta'->(field_id)->>'fp'=artifact_hash(st->'information'->(field_id))
   AND EXISTS(SELECT 1 FROM artifact_requests cap WHERE cap.project_id=d.project_id AND cap.round_id=r.id
    AND cap.request_id=overlay(md5('opc_capture:'||(st->'fieldMeta'->(field_id)->>'executionId')) placing 'f' from 13 for 1)::uuid
    AND cap.action='opc_capture' AND cap.payload->>'executionId'=st->'fieldMeta'->(field_id)->>'executionId'
    AND cap.response->'versions' ? (step_id)
    AND NOT EXISTS(SELECT 1 FROM artifact_requests manual WHERE manual.project_id=d.project_id AND manual.round_id=r.id
     AND manual.action='opc_information' AND manual.payload->>'stepId'=(step_id)
     AND (manual.payload->>'expectedVersion')::integer >= (cap.response->'versions'->>(step_id))::integer
     AND artifact_hash(manual.payload->'values'->(field_id)) IS DISTINCT FROM st->'fieldMeta'->(field_id)->>'fp')))
  OR (st->'fieldMeta'->(field_id)->>'source' IS NULL AND coalesce(st->'information'->(field_id)->>'value','')='' AND coalesce(st->'information'->(field_id)->>'status','unknown')='unknown'
   AND NOT EXISTS(SELECT 1 FROM artifact_requests history WHERE history.project_id=d.project_id AND history.round_id=r.id
    AND ((history.action='opc_information' AND history.payload->>'stepId'=(step_id)
      AND coalesce(history.payload->'values'->(field_id)->>'value','')<>'')
     OR (history.action='opc_capture' AND history.response->'fields'->(step_id) ? (field_id)))))
 ),false)));
  END LOOP;
  r.steps:=jsonb_set(r.steps,ARRAY[step_id],st||jsonb_build_object('fieldMeta',metas));
 END LOOP;
 context:=opc_business_context(p_actor_id,p_session_id,p_round_id);
 RETURN jsonb_build_object('projectId',d.project_id,'roundId',r.id,'revisionId',r.revision_id,'packageHash',r.package_hash,'steps',r.steps,'source',NULL)
  ||CASE WHEN context IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('businessContext',context) END;
END $$;
CREATE OR REPLACE FUNCTION opc_capture_resolve(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,
 p_step_id text,p_field_id text,p_execution_id uuid,p_hash text,p_action text,p_expected_version integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;req artifact_requests;payload jsonb;st jsonb;meta jsonb;suggestion jsonb;
 value jsonb;information jsonb;version integer;response jsonb;e runtime_executions;t opc_turns;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF substr(p_request_id::text,15,1)='f' THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)),false)
 THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 payload:=jsonb_build_object('stepId',p_step_id,'fieldId',p_field_id,'executionId',p_execution_id,
  'hash',p_hash,'action',p_action,'expectedVersion',p_expected_version);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=d.session_id AND actor_id=p_actor_id;
 SELECT * INTO t FROM opc_turns WHERE session_id=d.session_id AND request_id=e.request_id;
 IF e.id IS NULL OR t.token::text IS DISTINCT FROM e.payload->>'opcTurnToken' OR t.purpose IS DISTINCT FROM 'mentor'
  OR NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'OPC_CAPTURE_DENIED';END IF;
 SELECT * INTO req FROM artifact_requests WHERE project_id=d.project_id AND request_id=p_request_id;
 IF FOUND THEN
  IF req.action IS DISTINCT FROM 'opc_capture_resolve' OR req.payload IS DISTINCT FROM payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN req.response;
 END IF;
 st:=r.steps->p_step_id;meta:=st->'fieldMeta'->p_field_id;suggestion:=meta->'suggestion';
 IF suggestion->>'executionId' IS DISTINCT FROM p_execution_id::text OR suggestion->>'hash' IS DISTINCT FROM p_hash
  OR suggestion IS NULL OR r.state<>'draft' OR t.round_id<>r.id THEN RAISE EXCEPTION 'OPC_SUGGESTION_CHANGED';END IF;
 IF p_request_id IS NULL OR p_hash IS NULL OR p_action IS NULL OR p_action NOT IN ('accept','ignore')
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
  meta:=jsonb_build_object('source','user','fp',artifact_hash(value));
 ELSE meta:=meta-'suggestion';END IF;
 IF meta='{}' THEN st:=st #- ARRAY['fieldMeta',p_field_id];
 ELSE st:=jsonb_set(st,ARRAY['fieldMeta',p_field_id],meta);END IF;
 r.steps:=jsonb_set(r.steps,ARRAY[p_step_id],st);
 IF p_action='accept' AND version<>p_expected_version THEN r.steps:=artifact_invalidate(r.workflow,r.steps,p_step_id);END IF;
 UPDATE artifact_rounds SET steps=r.steps WHERE id=r.id;
 response:=jsonb_build_object('version',version,'result',p_action);
 INSERT INTO artifact_requests VALUES(d.project_id,p_request_id,r.id,'opc_capture_resolve',payload,response);
 RETURN response;
END $$;
CREATE OR REPLACE FUNCTION runtime_material_allowed_before_b1(p_actor_id uuid,p_material jsonb)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE m runtime_scope_material;current_work jsonb;frozen_work jsonb;st jsonb;context jsonb;binding uuid;source_id uuid;draft_record opc_drafts;round_record artifact_rounds;
BEGIN
 IF p_material IS NULL OR p_material='null'::jsonb THEN RETURN;END IF;
 SELECT v.* INTO m FROM runtime_scope_material v JOIN runtime_sessions s ON s.id=v.session_id
 WHERE s.actor_id=p_actor_id AND v.session_id=(p_material->>'sessionId')::uuid AND v.revision=(p_material->>'revision')::bigint FOR SHARE OF v;
 IF m.session_id IS NULL OR m.revoked OR m.content_hash IS DISTINCT FROM p_material->>'hash' OR m.content IS DISTINCT FROM p_material->'content'
 THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 -- History checks compare only material identity, never the mutable steps.
 -- Keep the pre-capture OPC identity/authorization path without computing field protection.
 SELECT * INTO draft_record FROM opc_drafts WHERE actor_id=p_actor_id AND session_id=m.session_id
  AND project_id=(SELECT project_id FROM artifact_rounds WHERE id=(m.content->>'roundId')::uuid);
 IF FOUND THEN
  IF NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',draft_record.draft_id))
  THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
  SELECT * INTO round_record FROM artifact_rounds WHERE id=(m.content->>'roundId')::uuid;
  current_work:=jsonb_build_object('projectId',draft_record.project_id,'roundId',round_record.id,'revisionId',round_record.revision_id,'packageHash',round_record.package_hash,'source',NULL);
  context:=opc_business_context(p_actor_id,m.session_id,round_record.id);
  IF context IS NOT NULL THEN current_work:=current_work||jsonb_build_object('businessContext',context);END IF;
 ELSE
  current_work:=coalesce(runtime_work_projection_before_opc(p_actor_id,m.session_id,(m.content->>'roundId')::uuid),'null'::jsonb);
 END IF;
 frozen_work:=m.content->'work';
 -- The current projection is server-authored. A business addition must not
 -- invalidate a pre-0139 frozen request that did not inherit that source.
 IF current_work ? 'businessContext' THEN
  IF current_work->'businessContext' IS DISTINCT FROM opc_business_context(p_actor_id,m.session_id,(m.content->>'roundId')::uuid)
  THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  current_work:=current_work-'businessContext';
 END IF;
 IF frozen_work ? 'businessContext' THEN
  context:=frozen_work->'businessContext';
  IF jsonb_typeof(context) IS DISTINCT FROM 'object' OR context->>'version' IS DISTINCT FROM 'opc-business-context.v1'
   OR context-ARRAY['version','businessId','name','source']<>'{}'::jsonb
   OR NOT (context ?& ARRAY['version','businessId','name','source'])
   OR (context->'name'<>'null'::jsonb AND (jsonb_typeof(context->'name') IS DISTINCT FROM 'string' OR char_length(context->>'name') NOT BETWEEN 1 AND 120))
  THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  SELECT business.id INTO binding FROM opc_drafts d
   JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
   JOIN opc_businesses business ON business.id=db.business_id AND business.actor_id=p_actor_id
   JOIN artifact_rounds r ON r.id=(m.content->>'roundId')::uuid AND r.project_id=d.project_id
   WHERE d.actor_id=p_actor_id AND d.session_id=m.session_id AND business.id::text=context->>'businessId';
  IF binding IS NULL THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  IF context->'source'<>'null'::jsonb THEN
   IF EXISTS(SELECT 1 FROM opc_drafts d JOIN opc_account_strategy_drafts a ON a.draft_id=d.draft_id AND a.actor_id=p_actor_id
    WHERE d.session_id=m.session_id AND d.actor_id=p_actor_id) THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
   IF jsonb_typeof(context->'source') IS DISTINCT FROM 'object'
    OR (context->'source')-ARRAY['versionId','profile']<>'{}'::jsonb
    OR NOT (context->'source' ?& ARRAY['versionId','profile'])
   THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
   -- A later publication or rename must not rewrite the frozen source. Its
   -- original version must still belong to this business and remain allowed.
   SELECT v.id INTO source_id FROM artifact_versions v
    JOIN opc_drafts source_d ON source_d.project_id=v.project_id AND source_d.actor_id=p_actor_id
    JOIN bill2_drafts source_draft ON source_draft.id=source_d.draft_id AND source_draft.actor_id=p_actor_id
    JOIN artifact_projects source_project ON source_project.id=v.project_id AND source_project.actor_id=p_actor_id
    JOIN opc_draft_businesses db ON db.draft_id=source_d.draft_id AND db.business_id=binding
    WHERE v.id::text=context->'source'->>'versionId'
     AND NOT EXISTS(SELECT 1 FROM opc_account_strategy_drafts a WHERE a.draft_id=source_d.draft_id) FOR SHARE OF source_draft,source_project;
   PERFORM module.id FROM artifact_versions v JOIN artifact_projects p ON p.id=v.project_id
    JOIN artifact_rounds r ON r.id=v.round_id JOIN modules module ON module.id=p.module_id
    JOIN skills skill ON skill.id=p.skill_id JOIN skill_revisions revision ON revision.id=r.revision_id AND revision.skill_id=skill.id
    WHERE v.id=source_id FOR SHARE OF module,skill,revision;
   IF source_id IS NULL OR NOT opc_source_allowed(p_actor_id,source_id)
    OR context->'source'->'profile' IS DISTINCT FROM opc_profile(source_id)
   THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  END IF;
  frozen_work:=frozen_work-'businessContext';
 END IF;
 -- Only steps may have ordinary mutable edits. Every other pre-existing
 -- package/source/round identity field retains the original exact comparison.
 IF (CASE WHEN jsonb_typeof(frozen_work)='object' THEN frozen_work-'steps' ELSE frozen_work END)
  IS DISTINCT FROM (CASE WHEN jsonb_typeof(current_work)='object' THEN current_work-'steps' ELSE current_work END)
 THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 FOR st IN SELECT value FROM jsonb_each(coalesce(m.content->'work'->'steps','{}')) LOOP
  IF NOT artifact_evidence_allowed((m.content->'work'->>'projectId')::uuid,coalesce(st->'evidenceIds','[]')||coalesce(st->'provenanceIds','[]'))
  THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 END LOOP;
END $$;
REVOKE ALL ON FUNCTION opc_capture_apply(uuid,uuid,uuid),
 opc_capture_resolve(uuid,uuid,uuid,text,text,uuid,text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION opc_capture_apply(uuid,uuid,uuid),
 opc_capture_resolve(uuid,uuid,uuid,text,text,uuid,text,text,integer) TO service_role;
COMMIT;
