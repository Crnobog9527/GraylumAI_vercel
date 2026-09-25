-- Keep the sidebar work name and the library topic direction in one transaction.
BEGIN;
CREATE OR REPLACE FUNCTION opc_item_title_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' OR NEW.title IS DISTINCT FROM OLD.title THEN
  UPDATE opc_work_ui SET display_name=NEW.title,revision=revision+1
   WHERE work_item_id=NEW.work_item_id AND display_name IS DISTINCT FROM NEW.title;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opc_item_title_sync() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS opc_item_title_sync ON opc_item_edits;
CREATE TRIGGER opc_item_title_sync AFTER INSERT OR UPDATE OF title ON opc_item_edits
 FOR EACH ROW EXECUTE FUNCTION opc_item_title_sync();
CREATE OR REPLACE FUNCTION opc_work_ui_change(
 p_actor_id uuid,p_request_id uuid,p_work_item_id uuid,p_expected_revision bigint,p_action text,p_name text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved opc_library_requests;payload jsonb;state opc_work_ui;result jsonb;item opc_items;ed opc_item_edits;s runtime_sessions;n bigint;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_work_item_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 OR
    p_action NOT IN ('rename','pin','unpin','archive','restore','delete') OR
    (p_action='rename' AND char_length(trim(coalesce(p_name,''))) NOT BETWEEN 1 AND 160) OR
    (p_action<>'rename' AND p_name IS NOT NULL) THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,116));
 payload:=jsonb_build_object('target','work_ui','workItemId',p_work_item_id,'expectedRevision',p_expected_revision,'action',p_action,'name',p_name);
 SELECT * INTO saved FROM opc_library_requests WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN IF saved.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN saved.result;END IF;
 SELECT i.* INTO item FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
  WHERE i.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,i.source_version_id) FOR UPDATE OF i;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO state FROM opc_work_ui WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id FOR UPDATE;
 IF FOUND THEN
  IF state.revision<>p_expected_revision THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF state.deleted THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 ELSE
  IF p_expected_revision<>1 THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  INSERT INTO opc_work_ui(actor_id,work_item_id) VALUES(p_actor_id,p_work_item_id) RETURNING * INTO state;
 END IF;
 UPDATE opc_work_ui SET
  display_name=CASE WHEN p_action='rename' THEN trim(p_name) ELSE display_name END,
  pinned=CASE WHEN p_action='pin' THEN true WHEN p_action IN ('unpin','archive','delete') THEN false ELSE pinned END,
  archived=CASE WHEN p_action='archive' THEN true WHEN p_action='restore' THEN false ELSE archived END,
  deleted=CASE WHEN p_action='delete' THEN true ELSE deleted END,
  revision=revision+1
 WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id RETURNING * INTO state;
 IF p_action='rename' THEN
  SELECT * INTO ed FROM opc_item_edits WHERE work_item_id=p_work_item_id FOR UPDATE;
  IF FOUND THEN
   UPDATE opc_item_edits SET title=trim(p_name),revision=revision+1 WHERE work_item_id=p_work_item_id RETURNING * INTO ed;
  ELSE
   INSERT INTO opc_item_edits(work_item_id,revision,title,brief,day,content_type)
   VALUES(p_work_item_id,2,trim(p_name),item.brief,item.day,opc_item_content_type(p_work_item_id)) RETURNING * INTO ed;
  END IF;
  UPDATE artifact_projects SET work_title=trim(p_name) WHERE id=p_work_item_id AND actor_id=p_actor_id;
  SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',item.account_project_id,'workItemId',item.work_item_id);
  SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
  PERFORM runtime_material(p_actor_id,s.id,'save',p_request_id,n,jsonb_build_object('brief','内容类型：'||ed.content_type||E'\n标题：'||ed.title||E'\n简报：'||ed.brief,'material',coalesce(opc_profile(item.source_version_id)::text,''),'roundId',NULL));
 END IF;
 result:=jsonb_build_object('revision',state.revision,'displayName',state.display_name,'pinned',state.pinned,'archived',state.archived,'deleted',state.deleted);
 INSERT INTO opc_library_requests(actor_id,request_id,payload,result) VALUES(p_actor_id,p_request_id,payload,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_work_ui_change(uuid,uuid,uuid,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_work_ui_change(uuid,uuid,uuid,bigint,text,text) TO service_role;
COMMIT;
