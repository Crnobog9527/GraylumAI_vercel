/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Content type belongs to the existing plan row; edits use the existing revisioned
-- item projection. No second library, request ledger or executor is introduced.
BEGIN;
ALTER TABLE opc_item_edits ADD COLUMN IF NOT EXISTS content_type text CHECK(content_type IN ('article','image_text','video','unknown'));
CREATE OR REPLACE FUNCTION opc_item_content_type(p_work_item_id uuid) RETURNS text
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT coalesce(ed.content_type, row->>'contentType',CASE WHEN EXISTS(SELECT 1 FROM opc_content_versions c WHERE c.work_item_id=i.work_item_id AND c.kind='script') THEN 'video' ELSE 'unknown' END)
 FROM opc_items i JOIN opc_plans p ON p.id=i.plan_id
 CROSS JOIN LATERAL jsonb_array_elements(p.body) row
 LEFT JOIN opc_item_edits ed ON ed.work_item_id=i.work_item_id
 WHERE i.work_item_id=p_work_item_id AND row->>'id'=i.item_key::text
$$;
REVOKE ALL ON FUNCTION opc_item_content_type(uuid) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION opc_save_plan(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_expected_version bigint,p_source_version_id uuid,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;p opc_plans;n bigint;req jsonb;item jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 req:=jsonb_build_object('expectedVersion',p_expected_version,'sourceVersionId',p_source_version_id,'body',p_body);
 SELECT * INTO p FROM opc_plans WHERE draft_id=d.draft_id AND request_id=p_request_id;
 IF FOUND THEN
  IF p.request<>req THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 ELSE
  IF p_request_id IS NULL OR NOT opc_source_allowed(p_actor_id,p_source_version_id) OR NOT EXISTS(SELECT 1 FROM artifact_versions WHERE id=p_source_version_id AND project_id=d.project_id) THEN RAISE EXCEPTION 'OPC_SOURCE_DENIED';END IF;
  SELECT coalesce(max(version),0) INTO n FROM opc_plans WHERE draft_id=d.draft_id;
  IF n IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF jsonb_typeof(p_body) IS DISTINCT FROM 'array' OR jsonb_array_length(p_body) NOT BETWEEN 1 AND 28 OR octet_length(p_body::text)>64000 THEN RAISE EXCEPTION 'OPC_PLAN_INVALID';END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(p_body) LOOP
   IF (item ? 'contentType' AND coalesce(item->>'contentType','') NOT IN ('article','image_text','video','unknown')) OR item-ARRAY['id','platform','account','title','brief','day','contentType']<>'{}' OR (item->>'id')::uuid IS NULL
    OR coalesce(item->>'platform','')!~'^[a-z0-9_-]{1,32}$' OR coalesce(item->>'account','')!~'^[a-z0-9][a-z0-9._:-]{0,127}$'
    OR char_length(coalesce(item->>'title','')) NOT BETWEEN 1 AND 160 OR char_length(coalesce(item->>'brief','')) NOT BETWEEN 1 AND 2000
    OR (item->>'day')::date IS NULL THEN RAISE EXCEPTION 'OPC_PLAN_INVALID';END IF;
  END LOOP;
  IF jsonb_array_length(p_body)<>(SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_body) x) THEN RAISE EXCEPTION 'OPC_DUPLICATE_ITEM';END IF;
  INSERT INTO opc_plans(draft_id,version,source_version_id,request_id,request,body) VALUES(d.draft_id,n+1,p_source_version_id,p_request_id,req,p_body) RETURNING * INTO p;
 END IF;
 RETURN jsonb_build_object('planId',p.id,'version',p.version);
END $$;
CREATE OR REPLACE FUNCTION opc_topic_draft_save(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_expected_version bigint,p_source_version_id uuid,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;v opc_topic_draft_versions;n bigint;req jsonb;item jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 PERFORM 1 FROM artifact_projects WHERE id=d.project_id FOR UPDATE;
 req:=jsonb_build_object('expectedVersion',p_expected_version,'sourceVersionId',p_source_version_id,'body',p_body);
 SELECT * INTO v FROM opc_topic_draft_versions WHERE draft_id=p_draft_id AND request_id=p_request_id;
 IF FOUND THEN IF v.request<>req THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 ELSE
  SELECT coalesce(max(version),0) INTO n FROM opc_topic_draft_versions WHERE draft_id=p_draft_id;
  IF n IS DISTINCT FROM p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF NOT opc_source_allowed(p_actor_id,p_source_version_id) OR NOT EXISTS(SELECT 1 FROM artifact_versions WHERE id=p_source_version_id AND project_id=d.project_id)
   OR jsonb_typeof(p_body) IS DISTINCT FROM 'array' OR jsonb_array_length(p_body) NOT BETWEEN 1 AND 28 OR octet_length(p_body::text)>64000
  THEN RAISE EXCEPTION 'OPC_PLAN_INVALID';END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(p_body) LOOP
   IF (item ? 'contentType' AND coalesce(item->>'contentType','') NOT IN ('article','image_text','video','unknown')) OR item-ARRAY['id','platform','account','title','brief','day','contentType']<>'{}' OR coalesce(item->>'id','')!~*'^[0-9a-f-]{36}$'
    OR coalesce(item->>'platform','')!~'^[a-z0-9_-]{1,32}$' OR coalesce(item->>'account','')!~'^[a-z0-9][a-z0-9._:-]{0,127}$'
    OR char_length(coalesce(item->>'title','')) NOT BETWEEN 1 AND 160 OR char_length(coalesce(item->>'brief','')) NOT BETWEEN 1 AND 2000
    OR coalesce(item->>'day','')!~'^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'OPC_PLAN_INVALID';END IF;
  END LOOP;
  IF jsonb_array_length(p_body)<>(SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p_body) x) THEN RAISE EXCEPTION 'OPC_DUPLICATE_ITEM';END IF;
  INSERT INTO opc_topic_draft_versions(draft_id,actor_id,version,source_version_id,request_id,request,body)
   VALUES(p_draft_id,p_actor_id,n+1,p_source_version_id,p_request_id,req,p_body) RETURNING * INTO v;
 END IF;
 RETURN jsonb_build_object('draftVersionId',v.id,'version',v.version,'body',v.body);
END $$;
CREATE OR REPLACE FUNCTION opc_library(p_actor_id uuid,p_search text DEFAULT '',p_from date DEFAULT NULL,p_to date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q text:='%'||lower(trim(coalesce(p_search,'')))||'%';
BEGIN
 PERFORM bill2_actor(p_actor_id);
 RETURN jsonb_build_object('businesses',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'businessId',b.id,'name',b.name,'revision',b.revision,'sourceVersionId',b.current_source_version_id,
  'sourceAvailable',CASE WHEN b.current_source_version_id IS NULL THEN false ELSE opc_source_allowed(p_actor_id,b.current_source_version_id) END,
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('projectId',a.project_id,'platform',a.platform,'account',a.account_key,'stage',a.stage,'revision',a.revision,
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object('workItemId',i.work_item_id,'title',coalesce(ed.title,p.work_title),'brief',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) THEN coalesce(ed.brief,i.brief) ELSE NULL END,'day',coalesce(ed.day,i.day),'revision',coalesce(ed.revision,1),'contentType',opc_item_content_type(i.work_item_id),'sessionId',s.id,'sourceAvailable',opc_source_allowed(p_actor_id,i.source_version_id),
    'content',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'body',CASE WHEN opc_content_allowed(p_actor_id,c.id) THEN c.body ELSE NULL END,'contentAvailable',opc_content_allowed(p_actor_id,c.id),'sourceContentId',c.source_content_id,'executionId',c.execution_id,'requestId',c.request_id,'createdAt',c.created_at) ORDER BY c.created_at) FROM opc_content_versions c WHERE c.work_item_id=i.work_item_id),'[]'::jsonb)) ORDER BY i.day,p.work_title)
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
CREATE OR REPLACE FUNCTION opc_content_from_execution(p_actor_id uuid,p_work_item_id uuid,p_request_id uuid,p_expected_version bigint,p_kind text,p_status text,p_execution_id uuid,p_source_content_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;e runtime_executions;c opc_content_versions;n bigint;source opc_content_versions;body text;material_revision bigint;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id;
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id AND session_id=s.id;
 IF i.work_item_id IS NULL OR e.id IS NULL OR e.state<>'completed' OR NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 body:=coalesce(e.result->>'body',e.primary_result->>'body');
 IF p_kind NOT IN ('brief','script') OR p_status NOT IN ('draft','final') OR char_length(coalesce(body,'')) NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 SELECT * INTO c FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind=p_kind;
 IF FOUND THEN
  IF c.work_item_id<>p_work_item_id OR c.execution_id<>p_execution_id OR c.status<>p_status OR c.source_content_id IS DISTINCT FROM p_source_content_id OR c.version<>p_expected_version+1 THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 ELSE
  IF p_kind='script' AND opc_item_content_type(p_work_item_id)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind=p_kind;
  IF n<>p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF p_source_content_id IS NOT NULL THEN SELECT * INTO source FROM opc_content_versions WHERE id=p_source_content_id AND work_item_id=p_work_item_id;IF source.id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,execution_id,request_id)
   VALUES(p_actor_id,p_work_item_id,p_kind,n+1,p_status,body,p_source_content_id,p_execution_id,p_request_id) RETURNING * INTO c;
  IF p_status='final' THEN
   SELECT coalesce(max(revision),0) INTO material_revision FROM runtime_scope_material WHERE session_id=s.id;
   -- Content identity distinguishes brief/script saves of the same execution.
   -- The existing content request still replays before this insertion path.
   PERFORM runtime_material(p_actor_id,s.id,'save',c.id,material_revision,jsonb_build_object('brief',CASE WHEN p_kind='script' THEN '已定稿口播稿：'||body ELSE '已保存内容：'||body END,'material',coalesce(opc_profile(i.source_version_id)::text,''),'roundId',NULL));
  END IF;
 END IF;
 RETURN jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'body',c.body);
END $$;
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
 IF opc_item_content_type(p_work_item_id)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
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
CREATE OR REPLACE FUNCTION public.runtime_admit(p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_payload jsonb,p_billing jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;e runtime_executions;b jsonb;history_candidates bigint[];
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL THEN RAISE EXCEPTION 'RUNTIME_REQUEST_REQUIRED';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,107));
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO e FROM runtime_executions WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF e.id IS NOT NULL THEN
  IF e.session_id<>s.id OR e.payload IS DISTINCT FROM p_payload
   OR (SELECT payload FROM bill2_runs WHERE id=e.billing_run_id) IS DISTINCT FROM p_billing THEN RAISE EXCEPTION 'RUNTIME_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
 END IF;
 IF s.scope->>'kind'='work_item' AND (p_payload->>'input' LIKE '[OPC_SCRIPT_V1]%' OR p_payload->>'input' LIKE '[OPC_VIDEO_PACKAGE_V1]%') AND opc_item_content_type((s.scope->>'workItemId')::uuid)<>'video' THEN RAISE EXCEPTION 'OPC_VIDEO_TYPE_REQUIRED';END IF;
 IF s.active_execution IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_SESSION_BUSY';END IF;
 IF p_payload IS DISTINCT FROM p_billing->'input' THEN RAISE EXCEPTION 'RUNTIME_INPUT_BINDING_DENIED';END IF;
 IF p_payload->'scopeMaterial' IS NOT NULL AND p_payload->'scopeMaterial'->>'sessionId' IS DISTINCT FROM s.id::text THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_SCOPE';END IF;
 PERFORM runtime_context_allowed(p_actor_id,p_payload);
 IF p_billing->'scope' IS DISTINCT FROM s.scope OR p_billing->>'sessionRef' IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 -- Share the original admission lock before checking for an existing BILL2 run.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,105));
 -- Never adopt an old isolated run, even with a matching public request ID.
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE actor_id=p_actor_id AND request_id=p_request_id) THEN RAISE EXCEPTION 'RUNTIME_LEGACY_RUN_DENIED';END IF;
 -- Freeze history membership and permission locks before bill2_prepare takes
 -- the profile balance lock. Dispatch takes revision permissions before profile.
 history_candidates:=ARRAY(
  SELECT revision FROM (SELECT h.revision,h.execution_id FROM runtime_session_history h
   WHERE h.session_id=s.id AND h.revision<=s.revision AND NOT h.internal_control
   ORDER BY h.revision DESC LIMIT CASE WHEN coalesce((p_payload->>'historyItems')::int,0)>0 THEN least(1000,(p_payload->>'historyItems')::int)+128 ELSE 0 END) bounded
  WHERE runtime_history_available(execution_id) ORDER BY revision);
 -- Runtime requires the administrator model binding; legacy unbound BILL2
 -- callers keep their existing package authorization contract.
 IF p_billing->>'revisionId' IS NOT NULL THEN
  PERFORM id FROM modules WHERE id=(p_billing->>'moduleId')::uuid
   AND skill_id=(p_billing->>'skillId')::uuid AND active AND model_id=(p_billing->>'modelId')::uuid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
 END IF;
 b:=bill2_prepare(p_actor_id,p_request_id,p_billing);
 INSERT INTO runtime_executions(actor_id,session_id,request_id,payload,billing_run_id,history_revision)
 VALUES(p_actor_id,s.id,p_request_id,p_payload,(b->>'id')::uuid,s.revision) RETURNING * INTO e;
 UPDATE runtime_executions SET candidate_history=history_candidates WHERE id=e.id;
 UPDATE bill2_runs SET session_ref=s.id WHERE id=e.billing_run_id;
 UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
END $$;
CREATE OR REPLACE FUNCTION runtime_material_allowed(p_actor_id uuid,p_material jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE m runtime_scope_material;source_script uuid;source_story uuid;material_info jsonb;
BEGIN
 PERFORM runtime_material_allowed_before_b1(p_actor_id,p_material);
 IF p_material IS NULL OR p_material='null'::jsonb THEN RETURN;END IF;
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=(p_material->>'sessionId')::uuid AND revision=(p_material->>'revision')::bigint;
 SELECT id INTO source_script FROM opc_content_versions
  WHERE actor_id=p_actor_id AND kind IN ('script','brief')
   AND (id=m.request_id OR (request_id=m.request_id AND m.content->>'brief'=
    CASE WHEN kind='script' THEN '已定稿口播稿：'||body ELSE '已保存内容：'||body END))
  ORDER BY (id=m.request_id) DESC LIMIT 1;
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
