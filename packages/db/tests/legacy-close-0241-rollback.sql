-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Rollback for 0241_legacy_close_dead_functions.sql (LEGACY-CLOSE PR-B). Recreates the 18 dropped
-- functions with their exact pre-0241 definitions, owners and EXECUTE grants, exported read-only from
-- staging on 2026-10-14 (pg_get_functiondef + proacl). Re-running 0241 afterwards drops them again.
-- No data is involved; the functions had no caller, so restoring them changes no behaviour.
BEGIN;
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION public.agent_preference(p_actor_id uuid, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE scope text:=p_payload->>'scope'; key text:=p_payload->>'name'; pref agent_confirmed_preferences%ROWTYPE;
 request agent_preference_requests%ROWTYPE; digest text:=artifact_hash(jsonb_build_object('action',p_action,'payload',p_payload)); next_version integer;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 IF scope IS NULL OR (scope<>'user' AND NOT EXISTS(SELECT 1 FROM artifact_accounts WHERE actor_id=p_actor_id AND 'account:'||account=scope)) THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 IF p_action='read' THEN
  RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('scope',scope_key,'name',name,'value',value,'version',version,'active',active,'source',source) ORDER BY name)
  FROM agent_confirmed_preferences WHERE actor_id=p_actor_id AND scope_key=scope),'[]');
 END IF;
 IF p_action NOT IN ('confirm','delete') OR p_payload->>'confirmed' IS DISTINCT FROM 'true' OR key IS NULL OR char_length(key) NOT BETWEEN 1 AND 80 OR p_payload->>'requestId' IS NULL THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 -- Replays contain hashes and metadata, never an old preference value.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text, 413));
 SELECT * INTO request FROM agent_preference_requests WHERE actor_id=p_actor_id AND request_id=(p_payload->>'requestId')::uuid;
 IF FOUND THEN
  IF request.payload_hash<>digest THEN RAISE EXCEPTION 'PREFERENCE_CONFLICT'; END IF;
  RETURN jsonb_build_object('version',request.version);
 END IF;
 SELECT * INTO pref FROM agent_confirmed_preferences WHERE actor_id=p_actor_id AND scope_key=scope AND name=key FOR UPDATE;
 IF coalesce(pref.version,0) IS DISTINCT FROM (p_payload->>'expectedVersion')::integer THEN RAISE EXCEPTION 'PREFERENCE_CONFLICT'; END IF;
 IF p_action='confirm' AND (p_payload->>'value' IS NULL OR char_length(btrim(p_payload->>'value')) NOT BETWEEN 1 AND 1000) THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 IF p_action='confirm' AND NOT coalesce(pref.active,false) AND
  (SELECT count(*) FROM agent_confirmed_preferences WHERE actor_id=p_actor_id AND scope_key=scope AND active)>=20
 THEN RAISE EXCEPTION 'PREFERENCE_DENIED'; END IF;
 next_version:=coalesce(pref.version,0)+1;
 INSERT INTO agent_confirmed_preferences(actor_id,scope_key,name,value,version,active,source)
 VALUES(p_actor_id,scope,key,CASE WHEN p_action='confirm' THEN btrim(p_payload->>'value') ELSE NULL END,next_version,p_action='confirm','explicit_user_confirmation')
 ON CONFLICT(actor_id,scope_key,name) DO UPDATE SET value=excluded.value,version=excluded.version,active=excluded.active,updated_at=clock_timestamp();
 INSERT INTO agent_preference_requests VALUES(p_actor_id,(p_payload->>'requestId')::uuid,digest,next_version);
 RETURN jsonb_build_object('version',next_version);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_admission_replay(p_actor_id uuid, p_conversation_id uuid, p_request_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e agent_slice_executions%ROWTYPE;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO e FROM agent_slice_executions WHERE request_id=p_request_id;
 IF NOT FOUND THEN RETURN 'null'; END IF;
 RETURN agent_slice_begin(p_actor_id,p_conversation_id,p_request_id,p_payload||jsonb_build_object('modelId',e.model_id,'budgetCredits',e.budget_credits));
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_admit(p_actor_id uuid, p_conversation_id uuid, p_request_id uuid, p_payload jsonb, p_summary_model_id uuid, p_summary_max_tokens integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 PERFORM 1 FROM system_settings WHERE key IN ('v3_summary_model_id','v3_summary_max_tokens') FOR SHARE;
 IF (SELECT value#>>'{}' FROM system_settings WHERE key='v3_summary_model_id') IS DISTINCT FROM p_summary_model_id::text
  OR coalesce((SELECT (value#>>'{}')::integer FROM system_settings WHERE key='v3_summary_max_tokens'),2048) IS DISTINCT FROM p_summary_max_tokens
 THEN RAISE EXCEPTION 'slice summary configuration changed'; END IF;
 RETURN agent_slice_begin(p_actor_id,p_conversation_id,p_request_id,p_payload);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_begin_before_entry(p_actor_id uuid, p_conversation_id uuid, p_request_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p artifact_projects%ROWTYPE;r artifact_rounds%ROWTYPE;cfg agent_slice_pairs%ROWTYPE;
 a artifact_workflows%ROWTYPE;b artifact_workflows%ROWTYPE;prior agent_slice_executions%ROWTYPE;
 ev jsonb;refs jsonb:=coalesce(p_payload->'preferenceRefs','[]');model_name text;account_name text;summary_id uuid;summary_name text;summary_limit integer;body text:=p_payload->>'body';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND is_deleted='false' FOR UPDATE;
 IF NOT FOUND OR EXISTS(SELECT 1 FROM artifact_chats WHERE conversation_id=p_conversation_id) THEN RAISE EXCEPTION 'slice conversation denied'; END IF;
 SELECT * INTO prior FROM agent_slice_executions WHERE request_id=p_request_id;
 IF FOUND THEN
  IF prior.conversation_id<>p_conversation_id OR prior.input_hash<>artifact_hash(p_payload) THEN RAISE EXCEPTION 'slice execution conflict'; END IF;
  RETURN jsonb_build_object('requestId',prior.request_id,'projectId',prior.project_id,'roundId',prior.round_id,'revisionId',prior.revision_id);
 END IF;
 IF body IS NULL OR char_length(btrim(body)) NOT BETWEEN 1 AND 2000 OR (p_payload-'projectId'-'roundId'-'stepId'-'pairId'-'modelId'-'budgetCredits'-'body'-'preferenceRefs')<>'{}' THEN RAISE EXCEPTION 'slice input invalid'; END IF;
 SELECT * INTO p FROM artifact_projects WHERE id=(p_payload->>'projectId')::uuid AND actor_id=p_actor_id AND work_kind='script' FOR UPDATE;
 SELECT * INTO r FROM artifact_rounds WHERE id=(p_payload->>'roundId')::uuid AND project_id=p.id AND state='draft';
 IF p.id IS NULL OR r.id IS NULL OR NOT (r.steps ? (p_payload->>'stepId')) THEN RAISE EXCEPTION 'slice target denied'; END IF;
 SELECT * INTO cfg FROM agent_slice_pairs WHERE id=p_payload->>'pairId' AND enabled FOR SHARE;
 SELECT * INTO a FROM artifact_workflows WHERE id=cfg.script_workflow AND enabled;
 SELECT * INTO b FROM artifact_workflows WHERE id=cfg.title_workflow AND enabled;
 IF cfg.id IS NULL OR a.id IS NULL OR b.id IS NULL OR ((p.module_id=a.module_id AND p.skill_id=a.skill_id AND r.workflow->>'id'=a.workflow->>'id')
  OR (p.module_id=b.module_id AND p.skill_id=b.skill_id AND r.workflow->>'id'=b.workflow->>'id')) IS DISTINCT FROM true THEN RAISE EXCEPTION 'slice method denied'; END IF;
 PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,NULL,NULL);
 SELECT am.model_id INTO model_name FROM ai_models am JOIN modules m ON m.model_id=am.id
  WHERE m.id=p.module_id AND am.id=(p_payload->>'modelId')::uuid AND am.is_active='true' AND am.model_id !~* '(^openai/|gpt)';
 IF model_name IS NULL THEN RAISE EXCEPTION 'slice model unavailable'; END IF;
 SELECT (value#>>'{}')::uuid INTO summary_id FROM system_settings WHERE key='v3_summary_model_id';
 SELECT coalesce((SELECT (value#>>'{}')::integer FROM system_settings WHERE key='v3_summary_max_tokens'),2048) INTO summary_limit;
 SELECT model_id INTO summary_name FROM ai_models WHERE id=summary_id AND is_active='true' AND model_id !~* '(^openai/|gpt)';
 IF summary_name IS NULL OR summary_id=(p_payload->>'modelId')::uuid OR lower(btrim(summary_name))=lower(btrim(model_name))
  OR summary_limit NOT BETWEEN 128 AND 4096 THEN RAISE EXCEPTION 'slice summary model unavailable'; END IF;
 SELECT root.account INTO account_name FROM artifact_projects root WHERE root.id=p.source_project_id;
 IF account_name IS NULL OR NOT agent_slice_preferences_valid(p_actor_id,refs,account_name) THEN RAISE EXCEPTION 'slice preference changed'; END IF;
 ev:=artifact_step_evidence(r.workflow,r.steps,p_payload->>'stepId');
 IF NOT artifact_evidence_allowed(p.id,ev) OR NOT artifact_generation_inputs_current(r.workflow,r.steps,p_payload->>'stepId') THEN RAISE EXCEPTION 'slice source unavailable'; END IF;
 INSERT INTO artifact_requests(project_id,request_id,round_id,action,payload,response)
  VALUES(p.id,p_request_id,r.id,'slice_input',jsonb_build_object('body',body,'evidenceIds',ev),'{}');
 INSERT INTO agent_slice_executions(request_id,conversation_id,project_id,round_id,step_id,revision_id,pair_id,model_id,provider_model,budget_credits,evidence_ids,basis,preference_refs,input_hash,summary_model_id,summary_provider_model,summary_max_tokens)
  VALUES(p_request_id,p_conversation_id,p.id,r.id,p_payload->>'stepId',r.revision_id,cfg.id,(p_payload->>'modelId')::uuid,model_name,(p_payload->>'budgetCredits')::integer,ev,artifact_generation_basis(r.workflow,r.steps,p_payload->>'stepId'),refs,artifact_hash(p_payload),summary_id,summary_name,summary_limit);
 RETURN jsonb_build_object('requestId',p_request_id,'projectId',p.id,'roundId',r.id,'revisionId',r.revision_id);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_begin(p_actor_id uuid, p_conversation_id uuid, p_request_id uuid, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND agent_slice_mode AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 RETURN agent_slice_begin_before_entry(p_actor_id,p_conversation_id,p_request_id,p_payload);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_context_before_discussion(p_actor_id uuid, p_execution_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e agent_slice_executions%ROWTYPE;p artifact_projects%ROWTYPE;r artifact_rounds%ROWTYPE;account_name text;body text;
BEGIN
 SELECT * INTO e FROM agent_slice_executions WHERE request_id=p_execution_id;
 SELECT * INTO p FROM artifact_projects WHERE id=e.project_id AND actor_id=p_actor_id;
 IF p.id IS NULL OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
  OR NOT EXISTS(SELECT 1 FROM conversations WHERE id=e.conversation_id AND user_id=p_actor_id AND is_deleted='false')
 THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,e.revision_id,NULL,NULL);
 SELECT * INTO r FROM artifact_rounds WHERE id=e.round_id AND project_id=p.id;
 SELECT account INTO account_name FROM artifact_projects WHERE id=p.source_project_id;
 IF r.state<>'draft' OR r.revision_id<>e.revision_id OR artifact_generation_basis(r.workflow,r.steps,e.step_id) IS DISTINCT FROM e.basis
  OR NOT artifact_evidence_allowed(p.id,e.evidence_ids) OR NOT agent_slice_preferences_valid(p_actor_id,e.preference_refs,account_name)
 THEN RAISE EXCEPTION 'slice context changed'; END IF;
 SELECT payload->>'body' INTO body FROM artifact_requests WHERE project_id=p.id AND request_id=e.request_id AND action='slice_input';
 IF body IS NULL THEN RAISE EXCEPTION 'slice input missing'; END IF;
 RETURN jsonb_build_object('executionId',e.request_id,'conversationId',e.conversation_id,'projectId',p.id,'roundId',r.id,'stepId',e.step_id,
 'moduleId',p.module_id,'skillId',p.skill_id,'revisionId',e.revision_id,'packageHash',r.package_hash,'workflow',r.workflow,
 'modelId',e.model_id,'providerModel',e.provider_model,'summaryModelId',e.summary_model_id,'summaryProviderModel',e.summary_provider_model,
 'summaryMaxTokens',e.summary_max_tokens,'preferenceRefs',e.preference_refs,'evidenceIds',e.evidence_ids,'basis',e.basis,'body',body);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_context(p_actor_id uuid, p_execution_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE value jsonb;e agent_slice_executions%ROWTYPE;previous agent_slice_executions%ROWTYPE;ref jsonb;c artifact_candidates%ROWTYPE;input_body text;discussion jsonb:='[]';
BEGIN
 value:=agent_slice_context_before_discussion(p_actor_id,p_execution_id);
 SELECT * INTO e FROM agent_slice_executions WHERE request_id=p_execution_id;
 FOR ref IN SELECT * FROM jsonb_array_elements(e.discussion_refs) LOOP
  SELECT * INTO previous FROM agent_slice_executions WHERE request_id=(ref->>'executionId')::uuid
   AND conversation_id=e.conversation_id AND project_id=e.project_id AND round_id=e.round_id;
  SELECT * INTO c FROM artifact_candidates WHERE id=(ref->>'candidateId')::uuid AND round_id=e.round_id;
  IF previous.request_id IS NULL OR c.id IS NULL OR c.body IS NULL OR NOT(c.evidence_ids <@ e.evidence_ids)
   OR NOT artifact_evidence_allowed(e.project_id,c.evidence_ids) THEN RAISE EXCEPTION 'slice discussion unavailable'; END IF;
  SELECT payload->>'body' INTO input_body FROM artifact_requests WHERE project_id=e.project_id AND request_id=previous.request_id AND action='slice_input';
  IF input_body IS NULL THEN RAISE EXCEPTION 'slice discussion unavailable'; END IF;
  discussion:=discussion||jsonb_build_array(jsonb_build_object('user',input_body,'assistant',c.body));
 END LOOP;
 RETURN value||jsonb_build_object('discussion',discussion);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_continue_work(p_actor_id uuid, p_request_id uuid, p_project_id uuid, p_source_version_id uuid, p_pair_id text, p_purpose text, p_title text, p_from_round_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE source artifact_projects%ROWTYPE; v artifact_versions%ROWTYPE; root artifact_projects%ROWTYPE; position artifact_versions%ROWTYPE;
 cfg agent_slice_pairs%ROWTYPE; ref artifact_work_references%ROWTYPE; configs text[]; selected_workflow text; payload jsonb; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO cfg FROM agent_slice_pairs WHERE id=p_pair_id AND enabled FOR SHARE;
 SELECT * INTO v FROM artifact_versions WHERE id=p_source_version_id;
 SELECT * INTO source FROM artifact_projects WHERE id=v.project_id AND actor_id=p_actor_id;
 IF cfg.id IS NULL OR source.id IS NULL OR p_purpose IS NULL OR p_purpose NOT IN ('script','title') OR NOT artifact_evidence_allowed(source.id,v.evidence_ids) THEN RAISE EXCEPTION 'slice source denied' USING ERRCODE='42501'; END IF;
 IF source.work_kind='legacy' THEN
  IF p_purpose<>'script' OR p_from_round_id IS NOT NULL THEN RAISE EXCEPTION 'slice transition invalid'; END IF;
  position:=v;
 ELSE
  IF p_purpose='script' AND p_from_round_id IS NULL THEN RAISE EXCEPTION 'script revision required'; END IF;
  IF p_purpose='title' AND p_from_round_id IS NOT NULL THEN RAISE EXCEPTION 'new title work required'; END IF;
  SELECT * INTO ref FROM artifact_work_references WHERE round_id=CASE WHEN p_purpose='script' THEN p_from_round_id ELSE v.round_id END;
  IF ref.round_id IS NULL OR (p_purpose='script' AND ref.project_id<>p_project_id) THEN RAISE EXCEPTION 'slice target denied' USING ERRCODE='42501'; END IF;
  SELECT * INTO position FROM artifact_versions WHERE id=ref.source_version_id;
 END IF;
 SELECT * INTO root FROM artifact_projects WHERE id=position.project_id AND actor_id=p_actor_id AND work_kind='legacy';
 IF root.id IS NULL OR (source.work_kind='script' AND source.source_project_id IS DISTINCT FROM root.id) THEN RAISE EXCEPTION 'slice account denied' USING ERRCODE='42501'; END IF;
 selected_workflow:=CASE WHEN p_purpose='script' THEN cfg.script_workflow ELSE cfg.title_workflow END;
 SELECT array_agg(c.id ORDER BY c.id) INTO configs FROM artifact_reference_configs c JOIN artifact_workflows w ON w.id=c.source_workflow AND w.enabled
 JOIN artifact_rounds r ON r.id=position.round_id AND r.state='published' AND r.workflow->>'id'=w.workflow->>'id'
 WHERE c.enabled AND c.target_workflow=selected_workflow AND w.module_id=root.module_id AND w.skill_id=root.skill_id;
 IF coalesce(cardinality(configs),0)<>1 THEN RAISE EXCEPTION 'one reference configuration required'; END IF;
 payload:=jsonb_build_object('sourceVersionId',position.id,'configId',configs[1],'title',p_title,
  'slicePair',cfg.id,'sliceSourceVersion',v.id,'slicePurpose',p_purpose);
 IF p_from_round_id IS NOT NULL THEN payload:=payload||jsonb_build_object('fromRoundId',p_from_round_id); END IF;
 result:=artifact_create_work(p_actor_id,p_project_id,p_request_id,p_request_id,payload);
 IF source.work_kind='script' THEN PERFORM agent_slice_link(p_actor_id,p_project_id,p_request_id,v.id,cfg.id,p_request_id); END IF;
 RETURN result;
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_conversation(p_actor_id uuid, p_conversation_id uuid, p_before_time timestamp with time zone DEFAULT NULL::timestamp with time zone, p_before_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 20)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE e agent_slice_executions%ROWTYPE; reply jsonb; summary jsonb; rows jsonb:='[]'; next_cursor jsonb:=NULL; n integer:=0; permitted boolean; input_body text; step_title text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') OR
 NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_conversation_id AND user_id=p_actor_id AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 20 OR (p_before_time IS NULL)<>(p_before_id IS NULL) THEN RAISE EXCEPTION 'slice cursor invalid'; END IF;
 FOR e IN SELECT * FROM agent_slice_executions WHERE conversation_id=p_conversation_id
  AND (p_before_time IS NULL OR (created_at,request_id)<(p_before_time,p_before_id))
  ORDER BY created_at DESC,request_id DESC LIMIT p_limit+1
 LOOP
  n:=n+1;
  IF n>p_limit THEN EXIT; END IF;
  permitted:=EXISTS(SELECT 1 FROM artifact_projects WHERE id=e.project_id AND actor_id=p_actor_id);
  reply:=jsonb_build_object('state','restricted'); summary:=reply; input_body:=NULL;
  IF permitted THEN
   BEGIN
    reply:=agent_slice_result(p_actor_id,e.request_id,'reply','read');
    summary:=agent_slice_result(p_actor_id,e.request_id,'summary','read');
   EXCEPTION WHEN insufficient_privilege THEN
    reply:=jsonb_build_object('state','restricted'); summary:=reply;
   WHEN raise_exception THEN
    IF SQLERRM<>'Skill unavailable' THEN RAISE; END IF;
    reply:=jsonb_build_object('state','restricted'); summary:=reply;
   END;
  END IF;
  IF reply->>'state'<>'restricted' AND summary->>'state'<>'restricted' THEN
   SELECT payload->>'body' INTO input_body FROM artifact_requests WHERE project_id=e.project_id AND request_id=e.request_id AND action='slice_input';
   IF input_body IS NULL THEN RAISE EXCEPTION 'slice input unavailable'; END IF;
  ELSE reply:=jsonb_build_object('state','restricted'); summary:=reply; END IF;
  SELECT s->>'title' INTO step_title FROM artifact_rounds r CROSS JOIN LATERAL jsonb_array_elements(r.workflow->'steps') s WHERE r.id=e.round_id AND s->>'id'=e.step_id;
  rows:=rows||jsonb_build_array(jsonb_build_object('executionId',e.request_id,'createdAt',e.created_at,'projectId',e.project_id,'roundId',e.round_id,'stepId',e.step_id,'pairId',e.pair_id,'stepTitle',coalesce(step_title,'创作'),'input',input_body,'reply',reply,'summary',summary));
  next_cursor:=jsonb_build_object('createdAt',e.created_at,'executionId',e.request_id);
 END LOOP;
 RETURN jsonb_build_object('items',rows,'nextCursor',CASE WHEN n>p_limit THEN next_cursor ELSE NULL END);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_link_read(p_actor_id uuid, p_project_id uuid, p_round_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE p artifact_projects%ROWTYPE; r artifact_rounds%ROWTYPE; link agent_slice_links%ROWTYPE;
 v artifact_versions%ROWTYPE; source artifact_projects%ROWTYPE; sr artifact_rounds%ROWTYPE; cfg agent_slice_pairs%ROWTYPE; account_name text;
BEGIN
 SELECT * INTO p FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p.id;
 SELECT * INTO link FROM agent_slice_links WHERE round_id=r.id;
 IF link.round_id IS NULL OR NOT artifact_evidence_allowed(p.id,jsonb_build_array(link.evidence_id)) THEN RAISE EXCEPTION 'slice source unavailable'; END IF;
 SELECT * INTO v FROM artifact_versions WHERE id=link.source_version_id;
 SELECT * INTO source FROM artifact_projects WHERE id=v.project_id;
 SELECT * INTO sr FROM artifact_rounds WHERE id=v.round_id;
 SELECT * INTO cfg FROM agent_slice_pairs WHERE id=link.pair_id AND enabled;
 SELECT root.account INTO account_name FROM artifact_projects root WHERE root.id=p.source_project_id;
 PERFORM read_skill_package(p_actor_id,p.module_id,p.skill_id,r.revision_id,NULL,NULL);
 PERFORM read_skill_package(p_actor_id,source.module_id,source.skill_id,sr.revision_id,NULL,NULL);
 RETURN jsonb_build_object('projectId',source.id,'roundId',sr.id,'versionId',v.id,'version',v.version,'hash',v.report_hash,
  'targetProjectId',p.id,'targetRoundId',r.id,'account',account_name,'sections',link.section_ids,'maxChars',cfg.max_chars);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_open(p_actor_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 INSERT INTO conversations(id,user_id,title,agent_slice_mode) VALUES(p_request_id,p_actor_id,'连续创作',true) ON CONFLICT(id) DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM conversations WHERE id=p_request_id AND user_id=p_actor_id AND agent_slice_mode AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 RETURN jsonb_build_object('conversationId',p_request_id);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_selected_source(p_actor_id uuid, p_execution_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE context jsonb;selection jsonb;report jsonb;sections jsonb;
BEGIN
 context:=agent_slice_context(p_actor_id,p_execution_id);
 IF EXISTS(SELECT 1 FROM agent_slice_links WHERE round_id=(context->>'roundId')::uuid) THEN
  selection:=agent_slice_link_read(p_actor_id,(context->>'projectId')::uuid,(context->>'roundId')::uuid);
  SELECT v.report INTO report FROM artifact_versions v WHERE id=(selection->>'versionId')::uuid AND report_hash=selection->>'hash';
  SELECT jsonb_agg(jsonb_build_object('title',s->>'title','body',s->>'body') ORDER BY n) INTO sections
   FROM jsonb_array_elements(report->'sections') WITH ORDINALITY t(s,n) WHERE selection->'sections' ? (s->>'stepId');
 ELSE
  selection:=artifact_work_source(p_actor_id,(context->>'projectId')::uuid,(context->>'roundId')::uuid);
  SELECT jsonb_agg(jsonb_build_object('title',s->>'title','body',s->>'body') ORDER BY n) INTO sections FROM jsonb_array_elements(selection->'sections') WITH ORDINALITY t(s,n);
 END IF;
 IF sections IS NULL OR jsonb_array_length(sections)=0 OR (SELECT sum(char_length(s->>'body')) FROM jsonb_array_elements(sections) s)>coalesce((selection->>'maxChars')::integer,20000) THEN RAISE EXCEPTION 'slice source unavailable'; END IF;
 RETURN jsonb_build_object('kind','formal_report','version',(selection->>'version')::integer,'sections',sections);
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_sources(p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE item record; result jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 FOR item IN
 SELECT p.id project_id,p.account,p.module_id,p.skill_id,r.revision_id,v.id version_id,v.version,v.evidence_ids,
  coalesce(p.work_title,r.workflow->'report'->>'title','定位报告') title,pair.id pair_id,tw.label,
  tw.module_id target_module,tw.skill_id target_skill,tw.revision_id target_revision
 FROM artifact_projects p JOIN artifact_rounds r ON r.project_id=p.id AND r.state='published'
 JOIN artifact_versions v ON v.round_id=r.id
 JOIN artifact_workflows sw ON sw.module_id=p.module_id AND sw.skill_id=p.skill_id AND sw.enabled AND sw.workflow->>'id'=r.workflow->>'id'
 JOIN artifact_reference_configs cfg ON cfg.source_workflow=sw.id AND cfg.enabled
 JOIN agent_slice_pairs pair ON pair.script_workflow=cfg.target_workflow AND pair.enabled
 JOIN artifact_workflows tw ON tw.id=pair.script_workflow AND tw.enabled
 WHERE p.actor_id=p_actor_id AND p.work_kind='legacy'
 AND EXISTS(SELECT 1 FROM artifact_accounts ac WHERE ac.actor_id=p_actor_id AND ac.module_id=p.module_id AND ac.skill_id=p.skill_id AND ac.account=p.account)
 AND (SELECT count(*) FROM artifact_reference_configs c JOIN artifact_workflows w ON w.id=c.source_workflow AND w.enabled
      WHERE c.enabled AND c.target_workflow=pair.script_workflow AND w.module_id=p.module_id AND w.skill_id=p.skill_id AND w.workflow->>'id'=r.workflow->>'id')=1
 ORDER BY p.created_at DESC,p.id,v.version DESC,pair.id LIMIT 100
 LOOP
  IF NOT artifact_evidence_allowed(item.project_id,item.evidence_ids) THEN CONTINUE; END IF;
  BEGIN
   PERFORM read_skill_package(p_actor_id,item.module_id,item.skill_id,item.revision_id,NULL,NULL);
   PERFORM read_skill_package(p_actor_id,item.target_module,item.target_skill,item.target_revision,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
  WHEN raise_exception THEN IF SQLERRM='Skill unavailable' THEN CONTINUE; ELSE RAISE; END IF; END;
  result:=result||jsonb_build_array(jsonb_build_object('projectId',item.project_id,'sourceVersionId',item.version_id,'version',item.version,'title',item.title,'account',item.account,'pairId',item.pair_id,'skillTitle',item.label));
 END LOOP;
 RETURN result;
END $function$
;
CREATE OR REPLACE FUNCTION public.agent_slice_targets(p_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE item record; result jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'slice denied' USING ERRCODE='42501'; END IF;
 FOR item IN SELECT p.id project_id,p.module_id,p.skill_id,p.work_title,r.id round_id,r.revision_id,r.workflow,r.steps,r.state,sv.version source_version,coalesce(sp.work_title,'定位报告') source_title,(SELECT version FROM artifact_versions WHERE round_id=r.id) version,c.id pair_id,source.account,
  CASE WHEN w.id=c.script_workflow THEN 'script' ELSE 'title' END purpose
  FROM artifact_projects p JOIN artifact_rounds r ON r.project_id=p.id AND r.state IN ('draft','published')
  JOIN artifact_projects source ON source.id=p.source_project_id AND source.actor_id=p_actor_id
  JOIN artifact_workflows w ON w.module_id=p.module_id AND w.skill_id=p.skill_id AND w.workflow->>'id'=r.workflow->>'id' AND w.enabled
  JOIN agent_slice_pairs c ON (c.script_workflow=w.id OR c.title_workflow=w.id) AND c.enabled
  LEFT JOIN agent_slice_links l ON l.round_id=r.id
  LEFT JOIN artifact_work_references wr ON wr.round_id=r.id
  LEFT JOIN artifact_versions sv ON sv.id=coalesce(l.source_version_id,wr.source_version_id)
  LEFT JOIN artifact_projects sp ON sp.id=sv.project_id AND sp.actor_id=p_actor_id
  WHERE p.actor_id=p_actor_id AND p.work_kind='script' ORDER BY p.created_at DESC,p.id,c.id LIMIT 100
 LOOP
  BEGIN PERFORM read_skill_package(p_actor_id,item.module_id,item.skill_id,item.revision_id,NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
  WHEN raise_exception THEN IF SQLERRM='Skill unavailable' THEN CONTINUE; ELSE RAISE; END IF; END;
  result:=result||jsonb_build_array(jsonb_build_object('projectId',item.project_id,'roundId',item.round_id,'pairId',item.pair_id,'purpose',item.purpose,'state',item.state,'version',item.version,'sourceVersion',item.source_version,'sourceTitle',item.source_title,
   'title',coalesce(item.work_title,item.workflow->'report'->>'title','作品'),'account',item.account,
   'steps',(SELECT jsonb_agg(jsonb_build_object('id',s->>'id','title',s->>'title') ORDER BY n) FROM jsonb_array_elements(item.workflow->'steps') WITH ORDINALITY t(s,n))));
 END LOOP;
 RETURN result;
END $function$
;
CREATE OR REPLACE FUNCTION public.artifact_observe_generation(p_actor_id uuid, p_project_id uuid, p_round_id uuid, p_request_id uuid, p_token uuid, p_observation jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE o public.artifact_generations%ROWTYPE; phase text; k text; v jsonb;
BEGIN
 -- Same project-first lock order as artifact_generation and rejection.
 PERFORM 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false')
 THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO o FROM artifact_generations
 WHERE project_id=p_project_id AND round_id=p_round_id AND request_id=p_request_id FOR UPDATE;
 IF NOT FOUND OR o.dispatch_token IS DISTINCT FROM p_token OR o.state NOT IN ('dispatched','unknown','responded','succeeded','refunded')
 THEN RAISE EXCEPTION 'generation conflict'; END IF;
 IF jsonb_typeof(p_observation) IS DISTINCT FROM 'object' OR octet_length(p_observation::text)>2048
 THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
 IF NOT (p_observation ?& ARRAY['phase','httpStatus','providerResponseId','finishReason','usage'])
 OR (p_observation - ARRAY['phase','httpStatus','providerResponseId','finishReason','usage']) <> '{}'::jsonb
 THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
 phase:=p_observation->>'phase';
 IF phase IS NULL OR phase NOT IN ('headers','body')
 OR jsonb_typeof(p_observation->'httpStatus') IS DISTINCT FROM 'number'
 OR (p_observation->>'httpStatus')::numeric NOT BETWEEN 100 AND 599
 OR (p_observation->>'httpStatus')::numeric <> trunc((p_observation->>'httpStatus')::numeric)
 THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
 FOREACH k IN ARRAY ARRAY['providerResponseId','finishReason'] LOOP
  v:=p_observation->k;
  IF v <> 'null'::jsonb AND (jsonb_typeof(v)<>'string'
   OR (k='providerResponseId' AND (p_observation->>k) !~ '^[A-Za-z0-9_-]{1,200}$')
   OR (k='finishReason' AND (p_observation->>k) !~ '^[A-Za-z0-9_-]{1,64}$'))
  THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
 END LOOP;
 v:=p_observation->'usage';
 IF v <> 'null'::jsonb THEN
  IF jsonb_typeof(v)<>'object' OR NOT (v ?& ARRAY['promptTokens','completionTokens','reportedCostUsd'])
   OR (v - ARRAY['promptTokens','completionTokens','reportedCostUsd']) <> '{}'::jsonb
  THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
  FOREACH k IN ARRAY ARRAY['promptTokens','completionTokens','reportedCostUsd'] LOOP
   IF v->k <> 'null'::jsonb THEN
    IF jsonb_typeof(v->k)<>'number' THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
    IF (v->>k)::numeric < 0 OR (k<>'reportedCostUsd' AND
      ((v->>k)::numeric>9007199254740991 OR (v->>k)::numeric<>trunc((v->>k)::numeric)))
    THEN RAISE EXCEPTION 'invalid provider observation'; END IF;
   END IF;
  END LOOP;
 END IF;
 -- Each of the two observations is immutable and idempotent. Different header
 -- and body IDs are retained separately; neither is a settlement authority.
 IF o.provider_observations ? phase THEN
  IF o.provider_observations->phase IS DISTINCT FROM p_observation
  THEN RAISE EXCEPTION 'provider observation conflict'; END IF;
  RETURN;
 END IF;
 UPDATE artifact_generations SET provider_observations=
  coalesce(provider_observations,'{}'::jsonb)||jsonb_build_object(phase,p_observation)
 WHERE id=o.id;
END $function$
;
CREATE OR REPLACE FUNCTION public.artifact_reference_choices(p_actor_id uuid, p_source_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE source artifact_projects%ROWTYPE; v artifact_versions%ROWTYPE; cfg artifact_reference_configs%ROWTYPE; w artifact_workflows%ROWTYPE; result jsonb:='[]';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'artifact denied' USING ERRCODE='42501'; END IF;
 SELECT * INTO v FROM artifact_versions WHERE id=p_source_version_id;
 SELECT * INTO source FROM artifact_projects WHERE id=v.project_id AND actor_id=p_actor_id AND work_kind='legacy';
 IF NOT FOUND THEN RAISE EXCEPTION 'source denied' USING ERRCODE='42501'; END IF;
 IF NOT artifact_evidence_allowed(source.id,v.evidence_ids) THEN RAISE EXCEPTION 'source unavailable'; END IF;
 FOR cfg IN SELECT c.* FROM artifact_reference_configs c JOIN artifact_workflows sw ON sw.id=c.source_workflow
  WHERE c.enabled AND sw.module_id=source.module_id AND sw.skill_id=source.skill_id ORDER BY c.id LOOP
  SELECT * INTO w FROM artifact_workflows WHERE id=cfg.target_workflow AND enabled AND workflow->>'kind'='document';
  IF FOUND THEN
   BEGIN
    PERFORM read_skill_package(p_actor_id,w.module_id,w.skill_id,w.revision_id,NULL,NULL);
    result:=result||jsonb_build_array(jsonb_build_object('id',cfg.id,'label',w.label));
   EXCEPTION WHEN insufficient_privilege THEN CONTINUE;
   WHEN raise_exception THEN IF SQLERRM='Skill unavailable' THEN CONTINUE; ELSE RAISE; END IF;
   END;
  END IF;
 END LOOP;
 RETURN result;
END $function$
;
CREATE OR REPLACE FUNCTION public.ordinary_chat_claim(p_user_id uuid, p_request_id uuid, p_input jsonb, p_writer_token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r ordinary_chat_requests; c conversations; v_conversation uuid;
BEGIN
  IF p_request_id IS NULL OR p_writer_token IS NULL OR jsonb_typeof(p_input) <> 'object'
    OR COALESCE(length(p_input->>'message'),0)=0 THEN RAISE EXCEPTION 'CHAT_INPUT_INVALID'; END IF;
  -- Serializes first insertion as well as concurrent cross-user UUID reuse.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text,780));
  SELECT * INTO r FROM ordinary_chat_requests WHERE request_id=p_request_id;
  IF FOUND THEN
    IF r.user_id IS DISTINCT FROM p_user_id OR r.input IS DISTINCT FROM p_input THEN RAISE EXCEPTION 'CHAT_IDENTITY_CONFLICT'; END IF;
    RETURN jsonb_build_object('claimed',false,'request',to_jsonb(r));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_user_id AND status='active' AND is_deleted='false') THEN RAISE EXCEPTION 'CHAT_ACCESS_DENIED'; END IF;
  IF EXISTS(SELECT 1 FROM ai_usage_logs WHERE request_id=p_request_id::text)
    OR EXISTS(SELECT 1 FROM billing_history WHERE metadata->>'requestId'=p_request_id::text) THEN RAISE EXCEPTION 'CHAT_IDENTITY_CONFLICT'; END IF;
  v_conversation := (p_input->>'conversationId')::uuid;
  IF v_conversation IS NOT NULL THEN
    SELECT * INTO c FROM conversations WHERE id=v_conversation AND user_id=p_user_id AND is_deleted='false' AND NOT skill_mode;
    IF NOT FOUND OR ((p_input->>'moduleId') IS NOT NULL AND c.module_id IS DISTINCT FROM (p_input->>'moduleId')::uuid) THEN RAISE EXCEPTION 'CHAT_ACCESS_DENIED'; END IF;
  ELSE
    INSERT INTO conversations(user_id,title,module_id) VALUES(p_user_id,left(p_input->>'message',50),(p_input->>'moduleId')::uuid) RETURNING id INTO v_conversation;
  END IF;
  INSERT INTO ordinary_chat_requests(request_id,user_id,input,conversation_id,writer_token)
  VALUES(p_request_id,p_user_id,p_input,v_conversation,p_writer_token) RETURNING * INTO r;
  RETURN jsonb_build_object('claimed',true,'request',to_jsonb(r));
END $function$
;
CREATE OR REPLACE FUNCTION public.soft_delete_conversation(p_conversation_id uuid, p_user_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NULL OR auth.uid() <> p_user_id THEN
    RETURN false;
  END IF;

  -- DATA-ERASURE PR-A: a closed account's unexpired JWT changes nothing.
  IF EXISTS (SELECT 1 FROM public.account_erasure_requests WHERE profile_id = p_user_id) THEN
    RETURN false;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.conversations
    WHERE id = p_conversation_id
      AND user_id = p_user_id
      AND is_deleted = 'false'
  ) THEN
    RETURN false;
  END IF;

  UPDATE public.conversations
  SET is_deleted = 'true',
      deleted_at = NOW()
  WHERE id = p_conversation_id
    AND user_id = p_user_id;

  UPDATE public.messages
  SET is_deleted = 'true',
      deleted_at = NOW()
  WHERE conversation_id = p_conversation_id;

  RETURN true;
END;
$function$
;
ALTER FUNCTION public.agent_preference(uuid,text,jsonb) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_admission_replay(uuid,uuid,uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_admit(uuid,uuid,uuid,jsonb,uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_begin_before_entry(uuid,uuid,uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_begin(uuid,uuid,uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_context_before_discussion(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_context(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_continue_work(uuid,uuid,uuid,uuid,text,text,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_conversation(uuid,uuid,timestamp with time zone,uuid,integer) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_link_read(uuid,uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_open(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_selected_source(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_sources(uuid) OWNER TO postgres;
ALTER FUNCTION public.agent_slice_targets(uuid) OWNER TO postgres;
ALTER FUNCTION public.artifact_observe_generation(uuid,uuid,uuid,uuid,uuid,jsonb) OWNER TO postgres;
ALTER FUNCTION public.artifact_reference_choices(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.ordinary_chat_claim(uuid,uuid,jsonb,uuid) OWNER TO postgres;
ALTER FUNCTION public.soft_delete_conversation(uuid,uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.agent_preference(uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_admission_replay(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_admit(uuid,uuid,uuid,jsonb,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_begin_before_entry(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_begin(uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_context_before_discussion(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_context(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_continue_work(uuid,uuid,uuid,uuid,text,text,text,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_conversation(uuid,uuid,timestamp with time zone,uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_link_read(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_open(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_selected_source(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_sources(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.agent_slice_targets(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.artifact_observe_generation(uuid,uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.artifact_reference_choices(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ordinary_chat_claim(uuid,uuid,jsonb,uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.soft_delete_conversation(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.agent_preference(uuid,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_admission_replay(uuid,uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_admit(uuid,uuid,uuid,jsonb,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_begin(uuid,uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_context(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_continue_work(uuid,uuid,uuid,uuid,text,text,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_conversation(uuid,uuid,timestamp with time zone,uuid,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_link_read(uuid,uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_open(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_selected_source(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_sources(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_slice_targets(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.artifact_observe_generation(uuid,uuid,uuid,uuid,uuid,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.artifact_reference_choices(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.soft_delete_conversation(uuid,uuid) TO authenticated;
COMMIT;
