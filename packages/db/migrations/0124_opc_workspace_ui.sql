/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Account-owned workspace presentation state. Work, source, versions and sessions
-- remain in their existing tables; deleting a sidebar entry only hides it.
BEGIN;

CREATE TABLE IF NOT EXISTS opc_work_ui (
 actor_id uuid NOT NULL REFERENCES profiles(id),
 work_item_id uuid NOT NULL REFERENCES opc_items(work_item_id),
 display_name text,
 pinned boolean NOT NULL DEFAULT false,
 archived boolean NOT NULL DEFAULT false,
 deleted boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(actor_id,work_item_id),
 CHECK(display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 160)
);
ALTER TABLE opc_work_ui ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_work_ui FROM PUBLIC,anon,authenticated,service_role;

-- A visible account label does not change the immutable platform/account key.
CREATE TABLE IF NOT EXISTS opc_account_ui (
 actor_id uuid NOT NULL REFERENCES profiles(id),
 account_project_id uuid NOT NULL REFERENCES opc_accounts(project_id),
 display_name text NOT NULL CHECK(char_length(display_name) BETWEEN 1 AND 120),
 revision bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(actor_id,account_project_id)
);
ALTER TABLE opc_account_ui ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_account_ui FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION opc_account_ui_change(
 p_actor_id uuid,p_request_id uuid,p_account_project_id uuid,p_expected_revision bigint,p_name text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved opc_library_requests;payload jsonb;state opc_account_ui;result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_account_project_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 OR
  char_length(trim(coalesce(p_name,''))) NOT BETWEEN 1 AND 120 THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,116));
 payload:=jsonb_build_object('target','account_ui','accountProjectId',p_account_project_id,'expectedRevision',p_expected_revision,'name',trim(p_name));
 SELECT * INTO saved FROM opc_library_requests WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN IF saved.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN saved.result;END IF;
 PERFORM 1 FROM opc_accounts a WHERE a.project_id=p_account_project_id AND a.actor_id=p_actor_id
  AND opc_source_allowed(p_actor_id,a.source_version_id) FOR UPDATE OF a;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT * INTO state FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=p_account_project_id FOR UPDATE;
 IF FOUND THEN
  IF state.revision<>p_expected_revision THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  UPDATE opc_account_ui SET display_name=trim(p_name),revision=revision+1
   WHERE actor_id=p_actor_id AND account_project_id=p_account_project_id RETURNING * INTO state;
 ELSE
  IF p_expected_revision<>1 THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  INSERT INTO opc_account_ui(actor_id,account_project_id,display_name,revision)
   VALUES(p_actor_id,p_account_project_id,trim(p_name),2) RETURNING * INTO state;
 END IF;
 result:=jsonb_build_object('revision',state.revision,'displayName',state.display_name);
 INSERT INTO opc_library_requests(actor_id,request_id,payload,result) VALUES(p_actor_id,p_request_id,payload,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_account_ui_change(uuid,uuid,uuid,bigint,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_account_ui_change(uuid,uuid,uuid,bigint,text) TO service_role;

CREATE TABLE IF NOT EXISTS opc_publication_ui (
 actor_id uuid NOT NULL REFERENCES profiles(id),
 work_item_id uuid NOT NULL REFERENCES opc_items(work_item_id),
 planned_date date,
 published_date date,
 published_version integer,
 status text NOT NULL DEFAULT 'unpublished' CHECK(status IN ('unpublished','published')),
 revision bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(actor_id,work_item_id),
 CHECK(status<>'published' OR (published_date IS NOT NULL AND published_version IS NOT NULL))
);
ALTER TABLE opc_publication_ui ADD COLUMN IF NOT EXISTS published_version integer;
ALTER TABLE opc_publication_ui ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_publication_ui FROM PUBLIC,anon,authenticated,service_role;

-- A saved article/script has an immutable version stream. Switching the item's
-- content type after that point would hide those versions from the library.
CREATE OR REPLACE FUNCTION opc_guard_saved_content_type() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous_type text;
BEGIN
 -- Read the effective old type, including legacy rows whose edit column is
 -- null but whose adopted plan already declared a type.
 previous_type:=opc_item_content_type(NEW.work_item_id);
 IF NEW.content_type IS DISTINCT FROM previous_type AND
  (EXISTS(SELECT 1 FROM opc_content_versions WHERE work_item_id=NEW.work_item_id) OR
   EXISTS(SELECT 1 FROM opc_publication_ui WHERE work_item_id=NEW.work_item_id AND status='published'))
 THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opc_guard_saved_content_type() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS opc_guard_saved_content_type ON opc_item_edits;
CREATE TRIGGER opc_guard_saved_content_type BEFORE INSERT OR UPDATE OF content_type ON opc_item_edits
 FOR EACH ROW EXECUTE FUNCTION opc_guard_saved_content_type();

-- A content version must remain visible under the item's effective type. Lock
-- the item before checking so a concurrent type edit cannot commit between
-- this check and the version insert.
CREATE OR REPLACE FUNCTION opc_guard_content_kind() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item opc_items; effective_type text;
BEGIN
 SELECT * INTO item FROM opc_items WHERE work_item_id=NEW.work_item_id FOR UPDATE;
 IF item.work_item_id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 effective_type:=opc_item_content_type(NEW.work_item_id);
 IF (NEW.kind='brief' AND effective_type NOT IN ('article','image_text')) OR
    (NEW.kind IN ('script','storyboard','editing') AND effective_type<>'video')
 THEN RAISE EXCEPTION 'OPC_CONTENT_INVALID';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION opc_guard_content_kind() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS opc_guard_content_kind ON opc_content_versions;
CREATE TRIGGER opc_guard_content_kind BEFORE INSERT OR UPDATE OF kind,work_item_id ON opc_content_versions
 FOR EACH ROW EXECUTE FUNCTION opc_guard_content_kind();

CREATE OR REPLACE FUNCTION opc_publication_ui_change(
 p_actor_id uuid,p_request_id uuid,p_work_item_id uuid,p_expected_revision bigint,
 p_planned_date date,p_status text,p_published_date date
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved opc_library_requests;payload jsonb;state opc_publication_ui;result jsonb;final_version integer;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR p_work_item_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision<1 OR
   p_status NOT IN ('unpublished','published') OR (p_status='published' AND p_published_date IS NULL) OR
   (p_status='unpublished' AND p_published_date IS NOT NULL) THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,116));
 payload:=jsonb_build_object('target','publication_ui','workItemId',p_work_item_id,'expectedRevision',p_expected_revision,'plannedDate',p_planned_date,'status',p_status,'publishedDate',p_published_date);
 SELECT * INTO saved FROM opc_library_requests WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF FOUND THEN IF saved.payload<>payload THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;RETURN saved.result;END IF;
 PERFORM 1 FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
  WHERE i.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,i.source_version_id) FOR UPDATE OF i;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 IF p_status='published' THEN
  IF p_published_date>CURRENT_DATE THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
  SELECT max(version) INTO final_version FROM opc_content_versions
   WHERE work_item_id=p_work_item_id AND status='final'
    AND kind=CASE WHEN opc_item_content_type(p_work_item_id)='video' THEN 'script' ELSE 'brief' END;
  IF final_version IS NULL THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
 END IF;
 SELECT * INTO state FROM opc_publication_ui WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id FOR UPDATE;
 IF FOUND THEN
  IF state.revision<>p_expected_revision THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 ELSE
  IF p_expected_revision<>1 THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  INSERT INTO opc_publication_ui(actor_id,work_item_id) VALUES(p_actor_id,p_work_item_id) RETURNING * INTO state;
 END IF;
 UPDATE opc_publication_ui SET planned_date=p_planned_date,status=p_status,published_date=p_published_date,
  published_version=CASE WHEN p_status='published' THEN
   CASE WHEN state.status='published' THEN state.published_version ELSE final_version END ELSE NULL END,
  revision=revision+1
 WHERE actor_id=p_actor_id AND work_item_id=p_work_item_id RETURNING * INTO state;
 result:=jsonb_build_object('revision',state.revision,'plannedDate',state.planned_date,'status',state.status,'publishedDate',state.published_date,'publishedVersion',state.published_version);
 INSERT INTO opc_library_requests(actor_id,request_id,payload,result) VALUES(p_actor_id,p_request_id,payload,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_publication_ui_change(uuid,uuid,uuid,bigint,date,text,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_publication_ui_change(uuid,uuid,uuid,bigint,date,text,date) TO service_role;

CREATE OR REPLACE FUNCTION opc_work_ui_change(
 p_actor_id uuid,p_request_id uuid,p_work_item_id uuid,p_expected_revision bigint,p_action text,p_name text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved opc_library_requests;payload jsonb;state opc_work_ui;result jsonb;
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
 PERFORM 1 FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
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
 result:=jsonb_build_object('revision',state.revision,'displayName',state.display_name,'pinned',state.pinned,'archived',state.archived,'deleted',state.deleted);
 INSERT INTO opc_library_requests(actor_id,request_id,payload,result) VALUES(p_actor_id,p_request_id,payload,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_work_ui_change(uuid,uuid,uuid,bigint,text,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_work_ui_change(uuid,uuid,uuid,bigint,text,text) TO service_role;

-- Add presentation fields to the established library projection. Library rows
-- remain visible when their sidebar conversation is archived or hidden.
DO $$ BEGIN
 IF to_regprocedure('opc_library_before_workspace_ui(uuid,text,date,date)') IS NULL THEN
  ALTER FUNCTION opc_library(uuid,text,date,date) RENAME TO opc_library_before_workspace_ui;
 END IF;
END $$;
REVOKE ALL ON FUNCTION opc_library_before_workspace_ui(uuid,text,date,date) FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION opc_library(p_actor_id uuid,p_search text DEFAULT '',p_from date DEFAULT NULL,p_to date DEFAULT NULL)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE source jsonb;business jsonb;account jsonb;item jsonb;businesses jsonb:='[]';accounts jsonb;items jsonb;ui opc_work_ui;account_ui opc_account_ui;publication opc_publication_ui;item_created_at timestamptz;account_source artifact_versions;
BEGIN
 source:=opc_library_before_workspace_ui(p_actor_id,p_search,p_from,p_to);
 FOR business IN SELECT value FROM jsonb_array_elements(source->'businesses') LOOP
  accounts:='[]';
  FOR account IN SELECT value FROM jsonb_array_elements(business->'accounts') LOOP
   items:='[]';
   FOR item IN SELECT value FROM jsonb_array_elements(account->'items') LOOP
    SELECT * INTO ui FROM opc_work_ui WHERE actor_id=p_actor_id AND work_item_id=(item->>'workItemId')::uuid;
    SELECT * INTO publication FROM opc_publication_ui WHERE actor_id=p_actor_id AND work_item_id=(item->>'workItemId')::uuid;
    SELECT created_at INTO item_created_at FROM artifact_projects WHERE id=(item->>'workItemId')::uuid AND actor_id=p_actor_id;
    items:=items || (item || jsonb_build_object(
     'createdAt',item_created_at,
     'chatName',coalesce(ui.display_name,item->>'title'),'pinned',coalesce(ui.pinned,false),
     'archived',coalesce(ui.archived,false),'deleted',coalesce(ui.deleted,false),
     'uiRevision',coalesce(ui.revision,1),'publication',jsonb_build_object(
      'revision',coalesce(publication.revision,1),'plannedDate',publication.planned_date,
      'status',coalesce(publication.status,'unpublished'),'publishedDate',publication.published_date,'publishedVersion',publication.published_version)));
   END LOOP;
   SELECT * INTO account_ui FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=(account->>'projectId')::uuid;
   SELECT v.* INTO account_source FROM opc_accounts a JOIN artifact_versions v ON v.id=a.source_version_id
    WHERE a.project_id=(account->>'projectId')::uuid AND a.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,v.id);
   accounts:=accounts || (jsonb_set(account,'{items}',items) || jsonb_build_object('displayName',coalesce(account_ui.display_name,account->>'account'),'uiRevision',coalesce(account_ui.revision,1),
    'sourceVersionId',account_source.id,'sourceVersion',account_source.version,'profile',CASE WHEN account_source.id IS NOT NULL THEN opc_profile(account_source.id) ELSE NULL END));
  END LOOP;
  businesses:=businesses || jsonb_set(business,'{accounts}',accounts);
 END LOOP;
 RETURN jsonb_set(source,'{businesses}',businesses);
END $$;
REVOKE ALL ON FUNCTION opc_library(uuid,text,date,date) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_library(uuid,text,date,date) TO service_role;

-- Immutable published strategy versions, authorized by the draft's owner and
-- existing source-reachability policy. Current draft edits are not versions.
CREATE OR REPLACE FUNCTION opc_position_history(p_actor_id uuid,p_draft_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE draft opc_drafts;result jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO draft FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF draft.draft_id IS NULL OR NOT bill2_scope_allowed(p_actor_id,jsonb_build_object('kind','positioning_draft','draftId',p_draft_id)) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'version',v.version,'profile',opc_profile(v.id),'createdAt',v.created_at) ORDER BY v.version DESC),'[]'::jsonb) INTO result
 FROM artifact_versions v WHERE v.project_id=draft.project_id AND opc_source_allowed(p_actor_id,v.id);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_position_history(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION opc_position_history(uuid,uuid) TO service_role;

-- Enable manual video-script revisions through the existing immutable content
-- version and source chain. The original accepted script remains the root.
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
     SELECT id,source_content_id,execution_id,1 depth FROM opc_content_versions
      WHERE id=p_source_content_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script'
     UNION ALL
     SELECT parent.id,parent.source_content_id,parent.execution_id,ancestry.depth+1
      FROM opc_content_versions parent JOIN ancestry ON parent.id=ancestry.source_content_id
      WHERE parent.actor_id=p_actor_id AND parent.work_item_id=p_work_item_id AND parent.kind='script' AND ancestry.depth<64
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

-- The transcript needs the real execution time for its day separator. Keep
-- the existing actor/scope and source-availability gates for every row.
CREATE OR REPLACE FUNCTION public.runtime_view(p_actor_id uuid,p_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;items jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'createdAt',e.created_at,'state',e.state,
  'input',CASE WHEN runtime_history_available(e.id) THEN e.payload->>'input' ELSE NULL END,
  'body',CASE WHEN runtime_history_available(e.id) THEN e.result->>'body' ELSE NULL END,
  'primaryBody',CASE WHEN runtime_history_available(e.id) THEN e.primary_result->>'body' ELSE NULL END,
  'organizerComplete',e.result ? 'summary',
  'summary',CASE WHEN runtime_history_available(e.id) THEN e.result->>'summary' ELSE NULL END,
  'skillExecution',coalesce(e.payload->>'revisionId',(SELECT c->>'revisionId' FROM jsonb_array_elements(coalesce(e.payload->'matching'->'candidates','[]'::jsonb)) c WHERE c->>'key'=e.match_result->>'key' LIMIT 1)) IS NOT NULL,
  'needsTask',coalesce((SELECT (c->>'requiresTask')::boolean FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key'),false),
  'unavailableReason',e.unavailable_reason,
  'contentAvailable',runtime_history_available(e.id),'billing',bill2_public(b)) ORDER BY e.created_at,e.id),'[]') INTO items
 FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.session_id=s.id;
 RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope,'activeExecution',s.active_execution,'executions',items);
END $$;
REVOKE ALL ON FUNCTION runtime_view(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION runtime_view(uuid,uuid) TO service_role;

COMMIT;
