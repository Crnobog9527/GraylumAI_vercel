/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- AGENT-CORE R14. Number allocated by the controller (#849).
-- A review revision is a full report text plus the field values it proposes. The host lists the
-- differences against the confirmed fields of the current formal version; on confirmation it opens a
-- revision round through the existing opc_revise, writes the fields through the existing information,
-- save and confirm transitions, and publishes with the revision as the report text. On decline the
-- fields and the formal version stay as they are. No new table: revisions and decisions are immutable
-- artifact_requests rows, so the existing deletion and account erasure cover them.
BEGIN;

-- Validate the proposed fields against the round's frozen workflow and list what would change.
-- cascade: steps that only depend on a changed step; they are confirmed together with it.
CREATE OR REPLACE FUNCTION public.report_revision_diff(r artifact_rounds,fields jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE step jsonb;f jsonb;k text;fid text;proposed jsonb;cur jsonb;
 changes jsonb:='[]';cascade jsonb:='[]';changed text[]:='{}';affected text[];grew boolean:=true;
BEGIN
 IF jsonb_typeof(fields) IS DISTINCT FROM 'object' OR octet_length(fields::text)>65536 THEN
  RAISE EXCEPTION 'REPORT_REVISION_INVALID'; END IF;
 FOR k,proposed IN SELECT * FROM jsonb_each(fields) LOOP
  SELECT x INTO step FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id'=k;
  IF step IS NULL OR jsonb_typeof(proposed) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'REPORT_REVISION_INVALID'; END IF;
  FOR fid IN SELECT jsonb_object_keys(proposed) LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(step->'information') i WHERE i->>'id'=fid)
    OR jsonb_typeof(proposed->fid) IS DISTINCT FROM 'string' OR artifact_text_length(proposed->>fid)=0
    OR char_length(proposed->>fid)>400 THEN RAISE EXCEPTION 'REPORT_REVISION_INVALID'; END IF;
  END LOOP;
 END LOOP;
 FOR step IN SELECT x FROM jsonb_array_elements(r.workflow->'steps') x LOOP
  k:=step->>'id';
  FOR f IN SELECT i FROM jsonb_array_elements(step->'information') i LOOP
   fid:=f->>'id';cur:=r.steps->k->'information'->fid;
   IF fields->k ? fid AND (cur->>'value' IS DISTINCT FROM fields->k->>fid OR cur->>'status' IS DISTINCT FROM 'confirmed') THEN
    changes:=changes||jsonb_build_array(jsonb_build_object('stepId',k,'stepTitle',step->>'title','fieldId',fid,
     'fieldTitle',f->>'title','before',jsonb_build_object('value',coalesce(cur->>'value',''),'status',coalesce(cur->>'status','unknown')),
     'after',jsonb_build_object('value',fields->k->>fid,'status','confirmed')));
    IF NOT k=ANY(changed) THEN changed:=changed||k; END IF;
   END IF;
  END LOOP;
 END LOOP;
 -- Same closure as artifact_invalidate: every step that transitively depends on a changed one.
 affected:=changed;
 WHILE grew LOOP
  grew:=false;
  FOR step IN SELECT x FROM jsonb_array_elements(r.workflow->'steps') x LOOP
   IF NOT step->>'id'=ANY(affected) AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'dependsOn') dep
    WHERE dep=ANY(affected)) THEN affected:=affected||(step->>'id');grew:=true; END IF;
  END LOOP;
 END LOOP;
 FOR step IN SELECT x FROM jsonb_array_elements(r.workflow->'steps') x LOOP
  k:=step->>'id';
  IF k=ANY(affected) AND NOT k=ANY(changed) THEN
   cascade:=cascade||jsonb_build_array(jsonb_build_object('stepId',k,'stepTitle',step->>'title','fields',
    (SELECT coalesce(jsonb_agg(jsonb_build_object('fieldId',i->>'id','fieldTitle',i->>'title',
      'before',jsonb_build_object('value',coalesce(r.steps->k->'information'->(i->>'id')->>'value',''),
       'status',coalesce(r.steps->k->'information'->(i->>'id')->>'status','unknown')),
      'after',jsonb_build_object('value',coalesce(r.steps->k->'information'->(i->>'id')->>'value',''),
       'status',coalesce(r.steps->k->'information'->(i->>'id')->>'status','unknown'))) ORDER BY ord),'[]')
     FROM jsonb_array_elements(step->'information') WITH ORDINALITY t(i,ord))));
  END IF;
 END LOOP;
 RETURN jsonb_build_object('changes',changes,'cascade',cascade);
END $$;
REVOKE ALL ON FUNCTION public.report_revision_diff(artifact_rounds,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- What the caller sees for one revision: the stored difference and, once decided, the decision.
CREATE OR REPLACE FUNCTION public.report_revision_state(pid uuid,rv artifact_requests) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE dec artifact_requests;v artifact_versions;draft uuid;
BEGIN
 SELECT * INTO dec FROM artifact_requests WHERE project_id=pid AND action IN ('report_revision_apply','report_revision_decline')
  AND payload->>'revisionId'=rv.request_id::text AND erased_at IS NULL;
 IF dec.action='report_revision_apply' THEN
  SELECT * INTO v FROM artifact_versions WHERE id=(dec.response->>'versionId')::uuid AND erased_at IS NULL;
 END IF;
 draft:=(rv.payload->>'draftId')::uuid;
 RETURN jsonb_build_object('revisionId',rv.request_id,'draftId',draft,'sourceVersionId',rv.payload->'sourceVersionId',
  'body',rv.payload->'body','bodyHash',rv.response->'bodyHash','diff',rv.response->'diff','diffHash',rv.response->'diffHash',
  'decision',CASE dec.action WHEN 'report_revision_apply' THEN 'applied' WHEN 'report_revision_decline' THEN 'declined' END,
  'fieldsSynced',CASE dec.action WHEN 'report_revision_apply' THEN true WHEN 'report_revision_decline' THEN false END,
  'versionId',v.id,'version',v.version,
  'next',CASE WHEN v.id IS NOT NULL THEN jsonb_build_object('kind','first_week_topics','draftId',draft,'sourceVersionId',v.id) END);
END $$;
REVOKE ALL ON FUNCTION public.report_revision_state(uuid,artifact_requests) FROM PUBLIC,anon,authenticated,service_role;

-- Publication accepts a revision as report text only inside report_revision's own transaction.
CREATE OR REPLACE FUNCTION public.report_revision_snapshot(a uuid,pid uuid,rid uuid,p_payload jsonb,p_snapshot jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE rv artifact_requests;
BEGIN
 SELECT * INTO rv FROM artifact_requests WHERE project_id=pid AND action='report_revision' AND erased_at IS NULL
  AND request_id::text=p_payload->>'reviewRevisionId';
 IF rv.request_id IS NULL OR coalesce(current_setting('graylum.report_revision',true),'')<>rv.request_id::text
  OR NOT EXISTS(SELECT 1 FROM artifact_projects WHERE id=pid AND actor_id=a)
  OR NOT EXISTS(SELECT 1 FROM artifact_requests o WHERE o.project_id=pid AND o.request_id=rid AND o.action='opc_revision'
   AND o.payload->>'fromRoundId'=rv.round_id::text) THEN RAISE EXCEPTION 'REPORT_EXECUTION_REQUIRED'; END IF;
 RETURN p_snapshot||jsonb_build_object('generatedReport',jsonb_build_object('source','review_revision','revisionId',rv.request_id,
  'sourceVersionId',rv.payload->'sourceVersionId','body',rv.payload->'body','bodyHash',rv.response->'bodyHash',
  'manuallyEdited',false,'fieldsSynced',true),
  'limitations','Report text is an adopted review revision; the user confirmed its field changes, which are in the confirmed field snapshot.');
END $$;
REVOKE ALL ON FUNCTION public.report_revision_snapshot(uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DO $$ DECLARE definition text;needle text;
BEGIN
 definition:=pg_get_functiondef('public.report_final_snapshot(uuid,uuid,uuid,jsonb,jsonb)'::regprocedure);
 IF position('-- R14 review revision' IN definition)=0 THEN
  needle:='IF NOT(r.workflow ? ''reportGeneration'') THEN RETURN snapshot; END IF;';
  IF position(needle IN definition)=0 THEN RAISE EXCEPTION 'REPORT_REVISION_TARGET_MISMATCH'; END IF;
  EXECUTE replace(definition,needle,needle||E'\n -- R14 review revision\n'
   ||' IF payload ? ''reviewRevisionId'' THEN RETURN report_revision_snapshot(a,pid,rid,payload,snapshot); END IF;');
 END IF;
END $$;

-- Apply one decided revision: new round, changed fields, every step confirmed, published.
CREATE OR REPLACE FUNCTION public.report_revision_apply_core(a uuid,d opc_drafts,p artifact_projects,r artifact_rounds,rv artifact_requests)
RETURNS jsonb LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE nr uuid:=gen_random_uuid();cur artifact_rounds;step jsonb;f jsonb;k text;st jsonb;vals jsonb;body text;
 fields jsonb:=rv.payload->'fields';pass integer;result jsonb;
BEGIN
 PERFORM opc_revise(a,d.draft_id,nr,r.id);
 FOR step IN SELECT x FROM jsonb_array_elements(r.workflow->'steps') x LOOP
  k:=step->>'id';
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(rv.response#>'{diff,changes}') c WHERE c->>'stepId'=k) THEN CONTINUE; END IF;
  SELECT * INTO cur FROM artifact_rounds WHERE id=nr;st:=cur.steps->k;
  SELECT jsonb_object_agg(i->>'id',CASE WHEN fields->k ? (i->>'id') THEN jsonb_build_object('status','confirmed',
    'nature',coalesce(st->'information'->(i->>'id')->>'nature','unknown'),'value',fields->k->>(i->>'id'))
   ELSE coalesce(st->'information'->(i->>'id'),jsonb_build_object('status','unknown','nature','unknown','value','')) END)
   INTO vals FROM jsonb_array_elements(step->'information') i;
  PERFORM opc_information(a,d.draft_id,k,gen_random_uuid(),(st->>'version')::integer,vals);
  -- The same canonical step text the page and account edits save (0135).
  SELECT string_agg((i->>'title')||E'\n'||CASE WHEN vals->(i->>'id')->>'status'='deferred' THEN '（暂缓确认）' ELSE '' END
    ||(vals->(i->>'id')->>'value'),E'\n\n' ORDER BY ord) INTO body
   FROM jsonb_array_elements(step->'information') WITH ORDINALITY t(i,ord) WHERE coalesce(vals->(i->>'id')->>'value','')<>'';
  SELECT * INTO cur FROM artifact_rounds WHERE id=nr;st:=cur.steps->k;
  PERFORM artifact_transition(a,p.module_id,p.skill_id,'save',p.id,nr,gen_random_uuid(),
   jsonb_build_object('stepId',k,'body',body,'evidenceIds',coalesce(st->'evidenceIds','[]'),'expectedVersion',st->'version'));
  -- Record where the changed values came from (the information write marks them as the user's).
  SELECT * INTO cur FROM artifact_rounds WHERE id=nr;st:=cur.steps->k;
  FOR f IN SELECT c FROM jsonb_array_elements(rv.response#>'{diff,changes}') c WHERE c->>'stepId'=k LOOP
   st:=jsonb_set(st,ARRAY['fieldMeta',f->>'fieldId'],coalesce(st->'fieldMeta'->(f->>'fieldId'),'{}')||'{"source":"revision"}');
  END LOOP;
  UPDATE artifact_rounds SET steps=jsonb_set(steps,ARRAY[k],st) WHERE id=nr;
 END LOOP;
 -- The user confirmed the whole revision, so the steps it invalidated are confirmed with it.
 FOR pass IN 1..greatest(jsonb_array_length(r.workflow->'steps'),1) LOOP
  FOR step IN SELECT x FROM jsonb_array_elements(r.workflow->'steps') x LOOP
   k:=step->>'id';SELECT * INTO cur FROM artifact_rounds WHERE id=nr;st:=cur.steps->k;
   IF coalesce((st->>'valid')::boolean,false) OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(step->'dependsOn') dep
    WHERE NOT coalesce((cur.steps->dep->>'valid')::boolean,false)) THEN CONTINUE; END IF;
   PERFORM artifact_transition(a,p.module_id,p.skill_id,'confirm',p.id,nr,gen_random_uuid(),
    jsonb_build_object('stepId',k,'expectedVersion',st->'version','expectedReviewVersion',st->'reviewVersion'));
  END LOOP;
 END LOOP;
 PERFORM set_config('graylum.report_revision',rv.request_id::text,true);
 result:=artifact_transition(a,p.module_id,p.skill_id,'publish',p.id,nr,gen_random_uuid(),
  jsonb_build_object('reviewRevisionId',rv.request_id));
 PERFORM set_config('graylum.report_revision','',true);
 IF result->>'versionId' IS NULL THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT'; END IF;
 RETURN jsonb_build_object('roundId',nr,'versionId',result->'versionId','version',result->'version');
EXCEPTION WHEN raise_exception THEN
 -- Lower-level confirmation and evidence failures mean the source changed under the revision.
 IF SQLERRM LIKE 'REPORT\_%' OR SQLERRM='CONTENT_ERASED' THEN RAISE; END IF;
 RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT';
END $$;
REVOKE ALL ON FUNCTION public.report_revision_apply_core(uuid,opc_drafts,artifact_projects,artifact_rounds,artifact_requests)
 FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.report_revision(p_actor_id uuid,p_draft_id uuid,p_action text,p_request_id uuid DEFAULT NULL,
 p_revision_id uuid DEFAULT NULL,p_source_version_id uuid DEFAULT NULL,p_body text DEFAULT NULL,p_fields jsonb DEFAULT NULL,
 p_expected_diff_hash text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;p artifact_projects;r artifact_rounds;v artifact_versions;rv artifact_requests;prior artifact_requests;
 request jsonb;diff jsonb;applied jsonb;
BEGIN
 IF p_action IS NULL OR p_action NOT IN ('propose','read','latest','apply','decline') THEN RAISE EXCEPTION 'REPORT_REVISION_INVALID'; END IF;
 PERFORM bill2_actor(p_actor_id);
 PERFORM id FROM profiles WHERE id=p_actor_id FOR SHARE;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'REPORT_REVISION_DENIED'; END IF;
 IF EXISTS(SELECT 1 FROM artifact_projects WHERE id=d.project_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
 IF NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN
  RAISE EXCEPTION 'REPORT_REVISION_DENIED'; END IF;
 -- Account strategy drafts keep their own edit flow and lock order (0135).
 IF EXISTS(SELECT 1 FROM opc_account_strategy_drafts WHERE draft_id=d.draft_id) THEN RAISE EXCEPTION 'REPORT_REVISION_UNSUPPORTED'; END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=d.project_id AND actor_id=p_actor_id FOR UPDATE;
 IF p.id IS NULL THEN RAISE EXCEPTION 'REPORT_REVISION_DENIED'; END IF;
 IF p.erased_at IS NOT NULL OR p.content_deleted_at IS NOT NULL THEN RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id AND project_id=p.id;

 IF p_action='latest' THEN
  SELECT * INTO rv FROM artifact_requests WHERE project_id=p.id AND action='report_revision' AND erased_at IS NULL
   AND payload->>'sourceVersionId'=p_source_version_id::text AND payload->>'draftId'=d.draft_id::text
   ORDER BY payload->>'proposedAt' DESC LIMIT 1;
  RETURN CASE WHEN rv.request_id IS NULL THEN NULL ELSE report_revision_state(p.id,rv) END;
 END IF;

 IF p_action='propose' THEN
  request:=jsonb_build_object('draftId',d.draft_id,'sourceVersionId',p_source_version_id,'body',p_body,'fields',p_fields);
  SELECT * INTO prior FROM artifact_requests WHERE project_id=p.id AND request_id=p_request_id;
  IF FOUND THEN
   IF prior.erased_at IS NOT NULL THEN RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
   IF prior.action<>'report_revision' OR prior.payload-'proposedAt'-'roundId' IS DISTINCT FROM request THEN
    RAISE EXCEPTION 'REPORT_REQUEST_CONFLICT'; END IF;
   RETURN report_revision_state(p.id,prior);
  END IF;
  IF p_request_id IS NULL THEN RAISE EXCEPTION 'REPORT_REVISION_INVALID'; END IF;
  SELECT * INTO v FROM artifact_versions WHERE round_id=r.id AND project_id=p.id AND erased_at IS NULL;
  -- Only the current formal version, finalized from a generated report, can be revised.
  IF r.state IS DISTINCT FROM 'published' OR v.id IS DISTINCT FROM p_source_version_id OR v.version IS DISTINCT FROM p.current_version
   OR NOT coalesce(v.report ? 'generatedReport',false) OR NOT content_erasure_artifact_readable(p_actor_id,v.id) THEN
   RAISE EXCEPTION 'REPORT_REVISION_STALE'; END IF;
  IF p_body IS NULL OR NOT report_body_complete(p_body,r.workflow->'reportGeneration') THEN RAISE EXCEPTION 'REPORT_NOT_COMPLETE'; END IF;
  diff:=report_revision_diff(r,p_fields);
  INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
   VALUES(p.id,p_request_id,r.id,'report_revision',request||jsonb_build_object('roundId',r.id,'proposedAt',clock_timestamp()),
    jsonb_build_object('diff',diff,'diffHash',artifact_hash(diff),'bodyHash',encode(sha256(convert_to(p_body,'utf8')),'hex')));
  SELECT * INTO rv FROM artifact_requests WHERE project_id=p.id AND request_id=p_request_id;
  RETURN report_revision_state(p.id,rv);
 END IF;

 SELECT * INTO rv FROM artifact_requests WHERE project_id=p.id AND request_id=p_revision_id AND action='report_revision';
 IF rv.request_id IS NULL OR rv.payload->>'draftId' IS DISTINCT FROM d.draft_id::text THEN RAISE EXCEPTION 'REPORT_REVISION_REQUIRED'; END IF;
 IF rv.erased_at IS NOT NULL THEN RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
 IF p_action='read' THEN RETURN report_revision_state(p.id,rv); END IF;

 IF p_request_id IS NULL THEN RAISE EXCEPTION 'REPORT_REVISION_INVALID'; END IF;
 request:=jsonb_build_object('revisionId',rv.request_id,'draftId',d.draft_id)
  ||CASE WHEN p_action='apply' THEN jsonb_build_object('expectedDiffHash',p_expected_diff_hash) ELSE '{}' END;
 SELECT * INTO prior FROM artifact_requests WHERE project_id=p.id AND request_id=p_request_id;
 IF FOUND THEN
  IF prior.erased_at IS NOT NULL THEN RAISE EXCEPTION 'CONTENT_ERASED'; END IF;
  IF prior.action<>'report_revision_'||p_action OR prior.payload IS DISTINCT FROM request THEN RAISE EXCEPTION 'REPORT_REQUEST_CONFLICT'; END IF;
  RETURN report_revision_state(p.id,rv);
 END IF;
 IF EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p.id AND action IN ('report_revision_apply','report_revision_decline')
  AND payload->>'revisionId'=rv.request_id::text) THEN RAISE EXCEPTION 'REPORT_REVISION_DECIDED'; END IF;

 IF p_action='decline' THEN
  -- Text only: fields, the formal version and the business's current positioning stay unchanged.
  INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
   VALUES(p.id,p_request_id,rv.round_id,'report_revision_decline',request,jsonb_build_object('declinedAt',clock_timestamp()));
  RETURN report_revision_state(p.id,rv);
 END IF;

 SELECT * INTO v FROM artifact_versions WHERE round_id=r.id AND project_id=p.id AND erased_at IS NULL;
 IF r.id IS DISTINCT FROM rv.round_id OR r.state IS DISTINCT FROM 'published' OR v.version IS DISTINCT FROM p.current_version
  OR v.id::text IS DISTINCT FROM rv.payload->>'sourceVersionId' OR NOT content_erasure_artifact_readable(p_actor_id,v.id) THEN
  RAISE EXCEPTION 'REPORT_REVISION_STALE'; END IF;
 diff:=report_revision_diff(r,rv.payload->'fields');
 IF artifact_hash(diff) IS DISTINCT FROM rv.response->>'diffHash' OR p_expected_diff_hash IS DISTINCT FROM rv.response->>'diffHash' THEN
  RAISE EXCEPTION 'REPORT_REVISION_STALE'; END IF;
 IF NOT report_body_complete(rv.payload->>'body',r.workflow->'reportGeneration') THEN RAISE EXCEPTION 'REPORT_NOT_COMPLETE'; END IF;
 applied:=report_revision_apply_core(p_actor_id,d,p,r,rv);
 INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
  VALUES(p.id,p_request_id,(applied->>'roundId')::uuid,'report_revision_apply',request,applied);
 RETURN report_revision_state(p.id,rv);
END $$;
REVOKE ALL ON FUNCTION public.report_revision(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.report_revision(uuid,uuid,text,uuid,uuid,uuid,text,jsonb,text) TO service_role;
COMMIT;
