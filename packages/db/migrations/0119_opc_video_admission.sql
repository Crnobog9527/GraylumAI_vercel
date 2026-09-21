/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Dispatch admission stays on the existing material binding. The extra fields
-- are the minimum data needed to reject overlapping derivative requests before
-- Runtime/BILL2 while preserving exact request replay.
BEGIN;

ALTER TABLE opc_video_material_bindings ADD COLUMN IF NOT EXISTS storyboard boolean;
ALTER TABLE opc_video_material_bindings ADD COLUMN IF NOT EXISTS editing boolean;
ALTER TABLE opc_video_material_bindings ADD COLUMN IF NOT EXISTS expected_storyboard_version bigint CHECK(expected_storyboard_version>=0);
ALTER TABLE opc_video_material_bindings ADD COLUMN IF NOT EXISTS expected_editing_version bigint CHECK(expected_editing_version>=0);

CREATE OR REPLACE FUNCTION opc_video_material_prepare(p_actor_id uuid,p_work_item_id uuid,p_request_id uuid,p_source_script_id uuid,p_storyboard boolean,p_editing boolean,p_expected_storyboard_version bigint,p_expected_editing_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;script opc_content_versions;binding opc_video_material_bindings;m runtime_scope_material;result jsonb;n bigint;material_request uuid:=gen_random_uuid();conflict record;package jsonb;want_story boolean;want_edit boolean;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 -- The all-false form is the terminal action for a material claim whose
 -- Runtime admission is now proven absent. It reuses the existing immutable
 -- request identity and material revocation; no second claim ledger exists.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,107));
 IF NOT coalesce(p_storyboard,false) AND NOT coalesce(p_editing,false) THEN
  SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF binding.request_id IS NULL OR binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id
   OR (binding.expected_storyboard_version IS NOT NULL AND binding.expected_storyboard_version<>p_expected_storyboard_version)
   OR (binding.expected_editing_version IS NOT NULL AND binding.expected_editing_version<>p_expected_editing_version)
   OR EXISTS(SELECT 1 FROM runtime_executions e WHERE e.actor_id=p_actor_id AND e.request_id=p_request_id)
   THEN RAISE EXCEPTION 'OPC_CONTENT_PENDING';END IF;
  result:=runtime_material(p_actor_id,binding.session_id,'revoke',NULL,binding.material_revision,NULL);
  RETURN result||jsonb_build_object('abandoned',true);
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_work_item_id::text,119));
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id);
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id) FOR UPDATE;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 IF i.work_item_id IS NULL OR s.id IS NULL OR script.id IS NULL OR NOT opc_content_allowed(p_actor_id,script.id) THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 SELECT * INTO binding FROM opc_video_material_bindings WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF binding.request_id IS NOT NULL THEN
  IF binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id OR binding.session_id<>s.id
   OR (binding.storyboard IS NOT NULL AND binding.storyboard IS DISTINCT FROM p_storyboard)
   OR (binding.editing IS NOT NULL AND binding.editing IS DISTINCT FROM p_editing)
   OR (binding.expected_storyboard_version IS NOT NULL AND binding.expected_storyboard_version<>p_expected_storyboard_version)
   OR (binding.expected_editing_version IS NOT NULL AND binding.expected_editing_version<>p_expected_editing_version)
   THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF m.session_id IS NULL OR m.revoked THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  RETURN jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash);
 END IF;
 IF EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=p_actor_id AND c.work_item_id=p_work_item_id AND c.source_content_id=script.id
  AND ((p_storyboard AND c.kind='storyboard') OR (p_editing AND c.kind='editing'))) THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
 IF p_storyboard THEN SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='storyboard';IF n<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;END IF;
 IF p_editing THEN SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='editing';IF n<>p_expected_editing_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;END IF;
 -- A completed and saved binding no longer occupies the global kind/version
 -- slot. Cancelled or structurally invalid terminal output may be retried only
 -- under a new explicit request. Every other overlap is still recoverable and
 -- therefore blocks a second paid dispatch.
 FOR conflict IN
  SELECT b.*,e.id execution_id,e.state execution_state,coalesce(e.result->>'body',e.primary_result->>'body') raw,material_row.revoked material_revoked
  FROM opc_video_material_bindings b
  LEFT JOIN runtime_executions e ON e.actor_id=b.actor_id AND e.request_id=b.request_id
  LEFT JOIN runtime_scope_material material_row ON material_row.session_id=b.session_id AND material_row.revision=b.material_revision
  WHERE b.actor_id=p_actor_id AND b.work_item_id=p_work_item_id AND b.request_id<>p_request_id
   AND ((p_storyboard AND coalesce(b.storyboard,true)) OR (p_editing AND coalesce(b.editing,true)))
   AND NOT (
    (NOT coalesce(b.storyboard,true) OR EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=b.actor_id AND c.request_id=b.request_id AND c.kind='storyboard' AND c.source_content_id=b.source_script_id))
    AND (NOT coalesce(b.editing,true) OR EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=b.actor_id AND c.request_id=b.request_id AND c.kind='editing' AND c.source_content_id=b.source_script_id))
   )
 LOOP
  IF coalesce(conflict.material_revoked,false) THEN CONTINUE;END IF;
  IF conflict.execution_id IS NULL OR conflict.execution_state NOT IN ('cancelled','completed') THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
  IF conflict.execution_state='cancelled' THEN CONTINUE;END IF;
  package:=NULL;
  BEGIN package:=conflict.raw::jsonb;EXCEPTION WHEN others THEN CONTINUE;END;
  -- 0118 rows predate explicit choice columns. Infer only a structurally valid
  -- completed package; an unknown/nonterminal legacy row remains conservative.
  IF conflict.storyboard IS NULL AND conflict.editing IS NULL THEN
   want_story:=jsonb_typeof(package)='object' AND package-ARRAY['storyboard']='{}'::jsonb
    AND jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000;
   want_edit:=jsonb_typeof(package)='object' AND package-ARRAY['editing']='{}'::jsonb
    AND jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000;
   IF jsonb_typeof(package)='object' AND package-ARRAY['storyboard','editing']='{}'::jsonb
    AND jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000
    AND jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000
   THEN want_story:=true;want_edit:=true;END IF;
   IF (p_storyboard AND want_story) OR (p_editing AND want_edit) THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
   CONTINUE;
  END IF;
  want_story:=coalesce(conflict.storyboard,true);want_edit:=coalesce(conflict.editing,true);
  IF jsonb_typeof(package)='object'
   AND ((want_story AND want_edit AND package-ARRAY['storyboard','editing']='{}'::jsonb)
    OR (want_story AND NOT want_edit AND package-ARRAY['storyboard']='{}'::jsonb)
    OR (want_edit AND NOT want_story AND package-ARRAY['editing']='{}'::jsonb))
   AND (NOT want_story OR (jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000))
   AND (NOT want_edit OR (jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000))
   THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
 END LOOP;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
 result:=runtime_material(p_actor_id,s.id,'save',material_request,n,jsonb_build_object('brief','已定稿口播稿：'||script.body,'material',coalesce(opc_profile(i.source_version_id)::text,''),'roundId',NULL));
 INSERT INTO opc_video_material_bindings(actor_id,request_id,work_item_id,source_script_id,session_id,material_revision,storyboard,editing,expected_storyboard_version,expected_editing_version)
  VALUES(p_actor_id,p_request_id,p_work_item_id,p_source_script_id,s.id,(result->>'revision')::bigint,p_storyboard,p_editing,p_expected_storyboard_version,p_expected_editing_version);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION opc_video_results_from_execution(p_actor_id uuid,p_work_item_id uuid,p_request_id uuid,p_execution_id uuid,p_source_script_id uuid,p_expected_storyboard_version bigint,p_expected_editing_version bigint,p_storyboard boolean,p_editing boolean) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;e runtime_executions;script opc_content_versions;binding opc_video_material_bindings;raw text;package jsonb;story opc_content_versions;editing_result opc_content_versions;n bigint;result jsonb:='{}';
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF NOT coalesce(p_storyboard,false) AND NOT coalesce(p_editing,false) THEN RAISE EXCEPTION 'OPC_CONTENT_CHOICE_INVALID';END IF;
 SELECT b.* INTO binding FROM opc_video_material_bindings b JOIN runtime_executions x ON x.actor_id=b.actor_id AND x.request_id=b.request_id
  WHERE b.actor_id=p_actor_id AND b.request_id=p_request_id AND x.id=p_execution_id;
 IF binding.request_id IS NULL OR binding.work_item_id<>p_work_item_id OR binding.source_script_id<>p_source_script_id
  OR (binding.storyboard IS NOT NULL AND binding.storyboard IS DISTINCT FROM p_storyboard)
  OR (binding.editing IS NOT NULL AND binding.editing IS DISTINCT FROM p_editing)
  OR (binding.expected_storyboard_version IS NOT NULL AND binding.expected_storyboard_version<>p_expected_storyboard_version)
  OR (binding.expected_editing_version IS NOT NULL AND binding.expected_editing_version<>p_expected_editing_version)
  THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
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

REVOKE ALL ON FUNCTION opc_video_material_prepare(uuid,uuid,uuid,uuid),opc_video_material_prepare(uuid,uuid,uuid,uuid,boolean,boolean,bigint,bigint),opc_video_results_from_execution(uuid,uuid,uuid,uuid,uuid,bigint,bigint,boolean,boolean) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_video_material_prepare(uuid,uuid,uuid,uuid,boolean,boolean,bigint,bigint),opc_video_results_from_execution(uuid,uuid,uuid,uuid,uuid,bigint,bigint,boolean,boolean) TO service_role;

COMMIT;
