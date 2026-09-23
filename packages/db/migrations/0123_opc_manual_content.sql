/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- U2: immutable, actor-scoped manual drafts on the existing OPC work item.
BEGIN;

ALTER TABLE opc_content_versions ADD COLUMN IF NOT EXISTS title text
  CHECK (title IS NULL OR char_length(title) BETWEEN 1 AND 160);

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
 IF p_kind NOT IN ('brief','script') OR p_status NOT IN ('draft','final')
  OR char_length(clean_title) NOT BETWEEN 1 AND 160
  OR char_length(clean_body) NOT BETWEEN 1 AND 20000
  OR p_expected_version<0 THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 -- Serialise the same request before reading its immutable result. The second
 -- lock serialises different edits on one work item without blocking other work.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,123));
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id
   AND opc_source_allowed(p_actor_id,wi.source_version_id) FOR UPDATE OF wi;
 IF i.work_item_id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 IF (p_kind='script') IS DISTINCT FROM (opc_item_content_type(p_work_item_id)='video')
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

-- Preserve the existing library projection and edit rules while exposing each
-- saved title and serialising identical metadata requests.
CREATE OR REPLACE FUNCTION opc_library(p_actor_id uuid,p_search text DEFAULT '',p_from date DEFAULT NULL,p_to date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q text:='%'||lower(trim(coalesce(p_search,'')))||'%';
BEGIN
 PERFORM bill2_actor(p_actor_id);
 RETURN jsonb_build_object('businesses',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'businessId',b.id,'name',b.name,'revision',b.revision,'sourceVersionId',b.current_source_version_id,
  'sourceAvailable',CASE WHEN b.current_source_version_id IS NULL THEN false ELSE opc_source_allowed(p_actor_id,b.current_source_version_id) END,
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('projectId',a.project_id,'platform',a.platform,'account',a.account_key,'stage',a.stage,'revision',a.revision,
   'strategyDraftId',(SELECT d.draft_id FROM artifact_versions v JOIN opc_drafts d ON d.project_id=v.project_id AND d.actor_id=p_actor_id
    WHERE v.id=a.source_version_id AND opc_source_allowed(p_actor_id,v.id)
     AND NOT EXISTS(SELECT 1 FROM bill2_drafts retired WHERE retired.id=d.draft_id AND retired.revoked)
    LIMIT 1),
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object('workItemId',i.work_item_id,'title',coalesce(ed.title,p.work_title),'brief',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) THEN coalesce(ed.brief,i.brief) ELSE NULL END,'day',coalesce(ed.day,i.day),'revision',coalesce(ed.revision,1),'contentType',opc_item_content_type(i.work_item_id),'sessionId',s.id,'sourceAvailable',opc_source_allowed(p_actor_id,i.source_version_id),
    'lastActivityAt',coalesce((SELECT max(c.created_at) FROM opc_content_versions c WHERE c.work_item_id=i.work_item_id),p.created_at),
    'content',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'title',c.title,'body',CASE WHEN opc_content_allowed(p_actor_id,c.id) THEN c.body ELSE NULL END,'contentAvailable',opc_content_allowed(p_actor_id,c.id),'sourceContentId',c.source_content_id,'executionId',c.execution_id,'requestId',c.request_id,'createdAt',c.created_at) ORDER BY c.created_at) FROM opc_content_versions c WHERE c.work_item_id=i.work_item_id),'[]'::jsonb)) ORDER BY i.day,p.work_title)
    FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id LEFT JOIN opc_item_edits ed ON ed.work_item_id=i.work_item_id JOIN runtime_sessions s ON s.actor_id=p_actor_id AND s.scope=jsonb_build_object('kind','work_item','projectId',a.project_id,'workItemId',i.work_item_id)
    WHERE i.account_project_id=a.project_id AND (p_from IS NULL OR coalesce(ed.day,i.day)>=p_from) AND (p_to IS NULL OR coalesce(ed.day,i.day)<=p_to)
     AND (q='%%' OR lower(coalesce(ed.title,p.work_title)) LIKE q OR (opc_source_allowed(p_actor_id,i.source_version_id) AND lower(coalesce(ed.brief,i.brief)) LIKE q))),'[]'::jsonb)) ORDER BY a.platform,a.account_key)
   FROM opc_accounts a WHERE a.actor_id=p_actor_id AND a.business_id=b.id),'[]'::jsonb)) ORDER BY b.created_at)
  FROM opc_businesses b WHERE b.actor_id=p_actor_id),'[]'::jsonb));
END $$;
CREATE OR REPLACE FUNCTION opc_library_edit(p_actor_id uuid,p_request_id uuid,p_target text,p_target_id uuid,p_expected_revision bigint,p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved opc_library_requests;payload jsonb;result jsonb;i opc_items;ed opc_item_edits;a opc_accounts;b opc_businesses;s runtime_sessions;n bigint;title text;current_revision bigint;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,116));
 payload:=jsonb_build_object('target',p_target,'targetId',p_target_id,'expectedRevision',p_expected_revision,'patch',p_patch);
 SELECT * INTO saved FROM opc_library_requests WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN IF saved.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN saved.result;END IF;
 IF p_target='business' THEN
  IF p_patch-ARRAY['name']<>'{}' OR char_length(trim(coalesce(p_patch->>'name',''))) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
  UPDATE opc_businesses SET name=trim(p_patch->>'name'),revision=revision+1 WHERE id=p_target_id AND actor_id=p_actor_id AND revision=p_expected_revision RETURNING * INTO b;
  IF b.id IS NULL THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;result:=jsonb_build_object('revision',b.revision);
 ELSIF p_target='account' THEN
  IF p_patch-ARRAY['stage']<>'{}' OR coalesce(p_patch->>'stage','') NOT IN ('unknown','starting','growing','mature') THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
  UPDATE opc_accounts SET stage=p_patch->>'stage',revision=revision+1 WHERE project_id=p_target_id AND actor_id=p_actor_id AND revision=p_expected_revision RETURNING * INTO a;
  IF a.project_id IS NULL THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;result:=jsonb_build_object('revision',a.revision);
 ELSIF p_target='item' THEN
  IF (p_patch ? 'contentType' AND coalesce(p_patch->>'contentType','') NOT IN ('article','image_text','video','unknown')) OR p_patch-ARRAY['title','brief','day','contentType']<>'{}' OR char_length(trim(coalesce(p_patch->>'title',''))) NOT BETWEEN 1 AND 160
   OR char_length(trim(coalesce(p_patch->>'brief',''))) NOT BETWEEN 1 AND 2000 OR coalesce(p_patch->>'day','')!~'^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
  SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id WHERE wi.work_item_id=p_target_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id) FOR UPDATE OF wi;
  IF i.work_item_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
  SELECT * INTO ed FROM opc_item_edits WHERE work_item_id=i.work_item_id FOR UPDATE;
  current_revision:=coalesce(ed.revision,1);
  IF current_revision<>p_expected_revision THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  title:=trim(p_patch->>'title');
  INSERT INTO opc_item_edits(work_item_id,revision,title,brief,day,content_type) VALUES(i.work_item_id,current_revision+1,title,trim(p_patch->>'brief'),(p_patch->>'day')::date,coalesce(p_patch->>'contentType',opc_item_content_type(i.work_item_id)))
   ON CONFLICT(work_item_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,brief=excluded.brief,day=excluded.day,content_type=excluded.content_type RETURNING * INTO ed;
  UPDATE artifact_projects SET work_title=title WHERE id=i.work_item_id;
  SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
  SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
  PERFORM runtime_material(p_actor_id,s.id,'save',p_request_id,n,jsonb_build_object('brief','内容类型：'||ed.content_type||E'\n标题：'||title||E'\n简报：'||ed.brief,'material',coalesce(opc_profile(i.source_version_id)::text,''),'roundId',NULL));
  result:=jsonb_build_object('revision',ed.revision);
 ELSE RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
 INSERT INTO opc_library_requests(actor_id,request_id,payload,result) VALUES(p_actor_id,p_request_id,payload,result);RETURN result;
END $$;

COMMIT;
