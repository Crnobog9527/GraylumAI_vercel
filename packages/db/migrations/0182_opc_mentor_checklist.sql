-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Additive response/context changes; preserves signatures, grants and authorization.
BEGIN;
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
 IF FOUND THEN IF req.action<>'opc_information' OR req.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN req.response||jsonb_build_object('values',req.payload->'values');END IF;
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
 INSERT INTO artifact_requests VALUES(d.project_id,p_request_id,r.id,'opc_information',payload,jsonb_build_object('version',p_expected_version+1,'values',p_values));RETURN jsonb_build_object('version',p_expected_version+1,'values',p_values);
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
   metas:=metas||jsonb_build_object(field_id,jsonb_build_object('source',coalesce(st#>>ARRAY['fieldMeta',field_id,'source'],'unknown'),
    'basis',coalesce(st#>>ARRAY['fieldMeta',field_id,'basis'],'unknown'),
    'hasPendingSuggestion',EXISTS(SELECT 1 FROM runtime_executions e JOIN opc_turns t
      ON t.session_id=e.session_id AND t.request_id=e.request_id
      WHERE e.id::text=st#>>ARRAY['fieldMeta',field_id,'suggestion','executionId']
       AND t.round_id=r.id AND t.draft_id=d.draft_id AND t.purpose='mentor'
       AND t.token::text=e.payload->>'opcTurnToken' AND e.state='completed'
       AND e.payload->>'revisionId'=r.revision_id::text
       AND e.payload->>'moduleId'=(SELECT module_id::text FROM artifact_projects WHERE id=r.project_id)
       AND e.payload#>>'{scopeMaterial,content,work,roundId}'=r.id::text
       AND e.session_id=p_session_id AND e.actor_id=p_actor_id AND runtime_history_available(e.id)),'protected',NOT coalesce(NOT coalesce((st->>'valid')::boolean,false)
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
 IF code IS NULL AND ((e.payload#>>'{attachedOrganizer,input}')::jsonb#>>'{hostEvent,kind}')='checklist_updated'
 THEN code:='host_checklist_updated';END IF;
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
     meta:=jsonb_build_object('source','capture','basis',patch->'basis','executionId',e.id,'fp',artifact_hash(value));
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
CREATE OR REPLACE FUNCTION opc_historical_reach(p_actor_id uuid,p_draft_id uuid,p_step_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;r artifact_rounds;step jsonb;ids text[];snap jsonb;prefix int;best int:=-1;i int;status text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 SELECT x INTO step FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=p_step_id;
 IF step IS NULL THEN RAISE EXCEPTION 'OPC_STEP_DENIED';END IF;
 SELECT array_agg(f->>'id' ORDER BY ord) INTO ids
   FROM jsonb_array_elements(step->'information') WITH ORDINALITY t(f,ord);
 IF ids IS NULL THEN RETURN '[]'::jsonb;END IF;
 -- Only successful information writes of THIS round and step count; a rolled
 -- back transaction never became a stored request.
 FOR snap IN
  SELECT a.payload->'values' v
    FROM artifact_requests a
   WHERE a.project_id=d.project_id AND a.round_id=r.id AND a.action='opc_information'
     AND a.payload->>'stepId'=p_step_id
 LOOP
  prefix:=0;
  FOR i IN 1..coalesce(array_length(ids,1),0) LOOP
   status:=snap->ids[i]->>'status';
   EXIT WHEN status IS NULL OR status NOT IN ('confirmed','deferred');
   prefix:=i;
  END LOOP;
  -- The historical maximum of "leading resolved questions", so a later
  -- provisional edit cannot shrink what was already reached.
  IF prefix>best THEN best:=prefix;END IF;
  -- No later snapshot can expand beyond the full pinned field list.
  EXIT WHEN best>=coalesce(array_length(ids,1),0);
 END LOOP;
 IF best<0 THEN RETURN '[]'::jsonb;END IF;
 -- Reach = every leading resolved question plus at most its next declared one.
 RETURN to_jsonb(ids[1:least(best+1,coalesce(array_length(ids,1),0))]);
END $$;
COMMIT;
