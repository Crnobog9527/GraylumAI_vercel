-- Accept immutable manual script revisions through their admitted ancestry.
-- Function-only replacement: no rows/schema changes; existing callers are unchanged.
BEGIN;
CREATE OR REPLACE FUNCTION opc_video_execution_check(p_actor_id uuid,p_work_item_id uuid,p_execution_id uuid,p_source_script_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;e runtime_executions;script opc_content_versions;m runtime_scope_material;
 ancestor opc_content_versions;current_id uuid;seen uuid[]:='{}';admitted boolean:=false;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id);
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id AND session_id=s.id;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=s.id AND revision=(e.payload#>>'{scopeMaterial,revision}')::bigint AND NOT revoked;
 IF i.work_item_id IS NULL OR e.id IS NULL OR script.id IS NULL OR NOT opc_content_allowed(p_actor_id,script.id)
  OR m.session_id IS NULL OR e.payload#>>'{scopeMaterial,sessionId}' IS DISTINCT FROM s.id::text
  OR e.payload#>>'{scopeMaterial,revision}' IS DISTINCT FROM m.revision::text
  OR e.payload#>>'{scopeMaterial,hash}' IS DISTINCT FROM m.content_hash
  OR m.content->>'brief' IS DISTINCT FROM '已定稿口播稿：'||script.body
  OR NOT (m.request_id=script.request_id OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=p_actor_id AND b.session_id=m.session_id AND b.material_revision=m.revision AND b.source_script_id=script.id))
  THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 -- Manual revisions deliberately have no execution_id. Validate every source
 -- edge in this work item's script chain, then require an available admitted
 -- execution. Do not accept a valid prefix of a broken or cyclic chain.
 current_id:=script.id;
 WHILE current_id IS NOT NULL LOOP
  IF current_id=ANY(seen) THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  SELECT * INTO ancestor FROM opc_content_versions WHERE id=current_id
   AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script';
  IF NOT FOUND THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
  IF ancestor.execution_id IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM runtime_executions original WHERE id=ancestor.execution_id
     AND actor_id=p_actor_id AND session_id=s.id AND state='completed')
    OR NOT runtime_history_available(ancestor.execution_id)
    THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
   admitted:=true;
  END IF;
  seen:=array_append(seen,current_id);current_id:=ancestor.source_content_id;
 END LOOP;
 IF NOT admitted THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 RETURN jsonb_build_object('valid',true,'materialRevision',m.revision);
END $$;

REVOKE ALL ON FUNCTION opc_video_execution_check(uuid,uuid,uuid,uuid)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_video_execution_check(uuid,uuid,uuid,uuid) TO service_role;
COMMIT;
