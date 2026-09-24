/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- An account revision is an ordinary OPC positioning draft and immutable
-- artifact version. This table only binds that draft to the account whose
-- source it may replace; it does not store strategy content or history.
BEGIN;

CREATE TABLE IF NOT EXISTS opc_account_strategy_drafts (
 account_project_id uuid PRIMARY KEY REFERENCES opc_accounts(project_id),
 draft_id uuid NOT NULL UNIQUE REFERENCES opc_drafts(draft_id),
 actor_id uuid NOT NULL REFERENCES profiles(id),
 root_source_version_id uuid NOT NULL REFERENCES artifact_versions(id),
 base_source_version_id uuid NOT NULL REFERENCES artifact_versions(id),
 base_account_revision bigint NOT NULL
);
ALTER TABLE opc_account_strategy_drafts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_account_strategy_drafts FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION opc_account_strategy_begin(p_actor_id uuid,p_account_project_id uuid,p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a opc_accounts;binding opc_account_strategy_drafts;d opc_drafts;source_d opc_drafts;
 source_v artifact_versions;source_workflow artifact_workflows;current_workflow artifact_workflows;
 r artifact_rounds;started jsonb;step jsonb;field jsonb;profile jsonb;values jsonb;value text;old jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_account_project_id IS NULL THEN RAISE EXCEPTION 'OPC_INPUT';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_account_project_id::text,125));
 SELECT * INTO a FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF a.project_id IS NULL OR NOT opc_source_allowed(p_actor_id,a.source_version_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 -- An uncertain start retries the same request, even after its draft is published.
 SELECT * INTO d FROM opc_drafts WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF d.draft_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM opc_account_strategy_drafts WHERE draft_id=d.draft_id AND account_project_id=p_account_project_id)
   THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id);
 END IF;
 SELECT * INTO binding FROM opc_account_strategy_drafts WHERE account_project_id=p_account_project_id FOR UPDATE;
 IF binding.draft_id IS NOT NULL THEN
  SELECT * INTO d FROM opc_drafts WHERE draft_id=binding.draft_id AND actor_id=p_actor_id;
  SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
  IF r.state='draft' THEN RETURN jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id);END IF;
  IF r.state<>'published' THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  PERFORM opc_revise(p_actor_id,d.draft_id,p_request_id,d.round_id);
  SELECT round_id INTO d.round_id FROM opc_drafts WHERE draft_id=d.draft_id;
  RETURN jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id);
 END IF;
 SELECT * INTO source_v FROM artifact_versions WHERE id=a.source_version_id;
 SELECT * INTO source_d FROM opc_drafts WHERE project_id=source_v.project_id AND actor_id=p_actor_id;
 IF source_d.draft_id IS NULL OR a.business_id IS NULL THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
 SELECT * INTO source_workflow FROM artifact_workflows WHERE id=source_d.registration;
 IF source_workflow.id IS NULL OR (SELECT count(*) FROM artifact_workflows
  WHERE module_id=source_workflow.module_id AND skill_id=source_workflow.skill_id
   AND enabled AND workflow->>'kind'=source_workflow.workflow->>'kind')<>1 THEN RAISE EXCEPTION 'OPC_REGISTRATION';END IF;
 SELECT * INTO current_workflow FROM artifact_workflows
  WHERE module_id=source_workflow.module_id AND skill_id=source_workflow.skill_id
   AND enabled AND workflow->>'kind'=source_workflow.workflow->>'kind';
 -- A new account revision uses the currently published Skill declaration.
 -- Earlier drafts keep their own pinned workflow and immutable source.
 started:=opc_start_b1(p_actor_id,p_request_id,current_workflow.id,'manual',a.business_id,NULL);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=(started->>'draftId')::uuid;
 INSERT INTO opc_account_strategy_drafts(account_project_id,draft_id,actor_id,root_source_version_id,base_source_version_id,base_account_revision)
 VALUES(a.project_id,d.draft_id,p_actor_id,a.source_version_id,a.source_version_id,a.revision);
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 profile:=opc_profile(a.source_version_id);
 -- Carry real source values into the new draft as unconfirmed information.
 -- Confirmation remains the existing step-by-step workflow.
 FOR step IN SELECT x.value FROM jsonb_array_elements(r.workflow->'steps') x LOOP
  values:='{}'::jsonb;
  FOR field IN SELECT x.value FROM jsonb_array_elements(step->'information') x LOOP
   old:=profile->(field->>'profileKey');value:=coalesce(old->>'value','');
   values:=values||jsonb_build_object(field->>'id',jsonb_build_object(
    'value',value,'status',CASE WHEN btrim(value)='' THEN 'unknown' ELSE 'provisional' END,
    'nature',CASE WHEN old->>'nature' IN ('fact','decision','hypothesis','unknown') THEN old->>'nature' ELSE 'unknown' END));
  END LOOP;
  PERFORM opc_information(p_actor_id,d.draft_id,step->>'id',gen_random_uuid(),0,values);
 END LOOP;
 RETURN jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id);
END $$;
REVOKE ALL ON FUNCTION opc_account_strategy_begin(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_account_strategy_begin(uuid,uuid,uuid) TO service_role;

-- The existing publish path still checks every required field and writes the
-- immutable artifact version. Only its destination is account-scoped here.
DO $$ BEGIN
 IF to_regprocedure('artifact_transition_before_account_strategy(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) RENAME TO artifact_transition_before_account_strategy;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION artifact_transition(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE binding opc_account_strategy_drafts;a opc_accounts;b opc_businesses;result jsonb;replay boolean;
BEGIN
 IF p_action<>'publish' THEN
  RETURN artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
 END IF;
 SELECT asd.* INTO binding FROM opc_account_strategy_drafts asd
  JOIN opc_drafts d ON d.draft_id=asd.draft_id
  WHERE d.project_id=p_project_id AND d.round_id=p_round_id AND asd.actor_id=p_actor_id;
 IF binding.draft_id IS NULL THEN
  RETURN artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
 END IF;
 SELECT EXISTS(SELECT 1 FROM artifact_requests WHERE project_id=p_project_id AND request_id=p_request_id) INTO replay;
 IF replay THEN RETURN artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);END IF;
 SELECT * INTO a FROM opc_accounts WHERE project_id=binding.account_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF a.project_id IS NULL OR a.source_version_id IS DISTINCT FROM binding.base_source_version_id OR
  a.revision IS DISTINCT FROM binding.base_account_revision THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 SELECT * INTO b FROM opc_businesses WHERE id=a.business_id AND actor_id=p_actor_id FOR UPDATE;
 IF b.id IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED';END IF;
 result:=artifact_transition_before_account_strategy(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
 IF result->>'versionId' IS NULL THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 -- The older common-business wrapper selected this version temporarily in
 -- this transaction. Restore its exact prior source and revision.
 UPDATE opc_businesses SET current_source_version_id=b.current_source_version_id,revision=b.revision WHERE id=b.id;
 UPDATE opc_accounts SET source_version_id=(result->>'versionId')::uuid,revision=revision+1 WHERE project_id=a.project_id;
 UPDATE opc_account_strategy_drafts SET base_source_version_id=(result->>'versionId')::uuid,base_account_revision=a.revision+1
  WHERE account_project_id=a.project_id;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION artifact_transition_before_account_strategy(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION opc_account_strategy_history(p_actor_id uuid,p_account_project_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a opc_accounts;binding opc_account_strategy_drafts;root artifact_versions;result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO a FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=p_actor_id;
 IF a.project_id IS NULL OR NOT opc_source_allowed(p_actor_id,a.source_version_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO binding FROM opc_account_strategy_drafts WHERE account_project_id=a.project_id;
 SELECT * INTO root FROM artifact_versions WHERE id=coalesce(binding.root_source_version_id,a.source_version_id);
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',history.id,'version',history.ordinal,'sourceVersion',history.version,
  'source',history.source,'profile',opc_profile(history.id),'createdAt',history.created_at)
  ORDER BY history.ordinal DESC),'[]'::jsonb) INTO result FROM (
  SELECT v.id,v.version,v.created_at,CASE WHEN v.project_id=root.project_id THEN 'shared' ELSE 'account' END source,
   row_number() OVER (ORDER BY v.created_at,v.id)::integer ordinal
  FROM artifact_versions v WHERE opc_source_allowed(p_actor_id,v.id) AND
   (v.project_id=root.project_id AND v.version<=root.version OR
    binding.draft_id IS NOT NULL AND v.project_id=(SELECT project_id FROM opc_drafts WHERE draft_id=binding.draft_id))
 ) history;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_account_strategy_history(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_account_strategy_history(uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION opc_account_strategy_save(
 p_actor_id uuid,p_account_project_id uuid,p_request_id uuid,p_expected_source_version_id uuid,
 p_expected_pending_draft_id uuid,p_edits jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a opc_accounts;binding opc_account_strategy_drafts;d opc_drafts;r artifact_rounds;
 saved opc_library_requests;payload jsonb;result jsonb;step_edit record;field_edit record;
 step jsonb;field jsonb;current_values jsonb;next_values jsonb;prior jsonb;new_value text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_expected_source_version_id IS NULL OR jsonb_typeof(p_edits)<>'object' OR
  p_edits='{}'::jsonb OR octet_length(p_edits::text)>20000 THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
 payload:=jsonb_build_object('target','account_strategy','accountProjectId',p_account_project_id,
  'expectedSourceVersionId',p_expected_source_version_id,'expectedPendingDraftId',p_expected_pending_draft_id,'edits',p_edits);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,125));
 SELECT * INTO saved FROM opc_library_requests WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN IF saved.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN saved.result;END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_account_project_id::text,125));
 SELECT * INTO a FROM opc_accounts WHERE project_id=p_account_project_id AND actor_id=p_actor_id FOR UPDATE;
 IF a.project_id IS NULL OR NOT opc_source_allowed(p_actor_id,a.source_version_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 IF a.source_version_id IS DISTINCT FROM p_expected_source_version_id THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 SELECT * INTO binding FROM opc_account_strategy_drafts WHERE account_project_id=a.project_id;
 IF binding.draft_id IS NOT NULL THEN
  SELECT * INTO d FROM opc_drafts WHERE draft_id=binding.draft_id;
  SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
  IF r.state='draft' AND d.draft_id IS DISTINCT FROM p_expected_pending_draft_id OR
     r.state<>'draft' AND p_expected_pending_draft_id IS NOT NULL THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 ELSIF p_expected_pending_draft_id IS NOT NULL THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 result:=opc_account_strategy_begin(p_actor_id,p_account_project_id,p_request_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=(result->>'draftId')::uuid;
 SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 FOR step_edit IN SELECT x.key,x.value FROM jsonb_each(p_edits) x LOOP
  SELECT x.value INTO step FROM jsonb_array_elements(r.workflow->'steps') x WHERE x.value->>'id'=step_edit.key;
  IF step IS NULL OR jsonb_typeof(step_edit.value)<>'object' OR step_edit.value='{}'::jsonb THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
  current_values:=r.steps->step_edit.key->'information';
  IF jsonb_typeof(current_values)<>'object' THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
  next_values:=current_values;
  FOR field_edit IN SELECT x.key,x.value FROM jsonb_each(step_edit.value) x LOOP
   SELECT x.value INTO field FROM jsonb_array_elements(step->'information') x WHERE x.value->>'id'=field_edit.key;
   IF field IS NULL OR jsonb_typeof(field_edit.value)<>'string' THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
   new_value:=field_edit.value #>> '{}';
   IF char_length(new_value)>400 THEN RAISE EXCEPTION 'OPC_INFORMATION_INVALID';END IF;
   prior:=next_values->field_edit.key;
   next_values:=jsonb_set(next_values,ARRAY[field_edit.key],jsonb_build_object(
    'value',new_value,'status',CASE WHEN btrim(new_value)='' THEN 'unknown' ELSE 'provisional' END,
    'nature',coalesce(prior->>'nature','unknown')));
  END LOOP;
  PERFORM opc_information(p_actor_id,d.draft_id,step_edit.key,gen_random_uuid(),(r.steps->step_edit.key->>'version')::integer,next_values);
  SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
 END LOOP;
 result:=jsonb_build_object('draftId',d.draft_id,'roundId',d.round_id,'status','draft');
 INSERT INTO opc_library_requests(actor_id,request_id,payload,result) VALUES(p_actor_id,p_request_id,payload,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_account_strategy_save(uuid,uuid,uuid,uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_account_strategy_save(uuid,uuid,uuid,uuid,uuid,jsonb) TO service_role;

-- Keep library account presentation tied to the account's own immutable
-- source, while a pending account revision opens its own draft for completion.
DO $$ BEGIN
 IF to_regprocedure('opc_library_before_account_strategy(uuid,text,date,date)') IS NULL THEN
  ALTER FUNCTION opc_library(uuid,text,date,date) RENAME TO opc_library_before_account_strategy;
 END IF;
END $$;
REVOKE ALL ON FUNCTION opc_library_before_account_strategy(uuid,text,date,date) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION opc_library(p_actor_id uuid,p_search text DEFAULT '',p_from date DEFAULT NULL,p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source jsonb;business jsonb;account jsonb;businesses jsonb:='[]';accounts jsonb;binding opc_account_strategy_drafts;d opc_drafts;r artifact_rounds;history jsonb;
BEGIN
 source:=opc_library_before_account_strategy(p_actor_id,p_search,p_from,p_to);
 FOR business IN SELECT x.value FROM jsonb_array_elements(source->'businesses') x LOOP
  accounts:='[]';
  FOR account IN SELECT x.value FROM jsonb_array_elements(business->'accounts') x LOOP
   SELECT * INTO binding FROM opc_account_strategy_drafts WHERE account_project_id=(account->>'projectId')::uuid AND actor_id=p_actor_id;
   history:=opc_account_strategy_history(p_actor_id,(account->>'projectId')::uuid);
   account:=account||jsonb_build_object('sourceVersion',jsonb_array_length(history),'pendingStrategyDraftId',NULL);
   IF binding.draft_id IS NOT NULL THEN
    SELECT * INTO d FROM opc_drafts WHERE draft_id=binding.draft_id;
    SELECT * INTO r FROM artifact_rounds WHERE id=d.round_id;
    account:=account||jsonb_build_object('strategyDraftId',d.draft_id,
     'pendingStrategyDraftId',CASE WHEN r.state='draft' THEN d.draft_id ELSE NULL END);
   END IF;
   accounts:=accounts||account;
  END LOOP;
  businesses:=businesses||jsonb_set(business,'{accounts}',accounts);
 END LOOP;
 RETURN jsonb_set(source,'{businesses}',businesses);
END $$;
REVOKE ALL ON FUNCTION opc_library(uuid,text,date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_library(uuid,text,date,date) TO service_role;

COMMIT;
