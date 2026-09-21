/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Final B1 acceptance invariants: a formal positioning needs confirmed required
-- information, and one topic identity may only be adopted once per draft.
BEGIN;

DO $$ BEGIN
 IF to_regprocedure('artifact_transition_before_b1_acceptance(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) RENAME TO artifact_transition_before_b1_acceptance;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION artifact_transition(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r artifact_rounds;step jsonb;f jsonb;
BEGIN
 -- Deferral preserves draft progress, but it is not a confirmed fact and may
 -- never make an OPC positioning formal. The lower transition still owns all
 -- version, review and idempotency checks.
 IF p_action='publish' AND EXISTS(SELECT 1 FROM opc_drafts WHERE project_id=p_project_id) THEN
  SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=p_project_id;
  FOR step IN SELECT * FROM jsonb_array_elements(r.workflow->'steps') LOOP
   FOR f IN SELECT * FROM jsonb_array_elements(step->'information') WHERE (value->>'required')::boolean LOOP
    IF coalesce(r.steps->(step->>'id')->'information'->(f->>'id')->>'status','unknown') <> 'confirmed' THEN
     RAISE EXCEPTION 'OPC_INFORMATION_REQUIRED';
    END IF;
   END LOOP;
  END LOOP;
 END IF;
 RETURN artifact_transition_before_b1_acceptance(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
END $$;

-- Saving and handing off remain one transaction. The actor advisory lock makes
-- the cross-plan topic check race-safe for two tabs. A new request containing
-- an item already adopted from this draft is a definite rejection; replay of
-- the original request remains idempotent through opc_save_plan/opc_handoff.
CREATE OR REPLACE FUNCTION opc_adopt_topics(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_expected_version bigint,p_source_version_id uuid,p_body jsonb,p_accounts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;business uuid;plan jsonb;result jsonb;target jsonb;ac opc_accounts;replay boolean;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text,107));
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT EXISTS(SELECT 1 FROM opc_plans WHERE draft_id=p_draft_id AND request_id=p_request_id) INTO replay;
 SELECT business_id INTO business FROM opc_draft_businesses WHERE draft_id=d.draft_id;
 IF business IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED';END IF;
 IF NOT replay AND EXISTS(
  SELECT 1 FROM jsonb_array_elements(p_body) proposed(value)
  JOIN opc_items adopted ON adopted.item_key=(proposed.value->>'id')::uuid
  JOIN opc_plans prior ON prior.id=adopted.plan_id
  WHERE prior.draft_id=p_draft_id
 ) THEN RAISE EXCEPTION 'OPC_TOPIC_ALREADY_ADOPTED';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(p_accounts) LOOP
  SELECT * INTO ac FROM opc_accounts WHERE actor_id=p_actor_id AND platform=target->>'platform' AND account_key=target->>'account';
  IF ac.project_id IS NOT NULL AND ac.business_id IS NOT NULL AND ac.business_id IS DISTINCT FROM business THEN RAISE EXCEPTION 'OPC_BUSINESS_CONFLICT';END IF;
 END LOOP;
 plan:=opc_save_plan(p_actor_id,p_draft_id,p_request_id,p_expected_version,p_source_version_id,p_body);
 result:=opc_handoff_b1(p_actor_id,p_draft_id,p_request_id,(plan->>'planId')::uuid,p_accounts);
 -- Publishing alone selects the business's current formal positioning. Using
 -- a historical draft later must not roll that source backwards.
 RETURN jsonb_build_object('planId',plan->>'planId','version',(plan->>'version')::bigint,'items',result);
END $$;

-- One explicit post-script choice creates only the requested derivative(s).
-- A result is permanently bound to the selected final script version. Replays
-- return the same versions; a different request cannot duplicate an already
-- generated derivative for that script.
CREATE OR REPLACE FUNCTION opc_video_results_from_execution(p_actor_id uuid,p_work_item_id uuid,p_request_id uuid,p_execution_id uuid,p_source_script_id uuid,p_expected_storyboard_version bigint,p_expected_editing_version bigint,p_storyboard boolean,p_editing boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;e runtime_executions;script opc_content_versions;raw text;package jsonb;story opc_content_versions;editing_result opc_content_versions;n bigint;result jsonb:='{}';
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF NOT coalesce(p_storyboard,false) AND NOT coalesce(p_editing,false) THEN RAISE EXCEPTION 'OPC_CONTENT_CHOICE_INVALID';END IF;
 PERFORM opc_video_execution_check(p_actor_id,p_work_item_id,p_execution_id,p_source_script_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id;
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id AND session_id=s.id;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 IF i.work_item_id IS NULL OR e.id IS NULL OR e.state<>'completed' OR script.id IS NULL OR NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 SELECT * INTO story FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind='storyboard';
 SELECT * INTO editing_result FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind='editing';
 IF story.id IS NOT NULL OR editing_result.id IS NOT NULL THEN
  IF (p_storyboard IS DISTINCT FROM (story.id IS NOT NULL)) OR (p_editing IS DISTINCT FROM (editing_result.id IS NOT NULL))
   OR (story.id IS NOT NULL AND (story.execution_id<>p_execution_id OR story.source_content_id<>script.id))
   OR (editing_result.id IS NOT NULL AND (editing_result.execution_id<>p_execution_id OR editing_result.source_content_id<>script.id)) THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  IF story.id IS NOT NULL THEN result:=result||jsonb_build_object('storyboard',jsonb_build_object('id',story.id,'version',story.version));END IF;
  IF editing_result.id IS NOT NULL THEN result:=result||jsonb_build_object('editing',jsonb_build_object('id',editing_result.id,'version',editing_result.version));END IF;
  RETURN result;
 END IF;
 IF EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=p_actor_id AND c.work_item_id=p_work_item_id AND c.source_content_id=script.id AND ((p_storyboard AND c.kind='storyboard') OR (p_editing AND c.kind='editing'))) THEN
  RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';
 END IF;
 raw:=coalesce(e.result->>'body',e.primary_result->>'body');
 BEGIN package:=raw::jsonb;EXCEPTION WHEN others THEN RAISE EXCEPTION 'OPC_CONTENT_RESPONSE_INVALID';END;
 IF jsonb_typeof(package) IS DISTINCT FROM 'object'
  OR (p_storyboard AND p_editing AND package-ARRAY['storyboard','editing'] IS DISTINCT FROM '{}'::jsonb)
  OR (p_storyboard AND NOT p_editing AND package-ARRAY['storyboard'] IS DISTINCT FROM '{}'::jsonb)
  OR (p_editing AND NOT p_storyboard AND package-ARRAY['editing'] IS DISTINCT FROM '{}'::jsonb)
  OR (p_storyboard AND (jsonb_typeof(package->'storyboard') IS DISTINCT FROM 'string' OR coalesce(char_length(package->>'storyboard'),0) NOT BETWEEN 1 AND 20000))
  OR (p_editing AND (jsonb_typeof(package->'editing') IS DISTINCT FROM 'string' OR coalesce(char_length(package->>'editing'),0) NOT BETWEEN 1 AND 20000))
  THEN RAISE EXCEPTION 'OPC_CONTENT_RESPONSE_INVALID';END IF;
 IF p_storyboard THEN
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='storyboard';IF n<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,execution_id,request_id) VALUES(p_actor_id,p_work_item_id,'storyboard',n+1,'final',package->>'storyboard',script.id,e.id,p_request_id) RETURNING * INTO story;
  result:=result||jsonb_build_object('storyboard',jsonb_build_object('id',story.id,'version',story.version));
 END IF;
 IF p_editing THEN
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='editing';IF n<>p_expected_editing_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,execution_id,request_id) VALUES(p_actor_id,p_work_item_id,'editing',n+1,'final',package->>'editing',script.id,e.id,p_request_id) RETURNING * INTO editing_result;
  result:=result||jsonb_build_object('editing',jsonb_build_object('id',editing_result.id,'version',editing_result.version));
 END IF;
 RETURN result;
END $$;

REVOKE ALL ON FUNCTION artifact_transition_before_b1_acceptance(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),opc_adopt_topics(uuid,uuid,uuid,bigint,uuid,jsonb,jsonb),opc_video_results_from_execution(uuid,uuid,uuid,uuid,uuid,bigint,bigint,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),opc_adopt_topics(uuid,uuid,uuid,bigint,uuid,jsonb,jsonb),opc_video_results_from_execution(uuid,uuid,uuid,uuid,uuid,bigint,bigint,boolean,boolean) TO service_role;

COMMIT;
