/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Reuse immutable Runtime material as exact storyboard provenance; no new table
-- or authority. Existing admitted/unknown bindings replay before new admission rules.
BEGIN;
CREATE OR REPLACE FUNCTION opc_video_material_prepare(p_actor_id uuid,p_work_item_id uuid,p_request_id uuid,p_source_script_id uuid,p_storyboard boolean,p_editing boolean,p_expected_storyboard_version bigint,p_expected_editing_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;script opc_content_versions;source_story opc_content_versions;binding opc_video_material_bindings;m runtime_scope_material;result jsonb;n bigint;material_request uuid:=gen_random_uuid();conflict record;package jsonb;want_story boolean;want_edit boolean;
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
   THEN RAISE EXCEPTION 'OPC_CONTENT_PENDING';END IF;
  -- Runtime admission uses the same request-then-session lock order. Once this
  -- lock is held, either an execution already froze this exact material and
  -- the claim stays recoverable, or a later admission observes the revocation.
  PERFORM 1 FROM runtime_sessions WHERE id=binding.session_id AND actor_id=p_actor_id FOR UPDATE;
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=binding.session_id AND revision=binding.material_revision;
  IF m.session_id IS NULL OR EXISTS(
   SELECT 1 FROM runtime_executions e WHERE e.actor_id=p_actor_id AND e.session_id=binding.session_id
    AND e.payload#>>'{scopeMaterial,sessionId}'=binding.session_id::text
    AND e.payload#>>'{scopeMaterial,revision}'=binding.material_revision::text
    AND e.payload#>>'{scopeMaterial,hash}'=m.content_hash
  ) THEN RAISE EXCEPTION 'OPC_CONTENT_PENDING';END IF;
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
 -- A new editing-only request must freeze the actual matching storyboard.
 -- The existing binding replay above intentionally retains old paid requests.
 IF p_editing AND NOT p_storyboard THEN
  SELECT * INTO source_story FROM opc_content_versions WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='storyboard' AND status='final' AND source_content_id=script.id ORDER BY version DESC LIMIT 1;
  IF source_story.id IS NULL OR NOT opc_content_allowed(p_actor_id,source_story.id) THEN RAISE EXCEPTION 'OPC_STORYBOARD_REQUIRED';END IF;
  IF source_story.version<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
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
 LOOP
  IF coalesce(conflict.material_revoked,false) THEN CONTINUE;END IF;
  package:=NULL;
  IF conflict.execution_state='completed' THEN BEGIN package:=conflict.raw::jsonb;EXCEPTION WHEN others THEN package:=NULL;END;END IF;
  -- 0118 rows predate explicit choice columns. Infer only a structurally valid
  -- completed package; an unknown/nonterminal legacy row remains conservative.
  want_story:=coalesce(conflict.storyboard,true);want_edit:=coalesce(conflict.editing,true);
  IF conflict.storyboard IS NULL AND conflict.editing IS NULL THEN
   want_story:=jsonb_typeof(package)='object' AND package-ARRAY['storyboard']='{}'::jsonb
    AND jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000;
   want_edit:=jsonb_typeof(package)='object' AND package-ARRAY['editing']='{}'::jsonb
    AND jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000;
   IF jsonb_typeof(package)='object' AND package-ARRAY['storyboard','editing']='{}'::jsonb
    AND jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000
    AND jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000
   THEN want_story:=true;want_edit:=true;END IF;
   IF NOT want_story AND NOT want_edit THEN want_story:=true;want_edit:=true;END IF;
  END IF;
  -- A recovered legacy single-kind request releases only the kind proven by
  -- its exact terminal package and saved artifact. It must not reserve both
  -- kinds forever or block the same kind for a newly finalized script.
  IF (NOT want_story OR EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=conflict.actor_id AND c.request_id=conflict.request_id AND c.kind='storyboard' AND c.source_content_id=conflict.source_script_id))
   AND (NOT want_edit OR EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.actor_id=conflict.actor_id AND c.request_id=conflict.request_id AND c.kind='editing' AND c.source_content_id=conflict.source_script_id))
  THEN CONTINUE;END IF;
  IF NOT ((p_storyboard AND want_story) OR (p_editing AND want_edit)) THEN CONTINUE;END IF;
  IF conflict.execution_id IS NULL OR conflict.execution_state NOT IN ('cancelled','completed') THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
  IF conflict.execution_state='cancelled' THEN CONTINUE;END IF;
  IF jsonb_typeof(package)='object'
   AND ((want_story AND want_edit AND package-ARRAY['storyboard','editing']='{}'::jsonb)
    OR (want_story AND NOT want_edit AND package-ARRAY['storyboard']='{}'::jsonb)
    OR (want_edit AND NOT want_story AND package-ARRAY['editing']='{}'::jsonb))
   AND (NOT want_story OR (jsonb_typeof(package->'storyboard')='string' AND char_length(package->>'storyboard') BETWEEN 1 AND 20000))
   AND (NOT want_edit OR (jsonb_typeof(package->'editing')='string' AND char_length(package->>'editing') BETWEEN 1 AND 20000))
   THEN RAISE EXCEPTION 'OPC_CONTENT_ALREADY_GENERATED';END IF;
 END LOOP;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
 result:=runtime_material(p_actor_id,s.id,'save',material_request,n,jsonb_build_object('brief','已定稿口播稿：'||script.body,'material',CASE WHEN source_story.id IS NULL THEN coalesce(opc_profile(i.source_version_id)::text,'') ELSE jsonb_build_object('positioning',opc_profile(i.source_version_id),'sourceStoryboardId',source_story.id,'storyboardVersion',source_story.version,'storyboard',source_story.body)::text END,'roundId',NULL));
 INSERT INTO opc_video_material_bindings(actor_id,request_id,work_item_id,source_script_id,session_id,material_revision,storyboard,editing,expected_storyboard_version,expected_editing_version)
  VALUES(p_actor_id,p_request_id,p_work_item_id,p_source_script_id,s.id,(result->>'revision')::bigint,p_storyboard,p_editing,p_expected_storyboard_version,p_expected_editing_version);
 RETURN result;
END $$;

CREATE OR REPLACE FUNCTION runtime_material_allowed(p_actor_id uuid,p_material jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE m runtime_scope_material;source_script uuid;source_story uuid;material_info jsonb;
BEGIN
 PERFORM runtime_material_allowed_before_b1(p_actor_id,p_material);
 IF p_material IS NULL OR p_material='null'::jsonb THEN RETURN;END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=(p_material->>'sessionId')::uuid AND revision=(p_material->>'revision')::bigint;
 SELECT id INTO source_script FROM opc_content_versions
  WHERE actor_id=p_actor_id AND request_id=m.request_id AND kind='script';
 IF source_script IS NULL THEN
  SELECT source_script_id INTO source_script FROM opc_video_material_bindings
   WHERE actor_id=p_actor_id AND session_id=m.session_id AND material_revision=m.revision;
 END IF;
 -- New editing material carries a machine-readable pointer in the existing
 -- frozen material string. Legacy material remains valid without that key.
 IF source_script IS NOT NULL THEN
  BEGIN material_info:=(m.content->>'material')::jsonb;EXCEPTION WHEN others THEN material_info:=NULL;END;
  IF material_info ? 'sourceStoryboardId' THEN
   source_story:=(material_info->>'sourceStoryboardId')::uuid;
   IF source_story IS NULL OR NOT opc_content_allowed(p_actor_id,source_story) THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
  END IF;
 END IF;
 IF source_script IS NOT NULL AND NOT opc_content_allowed(p_actor_id,source_script) THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
END $$;

COMMIT;
