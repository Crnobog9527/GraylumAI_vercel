-- Preserve admitted video-script ancestry across any number of manual revisions.
-- The visited path prevents a malformed cycle from looping forever.
BEGIN;
CREATE OR REPLACE FUNCTION opc_content_allowed(p_actor_id uuid,p_content_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_id uuid:=p_content_id;seen uuid[]:='{}';c opc_content_versions;i opc_items;p artifact_projects;
BEGIN
 LOOP
  IF current_id IS NULL THEN RETURN true;END IF;
  IF current_id=ANY(seen) THEN RETURN false;END IF;
  SELECT * INTO c FROM opc_content_versions WHERE id=current_id AND actor_id=p_actor_id;
  IF NOT FOUND THEN RETURN false;END IF;
  SELECT wi.* INTO i FROM opc_items wi WHERE wi.work_item_id=c.work_item_id;
  SELECT ap.* INTO p FROM artifact_projects ap WHERE ap.id=i.work_item_id AND ap.actor_id=p_actor_id;
  IF i.work_item_id IS NULL OR p.id IS NULL OR NOT opc_source_allowed(p_actor_id,i.source_version_id)
   OR (c.execution_id IS NOT NULL AND NOT runtime_history_available(c.execution_id)) THEN RETURN false;END IF;
  seen:=array_append(seen,current_id);current_id:=c.source_content_id;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION opc_content_manual_save(
 p_actor_id uuid,p_work_item_id uuid,p_request_id uuid,p_expected_version bigint,
 p_source_content_id uuid,p_kind text,p_status text,p_title text,p_body text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;c opc_content_versions;previous opc_content_versions;
 n bigint;material_revision bigint;clean_title text:=trim(coalesce(p_title,''));
 clean_body text:=trim(coalesce(p_body,''));
BEGIN
 PERFORM bill2_actor(p_actor_id);
 -- A manually revised script must descend from a saved script execution.
 IF p_kind IS NULL OR p_kind NOT IN ('brief','script') OR p_status IS NULL OR p_status NOT IN ('draft','final')
  OR char_length(clean_title) NOT BETWEEN 1 AND 160
  OR char_length(clean_body) NOT BETWEEN 1 AND 20000
  OR p_expected_version IS NULL OR p_expected_version<0 THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 -- Serialise the same request before reading its immutable result. The second
 -- lock serialises different edits on one work item without blocking other work.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,123));
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id
   AND opc_source_allowed(p_actor_id,wi.source_version_id) FOR UPDATE OF wi;
 IF i.work_item_id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 IF (p_kind='brief' AND opc_item_content_type(p_work_item_id) NOT IN ('article','image_text'))
  OR (p_kind='script' AND opc_item_content_type(p_work_item_id)<>'video')
  THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id
  AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 IF s.id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 SELECT * INTO c FROM opc_content_versions WHERE actor_id=p_actor_id
  AND request_id=p_request_id AND kind=p_kind;
 IF FOUND THEN
  IF c.work_item_id<>p_work_item_id OR c.version<>p_expected_version+1
   OR c.source_content_id IS DISTINCT FROM p_source_content_id
   OR c.status<>p_status OR c.title IS DISTINCT FROM clean_title
   OR c.body<>clean_body OR c.execution_id IS NOT NULL
   THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  IF NOT opc_content_allowed(p_actor_id,c.id) THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
 ELSE
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions
   WHERE work_item_id=p_work_item_id AND kind=p_kind;
  IF n<>p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF n>0 THEN
   SELECT * INTO previous FROM opc_content_versions WHERE work_item_id=p_work_item_id
    AND kind=p_kind AND version=n;
   IF previous.id IS DISTINCT FROM p_source_content_id OR
    NOT opc_content_allowed(p_actor_id,previous.id) THEN
    RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
  ELSIF p_source_content_id IS NOT NULL THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
  IF p_kind='script' THEN
   -- Manual video revisions are never a new root. Follow the immutable source
   -- chain to an admitted Runtime execution, including old revisions.
   IF p_source_content_id IS NULL OR NOT EXISTS(
    WITH RECURSIVE ancestry AS (
     SELECT id,source_content_id,execution_id,ARRAY[id] visited FROM opc_content_versions
      WHERE id=p_source_content_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script'
     UNION ALL
     SELECT parent.id,parent.source_content_id,parent.execution_id,ancestry.visited||parent.id
      FROM opc_content_versions parent JOIN ancestry ON parent.id=ancestry.source_content_id
      WHERE parent.actor_id=p_actor_id AND parent.work_item_id=p_work_item_id AND parent.kind='script' AND NOT parent.id=ANY(ancestry.visited)
    ) SELECT 1 FROM ancestry WHERE execution_id IS NOT NULL
   ) THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;
  END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,title,body,
   source_content_id,execution_id,request_id)
   VALUES(p_actor_id,p_work_item_id,p_kind,n+1,p_status,clean_title,clean_body,
    p_source_content_id,NULL,p_request_id) RETURNING * INTO c;
  IF p_status='final' THEN
   SELECT coalesce(max(revision),0) INTO material_revision FROM runtime_scope_material
    WHERE session_id=s.id;
   PERFORM runtime_material(p_actor_id,s.id,'save',c.id,material_revision,
    jsonb_build_object('brief',CASE WHEN p_kind='script' THEN '已定稿口播稿：'||clean_body
     ELSE '已保存内容：'||clean_body END,
     'material',coalesce(opc_profile(i.source_version_id)::text,''),'roundId',NULL));
  END IF;
 END IF;
 RETURN jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,
  'status',c.status,'title',c.title,'body',c.body);
END $$;
REVOKE ALL ON FUNCTION opc_content_manual_save(uuid,uuid,uuid,bigint,uuid,text,text,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_content_manual_save(uuid,uuid,uuid,bigint,uuid,text,text,text,text)
 TO service_role;

COMMIT;
