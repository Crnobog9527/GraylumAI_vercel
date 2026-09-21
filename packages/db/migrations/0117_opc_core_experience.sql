/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- B1 core experience: business scope, durable topic drafts, one-step adoption,
-- an editable library and versioned content results. This stays on the existing
-- OPC/Runtime/BILL2/Artifact primitives; it does not add another executor.
BEGIN;

CREATE TABLE IF NOT EXISTS opc_businesses (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES profiles(id),
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 120),
 current_source_version_id uuid REFERENCES artifact_versions(id), revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(actor_id,id)
);
ALTER TABLE opc_businesses ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_businesses FROM PUBLIC,anon,authenticated,service_role;

ALTER TABLE opc_accounts ADD COLUMN IF NOT EXISTS business_id uuid REFERENCES opc_businesses(id);
ALTER TABLE opc_accounts ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'unknown'
 CHECK(stage IN ('unknown','starting','growing','mature'));
CREATE TABLE IF NOT EXISTS opc_draft_businesses (
 draft_id uuid PRIMARY KEY REFERENCES opc_drafts(draft_id),business_id uuid NOT NULL REFERENCES opc_businesses(id)
);
CREATE TABLE IF NOT EXISTS opc_item_edits (
 work_item_id uuid PRIMARY KEY REFERENCES opc_items(work_item_id),revision bigint NOT NULL DEFAULT 1,
 title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160),brief text NOT NULL CHECK(char_length(brief) BETWEEN 1 AND 2000),day date NOT NULL
);
ALTER TABLE opc_draft_businesses ENABLE ROW LEVEL SECURITY;
ALTER TABLE opc_item_edits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_draft_businesses,opc_item_edits FROM PUBLIC,anon,authenticated,service_role;

-- Every pre-B1 positioning draft is one independent business. Accounts that
-- originated from that positioning share it; unrelated drafts stay isolated.
INSERT INTO opc_businesses(id,actor_id,name,current_source_version_id)
SELECT d.draft_id,d.actor_id,'未命名业务',v.id
FROM opc_drafts d LEFT JOIN artifact_projects p ON p.id=d.project_id
LEFT JOIN artifact_versions v ON v.project_id=p.id AND v.version=p.current_version
ON CONFLICT(id) DO NOTHING;
INSERT INTO opc_draft_businesses(draft_id,business_id) SELECT draft_id,draft_id FROM opc_drafts ON CONFLICT(draft_id) DO NOTHING;
UPDATE opc_accounts ac SET business_id=d.business_id
FROM artifact_versions v JOIN opc_drafts od ON od.project_id=v.project_id JOIN opc_draft_businesses d ON d.draft_id=od.draft_id
WHERE ac.business_id IS NULL AND ac.source_version_id=v.id;

CREATE INDEX IF NOT EXISTS opc_accounts_business_idx ON opc_accounts(actor_id,business_id);
CREATE INDEX IF NOT EXISTS opc_items_account_day_idx ON opc_items(account_project_id,day);

CREATE TABLE IF NOT EXISTS opc_topic_draft_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), draft_id uuid NOT NULL REFERENCES opc_drafts(draft_id),
 actor_id uuid NOT NULL REFERENCES profiles(id), version bigint NOT NULL CHECK(version>0),
 source_version_id uuid NOT NULL REFERENCES artifact_versions(id), request_id uuid NOT NULL,
 request jsonb NOT NULL, body jsonb NOT NULL CHECK(jsonb_typeof(body)='array' AND jsonb_array_length(body) BETWEEN 1 AND 28),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(draft_id,version),UNIQUE(draft_id,request_id)
);
ALTER TABLE opc_topic_draft_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_topic_draft_versions FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_topic_draft_versions;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_topic_draft_versions FOR EACH ROW EXECUTE FUNCTION artifact_immutable();

CREATE TABLE IF NOT EXISTS opc_library_requests (
 actor_id uuid NOT NULL REFERENCES profiles(id),request_id uuid NOT NULL,payload jsonb NOT NULL,result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(actor_id,request_id)
);
ALTER TABLE opc_library_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_library_requests FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_library_requests;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_library_requests FOR EACH ROW EXECUTE FUNCTION artifact_immutable();

CREATE TABLE IF NOT EXISTS opc_content_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES profiles(id),
 work_item_id uuid NOT NULL REFERENCES opc_items(work_item_id),kind text NOT NULL CHECK(kind IN ('brief','script','storyboard','editing')),
 version bigint NOT NULL CHECK(version>0),status text NOT NULL CHECK(status IN ('draft','final')),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 20000),source_content_id uuid REFERENCES opc_content_versions(id),
 execution_id uuid REFERENCES runtime_executions(id),request_id uuid NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(work_item_id,kind,version),UNIQUE(actor_id,request_id,kind)
);
ALTER TABLE opc_content_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_content_versions FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS artifact_immutable ON opc_content_versions;
CREATE TRIGGER artifact_immutable BEFORE UPDATE OR DELETE ON opc_content_versions FOR EACH ROW EXECUTE FUNCTION artifact_immutable();

-- Start or replay one positioning draft with an explicit business scope. A new
-- business is created once; selecting an existing business shares only its core
-- positioning while account-specific stage and content remain separate.
CREATE OR REPLACE FUNCTION opc_start_b1(p_actor_id uuid,p_request_id uuid,p_registration text,p_mode text,p_business_id uuid DEFAULT NULL,p_business_name text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;d opc_drafts;b opc_businesses;mapping opc_draft_businesses;requested_name text:=trim(coalesce(p_business_name,''));
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_business_id IS NOT NULL THEN
  SELECT * INTO b FROM opc_businesses WHERE id=p_business_id AND actor_id=p_actor_id FOR SHARE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED';END IF;
 ELSE
  IF char_length(requested_name) NOT BETWEEN 1 AND 120 THEN requested_name:='未命名业务';END IF;
 END IF;
 result:=opc_start(p_actor_id,p_request_id,p_registration,p_mode);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=(result->>'draftId')::uuid AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO mapping FROM opc_draft_businesses WHERE draft_id=d.draft_id;
 IF mapping.business_id IS NOT NULL THEN
  IF p_business_id IS NOT NULL AND mapping.business_id IS DISTINCT FROM p_business_id THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  SELECT * INTO b FROM opc_businesses WHERE id=mapping.business_id;
 ELSE
  IF p_business_id IS NULL THEN
   INSERT INTO opc_businesses(actor_id,name) VALUES(p_actor_id,requested_name) RETURNING * INTO b;
  END IF;
  INSERT INTO opc_draft_businesses VALUES(d.draft_id,b.id);
 END IF;
 RETURN result||jsonb_build_object('businessId',b.id,'businessName',b.name);
END $$;

-- A published positioning version becomes the business's current core source
-- immediately. Waiting, closing the prompt or merely opening the topic link
-- must not make a formally published business look unfinished.
DO $$ BEGIN
 IF to_regprocedure('artifact_transition_before_b1(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb) RENAME TO artifact_transition_before_b1;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION artifact_transition(p_actor_id uuid,p_module_id uuid,p_skill_id uuid,p_action text,p_project_id uuid DEFAULT NULL,p_round_id uuid DEFAULT NULL,p_request_id uuid DEFAULT NULL,p_payload jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=artifact_transition_before_b1(p_actor_id,p_module_id,p_skill_id,p_action,p_project_id,p_round_id,p_request_id,p_payload);
 IF p_action='publish' AND result->>'versionId' IS NOT NULL THEN
  UPDATE opc_businesses b SET current_source_version_id=(result->>'versionId')::uuid,revision=b.revision+1
  FROM opc_drafts d JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
  WHERE d.project_id=p_project_id AND d.actor_id=p_actor_id AND b.id=db.business_id
   AND b.current_source_version_id IS DISTINCT FROM (result->>'versionId')::uuid;
 END IF;
 RETURN result;
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
   IF item-ARRAY['id','platform','account','title','brief','day']<>'{}' OR coalesce(item->>'id','')!~*'^[0-9a-f-]{36}$'
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

CREATE OR REPLACE FUNCTION opc_topic_draft_read(p_actor_id uuid,p_draft_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF NOT EXISTS(SELECT 1 FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id) THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 RETURN coalesce((SELECT jsonb_build_object('draftVersionId',id,'requestId',request_id,'version',version,'sourceVersionId',source_version_id,
  'body',CASE WHEN opc_source_allowed(p_actor_id,source_version_id) THEN body ELSE NULL END,'createdAt',created_at)
  FROM opc_topic_draft_versions WHERE draft_id=p_draft_id ORDER BY version DESC LIMIT 1),jsonb_build_object('version',0));
END $$;

-- Preserve the exact payload and request id of pre-B1 handoff retries while
-- attaching their work items to the draft's business. The original handoff
-- remains the immutable/idempotent executor; this wrapper only adds the B1
-- ownership check and business projection in the same transaction.
CREATE OR REPLACE FUNCTION opc_handoff_b1(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_plan_id uuid,p_accounts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE business uuid;result jsonb;target jsonb;ac opc_accounts;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text,107));
 SELECT db.business_id INTO business FROM opc_drafts d JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
  WHERE d.draft_id=p_draft_id AND d.actor_id=p_actor_id;
 IF business IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED';END IF;
 IF jsonb_typeof(p_accounts) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'OPC_ACCOUNTS_INVALID';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(p_accounts) LOOP
  SELECT * INTO ac FROM opc_accounts WHERE actor_id=p_actor_id AND platform=target->>'platform' AND account_key=target->>'account';
  IF ac.project_id IS NOT NULL AND ac.business_id IS NOT NULL AND ac.business_id IS DISTINCT FROM business THEN RAISE EXCEPTION 'OPC_BUSINESS_CONFLICT';END IF;
 END LOOP;
 result:=opc_handoff(p_actor_id,p_draft_id,p_request_id,p_plan_id,p_accounts);
 UPDATE opc_accounts a SET business_id=business
 WHERE a.actor_id=p_actor_id AND EXISTS(SELECT 1 FROM jsonb_array_elements(result) r WHERE (r->>'projectId')::uuid=a.project_id)
  AND a.business_id IS NULL;
 RETURN result;
END $$;

-- One user adoption performs the exact-version save and handoff in the same DB
-- transaction. Replaying the frozen request returns the same plan/work items.
CREATE OR REPLACE FUNCTION opc_adopt_topics(p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_expected_version bigint,p_source_version_id uuid,p_body jsonb,p_accounts jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d opc_drafts;business uuid;plan jsonb;result jsonb;target jsonb;ac opc_accounts;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text,107));
 SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF d.draft_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 SELECT business_id INTO business FROM opc_draft_businesses WHERE draft_id=d.draft_id;
 IF business IS NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_DENIED';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(p_accounts) LOOP
  SELECT * INTO ac FROM opc_accounts WHERE actor_id=p_actor_id AND platform=target->>'platform' AND account_key=target->>'account';
  IF ac.project_id IS NOT NULL AND ac.business_id IS NOT NULL AND ac.business_id IS DISTINCT FROM business THEN RAISE EXCEPTION 'OPC_BUSINESS_CONFLICT';END IF;
 END LOOP;
 plan:=opc_save_plan(p_actor_id,p_draft_id,p_request_id,p_expected_version,p_source_version_id,p_body);
 result:=opc_handoff_b1(p_actor_id,p_draft_id,p_request_id,(plan->>'planId')::uuid,p_accounts);
 UPDATE opc_businesses SET current_source_version_id=p_source_version_id,revision=revision+1 WHERE id=business AND current_source_version_id IS DISTINCT FROM p_source_version_id;
 RETURN jsonb_build_object('planId',plan->>'planId','version',(plan->>'version')::bigint,'items',result);
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
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object('workItemId',i.work_item_id,'title',coalesce(ed.title,p.work_title),'brief',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) THEN coalesce(ed.brief,i.brief) ELSE NULL END,'day',coalesce(ed.day,i.day),'revision',coalesce(ed.revision,1),'sessionId',s.id,'sourceAvailable',opc_source_allowed(p_actor_id,i.source_version_id),
    'content',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'body',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) AND (c.execution_id IS NULL OR runtime_history_available(c.execution_id)) THEN c.body ELSE NULL END,'contentAvailable',opc_source_allowed(p_actor_id,i.source_version_id) AND (c.execution_id IS NULL OR runtime_history_available(c.execution_id)),'sourceContentId',c.source_content_id,'executionId',c.execution_id,'requestId',c.request_id,'createdAt',c.created_at) ORDER BY c.created_at) FROM opc_content_versions c WHERE c.work_item_id=i.work_item_id),'[]'::jsonb)) ORDER BY i.day,p.work_title)
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
  IF p_patch-ARRAY['title','brief','day']<>'{}' OR char_length(trim(coalesce(p_patch->>'title',''))) NOT BETWEEN 1 AND 160
   OR char_length(trim(coalesce(p_patch->>'brief',''))) NOT BETWEEN 1 AND 2000 OR coalesce(p_patch->>'day','')!~'^\d{4}-\d{2}-\d{2}$' THEN RAISE EXCEPTION 'OPC_LIBRARY_INVALID';END IF;
  SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id WHERE wi.work_item_id=p_target_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id) FOR UPDATE OF wi;
  IF i.work_item_id IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
  SELECT * INTO ed FROM opc_item_edits WHERE work_item_id=i.work_item_id FOR UPDATE;
  current_revision:=coalesce(ed.revision,1);
  IF current_revision<>p_expected_revision THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  title:=trim(p_patch->>'title');
  INSERT INTO opc_item_edits(work_item_id,revision,title,brief,day) VALUES(i.work_item_id,current_revision+1,title,trim(p_patch->>'brief'),(p_patch->>'day')::date)
   ON CONFLICT(work_item_id) DO UPDATE SET revision=excluded.revision,title=excluded.title,brief=excluded.brief,day=excluded.day RETURNING * INTO ed;
  UPDATE artifact_projects SET work_title=title WHERE id=i.work_item_id;
  SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
  SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
  PERFORM runtime_material(p_actor_id,s.id,'save',p_request_id,n,jsonb_build_object('brief','标题：'||title||E'\n简报：'||ed.brief,'material',coalesce(opc_profile(i.source_version_id)::text,''),'roundId',NULL));
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
  SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind=p_kind;
  IF n<>p_expected_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
  IF p_source_content_id IS NOT NULL THEN SELECT * INTO source FROM opc_content_versions WHERE id=p_source_content_id AND work_item_id=p_work_item_id;IF source.id IS NULL THEN RAISE EXCEPTION 'OPC_CONTENT_SOURCE';END IF;END IF;
  INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,execution_id,request_id)
   VALUES(p_actor_id,p_work_item_id,p_kind,n+1,p_status,body,p_source_content_id,p_execution_id,p_request_id) RETURNING * INTO c;
  IF p_kind='script' AND p_status='final' THEN
   SELECT coalesce(max(revision),0) INTO material_revision FROM runtime_scope_material WHERE session_id=s.id;
   PERFORM runtime_material(p_actor_id,s.id,'save',p_request_id,material_revision,jsonb_build_object('brief','已定稿口播稿：'||body,'material',coalesce(opc_profile(i.source_version_id)::text,''),'roundId',NULL));
  END IF;
 END IF;
 RETURN jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'body',c.body);
END $$;

-- Validate the prepared follow-up before dispatch. Its frozen Runtime material
-- must be the material revision created by this exact final script version.
CREATE OR REPLACE FUNCTION opc_video_execution_check(p_actor_id uuid,p_work_item_id uuid,p_execution_id uuid,p_source_script_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;e runtime_executions;script opc_content_versions;m runtime_scope_material;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id
  WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,wi.source_version_id);
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id AND session_id=s.id;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=s.id AND request_id=script.request_id AND NOT revoked;
 IF i.work_item_id IS NULL OR e.id IS NULL OR script.id IS NULL OR script.execution_id IS NULL OR NOT runtime_history_available(script.execution_id)
  OR m.session_id IS NULL OR e.payload#>>'{scopeMaterial,sessionId}' IS DISTINCT FROM s.id::text
  OR e.payload#>>'{scopeMaterial,revision}' IS DISTINCT FROM m.revision::text
  OR e.payload#>>'{scopeMaterial,hash}' IS DISTINCT FROM m.content_hash
  OR m.content->>'brief' IS DISTINCT FROM '已定稿口播稿：'||script.body THEN RAISE EXCEPTION 'OPC_CONTENT_BINDING';END IF;
 RETURN jsonb_build_object('valid',true,'materialRevision',m.revision);
END $$;

CREATE OR REPLACE FUNCTION opc_video_package_from_execution(p_actor_id uuid,p_work_item_id uuid,p_request_id uuid,p_execution_id uuid,p_source_script_id uuid,p_expected_storyboard_version bigint,p_expected_editing_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE i opc_items;s runtime_sessions;e runtime_executions;script opc_content_versions;raw text;package jsonb;story opc_content_versions;editing opc_content_versions;n bigint;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 PERFORM opc_video_execution_check(p_actor_id,p_work_item_id,p_execution_id,p_source_script_id);
 SELECT wi.* INTO i FROM opc_items wi JOIN artifact_projects p ON p.id=wi.work_item_id WHERE wi.work_item_id=p_work_item_id AND p.actor_id=p_actor_id;
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND scope=jsonb_build_object('kind','work_item','projectId',i.account_project_id,'workItemId',i.work_item_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id AND session_id=s.id;
 SELECT * INTO script FROM opc_content_versions WHERE id=p_source_script_id AND actor_id=p_actor_id AND work_item_id=p_work_item_id AND kind='script' AND status='final';
 IF i.work_item_id IS NULL OR e.id IS NULL OR e.state<>'completed' OR script.id IS NULL OR NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'OPC_CONTENT_DENIED';END IF;
 SELECT * INTO story FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind='storyboard';
 SELECT * INTO editing FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind='editing';
 IF story.id IS NOT NULL OR editing.id IS NOT NULL THEN
  IF story.id IS NULL OR editing.id IS NULL OR story.execution_id<>p_execution_id OR editing.execution_id<>p_execution_id OR story.source_content_id<>script.id OR editing.source_content_id<>script.id THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('storyboard',jsonb_build_object('id',story.id,'version',story.version),'editing',jsonb_build_object('id',editing.id,'version',editing.version));
 END IF;
 raw:=coalesce(e.result->>'body',e.primary_result->>'body');
 BEGIN package:=raw::jsonb;EXCEPTION WHEN others THEN RAISE EXCEPTION 'OPC_CONTENT_RESPONSE_INVALID';END;
 IF package-ARRAY['storyboard','editing']<>'{}' OR jsonb_typeof(package->'storyboard')<>'string' OR jsonb_typeof(package->'editing')<>'string'
  OR char_length(package->>'storyboard') NOT BETWEEN 1 AND 20000 OR char_length(package->>'editing') NOT BETWEEN 1 AND 20000 THEN RAISE EXCEPTION 'OPC_CONTENT_RESPONSE_INVALID';END IF;
 SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='storyboard';IF n<>p_expected_storyboard_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,execution_id,request_id) VALUES(p_actor_id,p_work_item_id,'storyboard',n+1,'final',package->>'storyboard',script.id,e.id,p_request_id) RETURNING * INTO story;
 SELECT coalesce(max(version),0) INTO n FROM opc_content_versions WHERE work_item_id=p_work_item_id AND kind='editing';IF n<>p_expected_editing_version THEN RAISE EXCEPTION 'OPC_VERSION_CONFLICT';END IF;
 INSERT INTO opc_content_versions(actor_id,work_item_id,kind,version,status,body,source_content_id,execution_id,request_id) VALUES(p_actor_id,p_work_item_id,'editing',n+1,'final',package->>'editing',script.id,e.id,p_request_id) RETURNING * INTO editing;
 RETURN jsonb_build_object('storyboard',jsonb_build_object('id',story.id,'version',story.version),'editing',jsonb_build_object('id',editing.id,'version',editing.version));
END $$;

REVOKE ALL ON FUNCTION artifact_transition_before_b1(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),opc_start_b1(uuid,uuid,text,text,uuid,text),opc_topic_draft_save(uuid,uuid,uuid,bigint,uuid,jsonb),opc_topic_draft_read(uuid,uuid),opc_handoff_b1(uuid,uuid,uuid,uuid,jsonb),opc_adopt_topics(uuid,uuid,uuid,bigint,uuid,jsonb,jsonb),opc_library(uuid,text,date,date),opc_library_edit(uuid,uuid,text,uuid,bigint,jsonb),opc_content_from_execution(uuid,uuid,uuid,bigint,text,text,uuid,uuid),opc_video_execution_check(uuid,uuid,uuid,uuid),opc_video_package_from_execution(uuid,uuid,uuid,uuid,uuid,bigint,bigint) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb),opc_start_b1(uuid,uuid,text,text,uuid,text),opc_topic_draft_save(uuid,uuid,uuid,bigint,uuid,jsonb),opc_topic_draft_read(uuid,uuid),opc_handoff_b1(uuid,uuid,uuid,uuid,jsonb),opc_adopt_topics(uuid,uuid,uuid,bigint,uuid,jsonb,jsonb),opc_library(uuid,text,date,date),opc_library_edit(uuid,uuid,text,uuid,bigint,jsonb),opc_content_from_execution(uuid,uuid,uuid,bigint,text,text,uuid,uuid),opc_video_execution_check(uuid,uuid,uuid,uuid),opc_video_package_from_execution(uuid,uuid,uuid,uuid,uuid,bigint,bigint) TO service_role;

COMMIT;
