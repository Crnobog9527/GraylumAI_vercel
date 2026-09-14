/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Additive persistent SDK history and atomic Runtime admission. No remote enablement.
BEGIN;
CREATE TABLE IF NOT EXISTS public.runtime_sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES profiles(id),
 scope jsonb NOT NULL,start_request_id uuid NOT NULL,start_payload jsonb NOT NULL,
 revision bigint NOT NULL DEFAULT 0,active_execution uuid,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_id,start_request_id),UNIQUE(actor_id,scope),
 CHECK(octet_length(start_payload::text)<=65536)
);
CREATE TABLE IF NOT EXISTS public.runtime_executions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),actor_id uuid NOT NULL REFERENCES profiles(id),
 session_id uuid NOT NULL REFERENCES runtime_sessions(id),request_id uuid NOT NULL,
 payload jsonb NOT NULL,billing_run_id uuid UNIQUE REFERENCES bill2_runs(id),
 history_revision bigint NOT NULL,state text NOT NULL DEFAULT 'prepared'
 CHECK(state IN ('prepared','running','interrupted','cost_pending','completed','cancelled')),
 result jsonb,created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_id,request_id),CHECK(octet_length(payload::text)<=262144)
);
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS candidate_history bigint[] NOT NULL DEFAULT ARRAY[]::bigint[];
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS selected_history bigint[];
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS primary_result jsonb;
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS match_result jsonb;
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS unavailable_reason text;
CREATE TABLE IF NOT EXISTS public.runtime_history_dependencies (
 execution_id uuid NOT NULL REFERENCES runtime_executions(id),dependency_id uuid NOT NULL REFERENCES runtime_executions(id),
 PRIMARY KEY(execution_id,dependency_id),CHECK(execution_id<>dependency_id)
);
CREATE TABLE IF NOT EXISTS public.runtime_session_batches (
 session_id uuid NOT NULL REFERENCES runtime_sessions(id),execution_id uuid NOT NULL REFERENCES runtime_executions(id),
 batch integer NOT NULL CHECK(batch>=0),items jsonb NOT NULL,
 start_revision bigint NOT NULL,end_revision bigint NOT NULL,
 PRIMARY KEY(execution_id,batch),CHECK(jsonb_typeof(items)='array'),
 CHECK(octet_length(items::text)<=1048576)
);
CREATE TABLE IF NOT EXISTS public.runtime_session_history (
 session_id uuid NOT NULL REFERENCES runtime_sessions(id),revision bigint NOT NULL,
 execution_id uuid NOT NULL REFERENCES runtime_executions(id),item jsonb NOT NULL,
 PRIMARY KEY(session_id,revision),CHECK(octet_length(item::text)<=262144)
);
CREATE TABLE IF NOT EXISTS public.runtime_tool_calls (
 execution_id uuid NOT NULL REFERENCES runtime_executions(id),call_id text NOT NULL,
 name text NOT NULL,arguments jsonb NOT NULL,result jsonb,
 PRIMARY KEY(execution_id,call_id),CHECK(length(call_id) BETWEEN 1 AND 256),
 CHECK(octet_length(arguments::text)<=8192),CHECK(octet_length(result::text)<=262144)
);
ALTER TABLE public.runtime_session_history ADD COLUMN IF NOT EXISTS internal_control boolean NOT NULL DEFAULT false;
ALTER TABLE bill2_runs DROP CONSTRAINT IF EXISTS bill2_runs_session_ref_check;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='bill2_runs'::regclass AND conname='bill2_runs_runtime_session_fk') THEN
  ALTER TABLE bill2_runs ADD CONSTRAINT bill2_runs_runtime_session_fk FOREIGN KEY(session_ref) REFERENCES runtime_sessions(id);
 END IF;
END $$;

-- Scope notes are immutable versions bound to the existing Session. They are
-- user data, never model/tool policy. Revocation preserves original evidence.
CREATE TABLE IF NOT EXISTS public.runtime_scope_material (
 session_id uuid NOT NULL REFERENCES runtime_sessions(id), revision bigint NOT NULL CHECK(revision>0),
 request_id uuid NOT NULL, request jsonb NOT NULL, content jsonb NOT NULL, content_hash text NOT NULL,
 revoked boolean NOT NULL DEFAULT false, PRIMARY KEY(session_id,revision),UNIQUE(session_id,request_id),
 CHECK(octet_length(content::text)<=32768)
);
CREATE OR REPLACE FUNCTION public.runtime_work_projection(p_actor_id uuid,p_session_id uuid,p_round_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;r artifact_rounds;v jsonb;source jsonb;ref jsonb;
BEGIN
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 IF p_round_id IS NULL THEN RETURN NULL;END IF;
 IF s.scope->>'kind'<>'work_item' THEN RAISE EXCEPTION 'RUNTIME_WORK_ROUND_DENIED';END IF;
 SELECT * INTO r FROM artifact_rounds WHERE id=p_round_id AND project_id=(s.scope->>'workItemId')::uuid;
 IF r.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_WORK_ROUND_DENIED';END IF;
 v:=artifact_query(p_actor_id,'read',r.project_id,r.id);
 SELECT jsonb_build_object('projectId',project_id,'roundId',round_id,'sourceVersionId',source_version_id,'hash',source_hash) INTO ref
 FROM artifact_work_references WHERE project_id=r.project_id AND round_id=r.id;
 IF ref IS NOT NULL THEN source:=runtime_source(p_actor_id,ref);END IF;
 -- No candidate/generation history or private workflow instructions are copied.
 RETURN jsonb_build_object('projectId',r.project_id,'roundId',r.id,'revisionId',r.revision_id,
  'packageHash',r.package_hash,'steps',v->'steps','source',source);
END $$;
CREATE OR REPLACE FUNCTION public.runtime_material(p_actor_id uuid,p_session_id uuid,p_action text,p_request_id uuid DEFAULT NULL,p_expected_revision bigint DEFAULT NULL,p_payload jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;m runtime_scope_material;n bigint;content jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT coalesce(max(revision),0) INTO n FROM runtime_scope_material WHERE session_id=s.id;
 IF p_action='save' THEN
  IF p_request_id IS NULL OR p_expected_revision IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
   OR jsonb_typeof(p_payload->'brief') IS DISTINCT FROM 'string' OR jsonb_typeof(p_payload->'material') IS DISTINCT FROM 'string'
   OR octet_length(p_payload::text)>24000 OR p_payload-ARRAY['brief','material','roundId']<>'{}'::jsonb THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_INVALID';END IF;
  SELECT * INTO m FROM runtime_scope_material WHERE session_id=s.id AND request_id=p_request_id;
  IF m.request_id IS NOT NULL THEN
   IF m.request IS DISTINCT FROM jsonb_build_object('expectedRevision',p_expected_revision,'payload',p_payload) THEN RAISE EXCEPTION 'RUNTIME_REQUEST_CONFLICT';END IF;
  ELSE
   IF n<>p_expected_revision THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_CONFLICT';END IF;
   content:=p_payload||jsonb_build_object('work',runtime_work_projection(p_actor_id,s.id,(p_payload->>'roundId')::uuid));
   INSERT INTO runtime_scope_material(session_id,revision,request_id,request,content,content_hash)
   VALUES(s.id,n+1,p_request_id,jsonb_build_object('expectedRevision',p_expected_revision,'payload',p_payload),content,encode(sha256(convert_to(content::text,'UTF8')),'hex')) RETURNING * INTO m;
  END IF;
 ELSIF p_action='revoke' THEN
  UPDATE runtime_scope_material SET revoked=true WHERE session_id=s.id AND revision=p_expected_revision RETURNING * INTO m;
  IF m.session_id IS NULL THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_MISSING';END IF;
 ELSE RAISE EXCEPTION 'RUNTIME_MATERIAL_ACTION';END IF;
 RETURN jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash,'revoked',m.revoked);
END $$;
CREATE OR REPLACE FUNCTION public.runtime_material_allowed(p_actor_id uuid,p_material jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE m runtime_scope_material;current_work jsonb;st jsonb;
BEGIN
 IF p_material IS NULL OR p_material='null'::jsonb THEN RETURN;END IF;
 SELECT v.* INTO m FROM runtime_scope_material v JOIN runtime_sessions s ON s.id=v.session_id
 WHERE s.actor_id=p_actor_id AND v.session_id=(p_material->>'sessionId')::uuid AND v.revision=(p_material->>'revision')::bigint FOR SHARE OF v;
 IF m.session_id IS NULL OR m.revoked OR m.content_hash IS DISTINCT FROM p_material->>'hash' OR m.content IS DISTINCT FROM p_material->'content'

 THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 current_work:=coalesce(runtime_work_projection(p_actor_id,m.session_id,(m.content->>'roundId')::uuid),'null'::jsonb);
 -- A normal edit does not revoke frozen text. Recheck its original evidence
 -- and immutable package/source identity, never substitute current step text.
 IF (CASE WHEN jsonb_typeof(m.content->'work')='object' THEN (m.content->'work')-'steps' ELSE m.content->'work' END) IS DISTINCT FROM (CASE WHEN jsonb_typeof(current_work)='object' THEN current_work-'steps' ELSE current_work END) THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 FOR st IN SELECT value FROM jsonb_each(coalesce(m.content->'work'->'steps','{}')) LOOP
  IF NOT artifact_evidence_allowed((m.content->'work'->>'projectId')::uuid,coalesce(st->'evidenceIds','[]')||coalesce(st->'provenanceIds','[]')) THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_UNAVAILABLE';END IF;
 END LOOP;
END $$;

-- Explicit immutable source selection; reuse existing artifact permissions/version checks.
CREATE OR REPLACE FUNCTION public.runtime_source(p_actor_id uuid,p_source jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF jsonb_typeof(p_source) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RUNTIME_SOURCE_DENIED';END IF;
 IF NOT EXISTS(SELECT 1 FROM artifact_projects WHERE id=(p_source->>'projectId')::uuid AND actor_id=p_actor_id) THEN RAISE EXCEPTION 'RUNTIME_SOURCE_DENIED';END IF;
 PERFORM cfg.id FROM artifact_reference_configs cfg JOIN artifact_work_references ref ON ref.config_id=cfg.id
 WHERE ref.project_id=(p_source->>'projectId')::uuid AND ref.round_id=(p_source->>'roundId')::uuid FOR SHARE OF cfg;
 PERFORM src.id FROM artifact_projects src JOIN artifact_versions ver ON ver.project_id=src.id JOIN artifact_work_references ref ON ref.source_version_id=ver.id
 WHERE ref.project_id=(p_source->>'projectId')::uuid AND ref.round_id=(p_source->>'roundId')::uuid FOR SHARE OF src;
 PERFORM ac.actor_id FROM artifact_accounts ac JOIN artifact_projects src ON src.actor_id=ac.actor_id AND src.module_id=ac.module_id AND src.skill_id=ac.skill_id AND src.account=ac.account
 JOIN artifact_versions ver ON ver.project_id=src.id JOIN artifact_work_references ref ON ref.source_version_id=ver.id
 WHERE ref.project_id=(p_source->>'projectId')::uuid AND ref.round_id=(p_source->>'roundId')::uuid FOR KEY SHARE OF ac;
 PERFORM id FROM artifact_projects WHERE id=(p_source->>'projectId')::uuid AND actor_id=p_actor_id FOR SHARE;
 v:=artifact_work_source(p_actor_id,(p_source->>'projectId')::uuid,(p_source->>'roundId')::uuid);
 IF v IS NULL OR v='null'::jsonb OR v->>'sourceVersionId' IS DISTINCT FROM p_source->>'sourceVersionId'
 OR v->>'hash' IS DISTINCT FROM p_source->>'hash' THEN RAISE EXCEPTION 'RUNTIME_SOURCE_STALE';END IF;
 RETURN v;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_context_allowed(p_actor_id uuid,p_context jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE item jsonb;
BEGIN
 IF p_context->>'version' IS DISTINCT FROM 'runtime.v1' THEN RETURN;END IF;
 PERFORM runtime_material_allowed(p_actor_id,p_context->'scopeMaterial');
 IF jsonb_typeof(coalesce(p_context->'sources','[]')) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'RUNTIME_SOURCE_DENIED';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(coalesce(p_context->'sources','[]')) LOOP
  PERFORM runtime_source(p_actor_id,item);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION public.runtime_history_available(p_execution_id uuid) RETURNS boolean
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;b bill2_runs;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id;
 IF e.id IS NULL OR e.unavailable_reason IS NOT NULL THEN RETURN false;END IF;
 PERFORM runtime_billing_allowed(e.actor_id,b.payload,b.id);
 PERFORM runtime_context_allowed(e.actor_id,e.payload);

 RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false; -- Unavailable source is excluded from model history, never erased.
END $$;

CREATE OR REPLACE FUNCTION public.runtime_start(p_actor_id uuid,p_request_id uuid,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;sc jsonb;d uuid;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_request_id IS NULL OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RUNTIME_INVALID_START';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,106));
 SELECT * INTO s FROM runtime_sessions WHERE actor_id=p_actor_id AND start_request_id=p_request_id;
 IF s.id IS NOT NULL THEN
  IF s.start_payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'RUNTIME_REQUEST_CONFLICT';END IF;
  IF NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
  RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope);
 END IF;
 sc:=p_payload->'scope';
 IF sc=jsonb_build_object('kind','positioning_draft') THEN
  d:=bill2_create_draft(p_actor_id);sc:=sc||jsonb_build_object('draftId',d);
 END IF;
 IF NOT coalesce(bill2_scope_allowed(p_actor_id,sc),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 INSERT INTO runtime_sessions(actor_id,scope,start_request_id,start_payload) VALUES(p_actor_id,sc,p_request_id,p_payload)
 ON CONFLICT(actor_id,scope) DO NOTHING RETURNING * INTO s;
 IF s.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_SCOPE_ALREADY_BOUND';END IF;
 RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_admit(p_actor_id uuid,p_session_id uuid,p_request_id uuid,p_payload jsonb,p_billing jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;e runtime_executions;b jsonb;
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
 IF s.active_execution IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_SESSION_BUSY';END IF;
 IF p_payload IS DISTINCT FROM p_billing->'input' THEN RAISE EXCEPTION 'RUNTIME_INPUT_BINDING_DENIED';END IF;
 IF p_payload->'scopeMaterial' IS NOT NULL AND p_payload->'scopeMaterial'->>'sessionId' IS DISTINCT FROM s.id::text THEN RAISE EXCEPTION 'RUNTIME_MATERIAL_SCOPE';END IF;
 PERFORM runtime_context_allowed(p_actor_id,p_payload);
 IF p_billing->'scope' IS DISTINCT FROM s.scope OR p_billing->>'sessionRef' IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 -- Share the original admission lock before checking for an existing BILL2 run.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,105));
 -- Never adopt an old isolated run, even with a matching public request ID.
 IF EXISTS(SELECT 1 FROM bill2_runs WHERE actor_id=p_actor_id AND request_id=p_request_id) THEN RAISE EXCEPTION 'RUNTIME_LEGACY_RUN_DENIED';END IF;
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
 -- Freeze only a bounded eligible item window, not every old execution.
 -- The SDK capacity/tool selector freezes the actual suffix before dispatch.
 UPDATE runtime_executions SET candidate_history=ARRAY(
  SELECT revision FROM (SELECT h.revision,h.execution_id FROM runtime_session_history h
   WHERE h.session_id=s.id AND h.revision<=s.revision AND NOT h.internal_control
   ORDER BY h.revision DESC LIMIT CASE WHEN coalesce((p_payload->>'historyItems')::int,0)>0 THEN least(1000,(p_payload->>'historyItems')::int)+128 ELSE 0 END) bounded
  WHERE runtime_history_available(execution_id) ORDER BY revision) WHERE id=e.id;
 UPDATE bill2_runs SET session_ref=s.id WHERE id=e.billing_run_id;
 UPDATE runtime_sessions SET active_execution=e.id WHERE id=s.id;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_binding_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.session_ref IS NOT DISTINCT FROM OLD.session_ref THEN RETURN NEW;END IF;
 IF OLD.session_ref IS NOT NULL OR NEW.session_ref IS NULL OR OLD.state<>'prepared'
 OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=OLD.id)
 OR NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
  WHERE e.billing_run_id=OLD.id AND e.session_id=NEW.session_ref AND e.actor_id=OLD.actor_id AND s.scope=OLD.scope)
 THEN RAISE EXCEPTION 'RUNTIME_IMMUTABLE_BINDING';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_binding_guard ON bill2_runs;
CREATE TRIGGER runtime_binding_guard BEFORE UPDATE OF session_ref ON bill2_runs FOR EACH ROW EXECUTE FUNCTION runtime_binding_guard();

CREATE OR REPLACE FUNCTION public.runtime_session_items(p_actor_id uuid,p_session_id uuid,p_execution_id uuid,p_action text,p_items jsonb DEFAULT NULL,p_limit integer DEFAULT NULL,p_batch integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;e runtime_executions;b runtime_session_batches;n integer;answer jsonb;selected bigint[];
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND session_id=s.id AND actor_id=p_actor_id;
 IF s.id IS NULL OR e.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SESSION_DENIED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,(SELECT payload FROM bill2_runs WHERE id=e.billing_run_id),e.billing_run_id);
 IF p_action='read' THEN
  IF p_limit<0 THEN RAISE EXCEPTION 'RUNTIME_SESSION_LIMIT';END IF;
  -- Freeze the SDK's initial history for replay; this execution's own batches
  -- are replayed by the host, never injected again as previous-turn history.
  SELECT coalesce(jsonb_agg(item ORDER BY revision),'[]') INTO answer FROM
   (SELECT jsonb_build_object('revision',revision,'item',item) item,revision FROM runtime_session_history h WHERE session_id=s.id AND revision=ANY(coalesce(e.selected_history,e.candidate_history)) AND NOT internal_control AND runtime_history_available(h.execution_id) ORDER BY revision DESC LIMIT p_limit) x;
  RETURN answer;
 ELSIF p_action='freeze' THEN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>1000 THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  SELECT coalesce(array_agg(v::bigint ORDER BY v::bigint),ARRAY[]::bigint[]) INTO selected FROM jsonb_array_elements_text(p_items) v;
  IF e.selected_history IS NOT NULL THEN
   IF e.selected_history IS DISTINCT FROM selected THEN RAISE EXCEPTION 'RUNTIME_HISTORY_CHANGED';END IF;
   RETURN to_jsonb(selected);
  END IF;
  IF cardinality(selected)>greatest(0,least(1000,coalesce((e.payload->>'historyItems')::int,0)))
   OR cardinality(selected)<>(SELECT count(DISTINCT v) FROM unnest(selected) v)
   OR NOT selected<@e.candidate_history
   OR cardinality(selected)<>(SELECT count(*) FROM runtime_session_history h WHERE h.session_id=s.id AND h.revision=ANY(selected) AND runtime_history_available(h.execution_id))
   OR EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=e.billing_run_id AND payload->>'phase'<>'skill_matching')
  THEN RAISE EXCEPTION 'RUNTIME_HISTORY_SELECTION';END IF;
  UPDATE runtime_executions SET selected_history=selected WHERE id=e.id;
  INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
   SELECT DISTINCT e.id,h.execution_id FROM runtime_session_history h WHERE h.session_id=s.id AND h.revision=ANY(selected);
  RETURN to_jsonb(selected);
 ELSIF p_action='append' THEN
  IF EXISTS(SELECT 1 FROM bill2_runs WHERE id=e.billing_run_id AND (cancel_requested OR closed)) THEN RAISE EXCEPTION 'RUNTIME_SESSION_CLOSED';END IF;
  IF s.active_execution IS DISTINCT FROM e.id OR e.state IN ('completed','cancelled') THEN RAISE EXCEPTION 'RUNTIME_SESSION_CLOSED';END IF;
  IF p_batch IS NULL OR p_batch<0 OR jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items)>128 THEN RAISE EXCEPTION 'RUNTIME_SESSION_BATCH';END IF;
  SELECT * INTO b FROM runtime_session_batches WHERE execution_id=e.id AND batch=p_batch;
  IF b.execution_id IS NOT NULL THEN
   IF b.items IS DISTINCT FROM p_items THEN RAISE EXCEPTION 'RUNTIME_SESSION_CONFLICT';END IF;
   RETURN 'null'::jsonb;
  END IF;
  IF p_batch<>(SELECT count(*) FROM runtime_session_batches WHERE execution_id=e.id) THEN RAISE EXCEPTION 'RUNTIME_SESSION_BATCH_ORDER';END IF;
  n:=jsonb_array_length(p_items);
  INSERT INTO runtime_session_batches VALUES(s.id,e.id,p_batch,p_items,s.revision,s.revision+n);
  INSERT INTO runtime_session_history(session_id,revision,execution_id,item,internal_control)
   SELECT s.id,s.revision+ordinality,e.id,value,(e.payload ? 'matching' AND p_batch=0) FROM jsonb_array_elements(p_items) WITH ORDINALITY;
  UPDATE runtime_sessions SET revision=revision+n WHERE id=s.id;
  RETURN 'null'::jsonb;
 END IF;
 RAISE EXCEPTION 'RUNTIME_SESSION_ACTION';
END $$;

CREATE OR REPLACE FUNCTION public.runtime_session_context(p_actor_id uuid,p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;e runtime_executions;chosen jsonb;m runtime_scope_material;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT * INTO e FROM runtime_executions WHERE session_id=s.id AND payload->>'role' IN ('ordinary','skill')
  AND (result->>'body' IS NOT NULL OR primary_result->>'body' IS NOT NULL) AND runtime_history_available(id) ORDER BY created_at DESC,id LIMIT 1;
 SELECT c INTO chosen FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key';
 SELECT * INTO m FROM runtime_scope_material WHERE session_id=s.id ORDER BY revision DESC LIMIT 1;
 RETURN jsonb_build_object('scopeMaterial',CASE WHEN m.session_id IS NOT NULL AND NOT m.revoked THEN jsonb_build_object('sessionId',m.session_id,'revision',m.revision,'hash',m.content_hash,'content',m.content) ELSE NULL END,'materialRevision',coalesce(m.revision,0),'scope',s.scope,'dialogueModelId',coalesce(chosen->>'modelId',e.payload->>'modelId'),'dialogueModel',coalesce(chosen->>'model',e.payload->>'model'));
END $$;
CREATE OR REPLACE FUNCTION public.runtime_admission_replay(p_actor_id uuid,p_request_id uuid,p_request jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE actor_id=p_actor_id AND request_id=p_request_id;
 IF e.id IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id;
 IF NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 IF e.payload->'request' IS DISTINCT FROM p_request THEN RAISE EXCEPTION 'RUNTIME_REQUEST_CONFLICT';END IF;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',e.billing_run_id,'state',e.state);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_tool(p_actor_id uuid,p_execution_id uuid,p_call_id text,p_name text,p_arguments jsonb,p_action text,p_result jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;b bill2_runs;t runtime_tool_calls;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_TOOL_DENIED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,b.payload,b.id);
 IF NOT coalesce(e.payload->'tools' ? p_name,false) OR p_name NOT IN ('search','read_source')
 OR (p_name='search' AND e.payload->>'network'='deny')
 OR jsonb_typeof(p_arguments) IS DISTINCT FROM 'object'
 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_arguments) k WHERE k<>'query')
 THEN RAISE EXCEPTION 'RUNTIME_TOOL_DENIED';END IF;
 SELECT * INTO t FROM runtime_tool_calls WHERE execution_id=e.id AND call_id=p_call_id;
 IF t.execution_id IS NOT NULL THEN
  IF t.name<>p_name OR t.arguments IS DISTINCT FROM p_arguments THEN RAISE EXCEPTION 'RUNTIME_TOOL_CONFLICT';END IF;
  IF p_action='complete' THEN
   IF b.closed OR b.cancel_requested THEN RAISE EXCEPTION 'RUNTIME_TOOL_CLOSED';END IF;
   IF t.result IS NOT NULL AND t.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_TOOL_RESULT_CONFLICT';END IF;
   IF p_result IS NULL THEN RAISE EXCEPTION 'RUNTIME_TOOL_RESULT_REQUIRED';END IF;
   UPDATE runtime_tool_calls SET result=p_result WHERE execution_id=e.id AND call_id=p_call_id;
   RETURN jsonb_build_object('execute',false,'result',p_result);
  END IF;
  RETURN jsonb_build_object('execute',false,'result',t.result);
 END IF;
 IF p_action<>'claim' OR b.closed OR b.cancel_requested OR e.state<>'running'
 OR (SELECT count(*) FROM runtime_tool_calls WHERE execution_id=e.id)>=coalesce((e.payload->>'maxToolCalls')::int,0)
 THEN RAISE EXCEPTION 'RUNTIME_TOOL_LIMIT';END IF;
 INSERT INTO runtime_tool_calls(execution_id,call_id,name,arguments) VALUES(e.id,p_call_id,p_name,p_arguments);
 RETURN jsonb_build_object('execute',true,'result',NULL);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_view(p_actor_id uuid,p_session_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;items jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('executionId',e.id,'state',e.state,
  'input',CASE WHEN runtime_history_available(e.id) THEN e.payload->>'input' ELSE NULL END,
  'body',CASE WHEN runtime_history_available(e.id) THEN e.result->>'body' ELSE NULL END,
  'primaryBody',CASE WHEN runtime_history_available(e.id) THEN e.primary_result->>'body' ELSE NULL END,
  'organizerComplete',e.result ? 'summary',
  'summary',CASE WHEN runtime_history_available(e.id) THEN e.result->>'summary' ELSE NULL END,
  'needsTask',coalesce((SELECT (c->>'requiresTask')::boolean FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->>'key'=e.match_result->>'key'),false),
  'unavailableReason',e.unavailable_reason,
  'contentAvailable',runtime_history_available(e.id),'billing',bill2_public(b)) ORDER BY e.created_at,e.id),'[]') INTO items
 FROM runtime_executions e JOIN bill2_runs b ON b.id=e.billing_run_id WHERE e.session_id=s.id;
 RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope,'activeExecution',s.active_execution,'executions',items);
END $$;

-- Private server execution recovery. Reading preserved responses never authorizes dispatch.
CREATE OR REPLACE FUNCTION public.runtime_execution(p_actor_id uuid,p_execution_id uuid,p_action text,p_result jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s runtime_sessions;e runtime_executions;b bill2_runs;live boolean:=false;v jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 IF e.unavailable_reason IS NOT NULL AND p_action IN ('begin','read') THEN
  RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',b.id,'state',e.state,'live',false,'cancelRequested',true,'result',NULL);
 END IF;
 IF NOT runtime_history_available(e.id) THEN RAISE EXCEPTION 'RUNTIME_CONTEXT_REVOKED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,b.payload,b.id);
 IF p_action='begin' THEN
  IF e.state='prepared' AND s.active_execution=e.id THEN
   UPDATE runtime_executions SET state='running' WHERE id=e.id RETURNING * INTO e;live:=true;
  END IF;
 ELSIF p_action='fail_before_dispatch' THEN
  IF e.state IN ('prepared','running','interrupted') AND NOT EXISTS(SELECT 1 FROM bill2_calls WHERE run_id=b.id AND dispatched_at IS NOT NULL) THEN
   v:=bill2_cancel(p_actor_id,b.id);v:=bill2_finalize(p_actor_id,b.id);
   UPDATE runtime_executions SET state='cancelled' WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id;
  END IF;
 ELSIF p_action='interrupt' THEN
  IF e.state='running' THEN UPDATE runtime_executions SET state='interrupted' WHERE id=e.id RETURNING * INTO e;END IF;
 ELSIF p_action='checkpoint_match' THEN
  IF s.active_execution IS DISTINCT FROM e.id OR b.closed OR b.cancel_requested
   OR e.state NOT IN ('running','interrupted') OR NOT (e.payload ? 'matching')
   OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR NOT (p_result ? 'key')
   OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_result) k WHERE k<>'key')
   OR (p_result->'key'<>'null'::jsonb AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.payload->'matching'->'candidates') c WHERE c->'key'=p_result->'key'))
   OR NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id AND batch=0)
  THEN RAISE EXCEPTION 'RUNTIME_MATCH_DENIED';END IF;
  IF e.match_result IS NOT NULL AND e.match_result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_MATCH_CONFLICT';END IF;
  UPDATE runtime_executions SET match_result=p_result WHERE id=e.id RETURNING * INTO e;
 ELSIF p_action='check_latest' THEN
  IF e.payload->>'network'='require_latest' AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls WHERE execution_id=e.id AND name='search' AND result IS NOT NULL) THEN
   v:=bill2_cancel(p_actor_id,b.id);v:=bill2_finalize(p_actor_id,b.id);
   UPDATE runtime_executions SET unavailable_reason='latest_unavailable',state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'cancelled' ELSE 'cost_pending' END WHERE id=e.id RETURNING * INTO e;
   IF e.state='cancelled' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
   RETURN jsonb_build_object('state',e.state,'unavailable',true);
  END IF;
 ELSIF p_action='checkpoint_primary' THEN
  IF s.active_execution IS DISTINCT FROM e.id OR b.closed OR b.cancel_requested
   OR e.state NOT IN ('running','interrupted') OR NOT (e.payload ? 'attachedOrganizer')
   OR jsonb_typeof(p_result) IS DISTINCT FROM 'object' OR jsonb_typeof(p_result->'body') IS DISTINCT FROM 'string'
   OR length(p_result->>'body')=0 OR octet_length(p_result::text)>262144
   OR jsonb_typeof(p_result->'lastSequence') IS DISTINCT FROM 'number'
   OR coalesce(p_result->>'lastSequence','') !~ '^[1-9][0-9]*$'
   OR (p_result->>'lastSequence')::int<1
   OR (p_result->>'lastSequence')::int>(SELECT count(*) FROM bill2_calls WHERE run_id=b.id)
   OR NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id)
  THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_DENIED';END IF;
  IF e.primary_result IS NOT NULL AND e.primary_result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
  UPDATE runtime_executions SET primary_result=p_result WHERE id=e.id RETURNING * INTO e;
 ELSIF p_action='complete' THEN
  IF b.cancel_requested THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_CANCELLED';END IF;
  IF e.payload->>'network'='require_latest' AND NOT EXISTS(SELECT 1 FROM runtime_tool_calls WHERE execution_id=e.id AND name='search' AND result IS NOT NULL) THEN RAISE EXCEPTION 'RUNTIME_LATEST_UNAVAILABLE';END IF;
  IF e.primary_result IS NOT NULL AND e.primary_result->>'body' IS DISTINCT FROM p_result->>'body' THEN RAISE EXCEPTION 'RUNTIME_CHECKPOINT_CONFLICT';END IF;
  IF e.payload ? 'attachedOrganizer' AND (e.primary_result IS NULL OR jsonb_typeof(p_result->'summary') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'RUNTIME_ORGANIZER_PENDING';END IF;
  IF e.state='completed' THEN
   IF e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
  ELSE
   IF s.active_execution IS DISTINCT FROM e.id OR jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR p_result->>'kind' IS DISTINCT FROM 'usable_result' THEN RAISE EXCEPTION 'RUNTIME_RESULT_DENIED';END IF;
   IF NOT EXISTS(SELECT 1 FROM runtime_session_batches WHERE execution_id=e.id) THEN RAISE EXCEPTION 'RUNTIME_SESSION_PENDING';END IF;
   v:=bill2_close(p_actor_id,b.id,'delivered',p_result);
   v:=bill2_finalize(p_actor_id,b.id);
   IF e.result IS NOT NULL AND e.result IS DISTINCT FROM p_result THEN RAISE EXCEPTION 'RUNTIME_RESULT_CONFLICT';END IF;
   UPDATE runtime_executions SET state=CASE WHEN v->>'state' IN ('settled','refunded') THEN 'completed' ELSE 'cost_pending' END,result=p_result WHERE id=e.id RETURNING * INTO e;
   IF e.state='completed' THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
  END IF;
 ELSIF p_action<>'read' THEN RAISE EXCEPTION 'RUNTIME_ACTION_DENIED';END IF;
 RETURN jsonb_build_object('executionId',e.id,'sessionId',s.id,'runId',b.id,'state',e.state,
  'live',live,'cancelRequested',b.cancel_requested,'context',e.payload,'billing',b.payload,'result',e.result,'primaryResult',e.primary_result,'matchResult',e.match_result);
END $$;
-- Private original-identity receipt inspection does not authorize content access.
CREATE OR REPLACE FUNCTION public.runtime_receipt_saved(p_actor_id uuid,p_execution_id uuid,p_run_id uuid,p_call_id uuid,p_evidence jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id
  JOIN bill2_calls c ON c.run_id=r.id WHERE e.id=p_execution_id AND e.actor_id=p_actor_id
  AND r.actor_id=p_actor_id AND r.id=p_run_id AND r.session_ref=e.session_id AND c.id=p_call_id)
 THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 RETURN EXISTS(SELECT 1 FROM bill2_receipts WHERE call_id=p_call_id AND payload=p_evidence);
END $$;
CREATE OR REPLACE FUNCTION public.runtime_response(p_actor_id uuid,p_execution_id uuid,p_sequence integer,p_request_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;c bill2_calls;raw text;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id;
 IF e.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_RESPONSE_DENIED';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,(SELECT payload FROM bill2_runs WHERE id=e.billing_run_id),e.billing_run_id);
 SELECT * INTO c FROM bill2_calls WHERE run_id=e.billing_run_id AND sequence=p_sequence;
 IF c.id IS NULL THEN RETURN NULL;END IF;
 IF c.payload->>'requestHash' IS DISTINCT FROM p_request_hash THEN RAISE EXCEPTION 'RUNTIME_RESPONSE_CONFLICT';END IF;
 SELECT payload->>'rawBody' INTO raw FROM bill2_receipts WHERE call_id=c.id
  AND payload->>'source'='response' AND payload->>'evidenceKind' IS DISTINCT FROM 'transport_observation'
  AND payload->>'rejectedReason' IS NULL ORDER BY created_at LIMIT 1;
 RETURN jsonb_build_object('callId',c.id,'state',c.state,'rawBody',raw);
END $$;

CREATE OR REPLACE FUNCTION public.runtime_direct_billing_allowed(a uuid,p jsonb,p_run_id uuid) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE v jsonb;m uuid;k uuid;rev uuid; policy jsonb; entry jsonb; chosen jsonb;matched jsonb;
BEGIN
 PERFORM bill2_actor(a);
 PERFORM runtime_context_allowed(a,p->'input');
 IF p->'scope'->>'kind'='positioning_draft' THEN
  PERFORM id FROM bill2_drafts WHERE id=(p->'scope'->>'draftId')::uuid AND actor_id=a AND NOT revoked FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 ELSE
  -- Match artifact_create_work / reference save order: config, source, account, target.
  PERFORM cfg.id FROM artifact_reference_configs cfg WHERE cfg.id IN (SELECT config_id FROM artifact_work_references WHERE project_id=(p->'scope'->>'workItemId')::uuid) ORDER BY cfg.id FOR SHARE;
  PERFORM id FROM artifact_projects WHERE id=(p->'scope'->>'projectId')::uuid FOR SHARE;
  PERFORM ac.actor_id FROM artifact_accounts ac JOIN artifact_projects src ON src.id=(p->'scope'->>'projectId')::uuid
   WHERE ac.actor_id=src.actor_id AND ac.module_id=src.module_id AND ac.skill_id=src.skill_id AND ac.account=src.account FOR KEY SHARE OF ac;
  PERFORM id FROM artifact_projects WHERE id=(p->'scope'->>'workItemId')::uuid FOR SHARE;
 END IF;
 IF NOT coalesce(bill2_scope_allowed(a,p->'scope'),false) THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 policy:=p->'callPolicy';
 IF jsonb_typeof(policy) IS DISTINCT FROM 'array' OR jsonb_array_length(policy) NOT BETWEEN 1 AND 32 THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_REQUIRED';END IF;
 IF p->'input' ? 'matching' THEN
  SELECT e.match_result INTO matched FROM runtime_executions e JOIN bill2_runs r ON r.id=e.billing_run_id WHERE e.actor_id=a AND r.id=p_run_id AND r.actor_id=a AND r.payload=p;
  SELECT c INTO chosen FROM jsonb_array_elements(p->'input'->'matching'->'candidates') c WHERE c->>'key'=matched->>'key';
 END IF;
 FOR entry IN SELECT value FROM jsonb_array_elements(policy) ORDER BY value->>'modelId' LOOP
  -- After the immutable choice, unused candidate models are not dependencies.
  -- The insertion guard below prevents claims against these unused policies.
  IF matched IS NOT NULL AND entry->>'modelId' IS DISTINCT FROM p->>'modelId'
   AND entry->>'modelId' IS DISTINCT FROM chosen->>'modelId'
   AND entry->>'modelId' IS DISTINCT FROM p->'input'->'attachedOrganizer'->>'modelId' THEN CONTINUE;END IF;
  PERFORM id FROM ai_models WHERE id=(entry->>'modelId')::uuid AND model_id=entry->>'model' AND provider=entry->>'provider' AND is_active='true' FOR SHARE;
  IF NOT FOUND OR entry->>'protocol' IS DISTINCT FROM 'fixture-cost-v1' OR coalesce(length(entry->>'account'),0)=0
  OR coalesce((entry->>'inputLimit')::int,0) NOT BETWEEN 1 AND 1000000 OR coalesce((entry->>'outputLimit')::int,0) NOT BETWEEN 1 AND 1000000
  OR bill2_decimal(entry->'upperUsd')<=0 OR entry->'automaticRetry' IS DISTINCT FROM 'false'::jsonb OR entry->'hiddenTools' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(entry->'lookupSupported') IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'BILL2_CALL_POLICY_DENIED';END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy) x WHERE x->>'modelId'=p->>'modelId') THEN RAISE EXCEPTION 'BILL2_MODEL_DENIED';END IF;
 rev:=(p->>'revisionId')::uuid;
 IF rev IS NOT NULL THEN
  m:=(p->>'moduleId')::uuid;k:=(p->>'skillId')::uuid;
  -- Preserve omitted-identity 0105 work requests only when no Runtime binding
  -- exists. runtime_admit requires both selected IDs before calling BILL2;
  -- no payload mode/version flag can opt a Runtime execution into this fallback.
  IF (m IS NULL OR k IS NULL) AND p->'scope'->>'kind'='work_item'
   AND NOT EXISTS(SELECT 1 FROM runtime_executions WHERE billing_run_id=p_run_id) THEN
   SELECT module_id,skill_id INTO m,k FROM artifact_projects WHERE id=(p->'scope'->>'workItemId')::uuid;
  END IF;
  -- Scope ownership/account/source checks above are independent of the
  -- explicitly selected Skill; never replace its identity with the work owner.
  IF EXISTS(SELECT 1 FROM runtime_executions WHERE billing_run_id=p_run_id AND actor_id=a) THEN
   PERFORM id FROM modules WHERE id=m AND skill_id=k AND active AND model_id=(p->>'modelId')::uuid FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_SKILL_MODEL_DENIED';END IF;
  ELSE
   PERFORM id FROM modules WHERE id=m FOR SHARE;
  END IF;
  PERFORM id FROM skills WHERE id=k FOR SHARE;
  PERFORM id FROM skill_revisions WHERE id=rev AND skill_id=k FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_REVISION_DENIED';END IF;
  PERFORM read_skill_package(a,m,k,rev,NULL,'');
 END IF;
 -- The original frozen plan remains immutable. A later selection can only
 -- activate one of its candidates and must remain available on every access.
 IF p->'input' ? 'matching' THEN
  SELECT c INTO chosen FROM runtime_executions e,
   LATERAL jsonb_array_elements(e.payload->'matching'->'candidates') c
   WHERE e.actor_id=a AND e.billing_run_id=p_run_id AND EXISTS(SELECT 1 FROM bill2_runs r WHERE r.id=p_run_id AND r.actor_id=a AND r.payload=p)
    AND c->>'key'=e.match_result->>'key';
  IF chosen IS NOT NULL THEN
   m:=(chosen->>'moduleId')::uuid;k:=(chosen->>'skillId')::uuid;rev:=(chosen->>'revisionId')::uuid;
   PERFORM id FROM modules WHERE id=m AND active AND model_id=(chosen->>'modelId')::uuid FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_MATCH_REVOKED';END IF;
   PERFORM id FROM skills WHERE id=k FOR SHARE;
   PERFORM id FROM skill_revisions WHERE id=rev AND skill_id=k FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'RUNTIME_MATCH_REVOKED';END IF;
   PERFORM read_skill_package(a,m,k,rev,chosen->>'packageHash','');
  END IF;
 END IF;
END $$;

-- Unbound BILL2 admission always checks the full frozen policy. Only a server
-- path holding the real run identity may resolve a Runtime choice.
-- Final claim/dispatch/private-input authority covers the frozen history lineage,
-- not just direct sources. UNION visits each ancestor once, even for shared
-- dependencies; this avoids recursively revalidating the same dense graph.
CREATE OR REPLACE FUNCTION public.runtime_billing_allowed(a uuid,p jsonb,p_run_id uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;dependency record;
BEGIN
 PERFORM runtime_direct_billing_allowed(a,p,p_run_id);
 SELECT * INTO e FROM runtime_executions WHERE billing_run_id=p_run_id AND actor_id=a;
 IF e.id IS NULL THEN RETURN;END IF;
 IF e.unavailable_reason IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_HISTORY_UNAVAILABLE';END IF;
 PERFORM runtime_context_allowed(a,e.payload);
 FOR dependency IN
  WITH RECURSIVE lineage(id) AS (
   SELECT dependency_id FROM runtime_history_dependencies WHERE execution_id=e.id
   UNION SELECT d.dependency_id FROM runtime_history_dependencies d JOIN lineage l ON d.execution_id=l.id
  )
  SELECT x.actor_id,x.unavailable_reason,x.payload runtime_payload,r.id run_id,r.payload
  FROM lineage l JOIN runtime_executions x ON x.id=l.id JOIN bill2_runs r ON r.id=x.billing_run_id ORDER BY x.id
 LOOP
  IF dependency.actor_id<>a OR dependency.unavailable_reason IS NOT NULL THEN RAISE EXCEPTION 'RUNTIME_HISTORY_UNAVAILABLE';END IF;
  PERFORM runtime_direct_billing_allowed(a,dependency.payload,dependency.run_id);
  PERFORM runtime_context_allowed(a,dependency.runtime_payload);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.bill2_execution_allowed(a uuid,p jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN PERFORM runtime_billing_allowed(a,p,NULL);END $$;

CREATE OR REPLACE FUNCTION public.bill2_claim(p_actor_id uuid,p_run_id uuid,p_sequence integer,p_payload jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;n integer;used numeric;upper_cost numeric;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NOT NULL THEN PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);END IF;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=r.deadline THEN RAISE EXCEPTION 'BILL2_DISPATCH_CLOSED';END IF;
 SELECT * INTO c FROM bill2_calls WHERE run_id=r.id AND sequence=p_sequence;
 IF c.id IS NOT NULL THEN IF c.payload IS DISTINCT FROM p_payload THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF;
  RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',NULL);END IF;
 SELECT count(*),coalesce(sum(CASE WHEN state='cancelled' THEN 0 ELSE coalesce(selected_cost_usd,upper_usd) END),0) INTO n,used FROM bill2_calls WHERE run_id=r.id;
 upper_cost:=bill2_decimal(p_payload->'upperUsd');
 IF p_sequence IS DISTINCT FROM n+1 OR n>=r.max_calls OR upper_cost<=0 OR used+upper_cost>r.budget_usd OR ceil((used+upper_cost)*r.credits_per_usd*r.multiplier)>r.reserved
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.payload->'callPolicy') policy WHERE policy->>'provider'=p_payload->>'provider' AND policy->>'account'=p_payload->>'account' AND policy->>'model'=p_payload->>'model' AND policy->>'protocol'=p_payload->>'protocol' AND (p_payload->>'inputLimit')::int<=(policy->>'inputLimit')::int AND (p_payload->>'outputLimit')::int<=(policy->>'outputLimit')::int AND upper_cost<=bill2_decimal(policy->'upperUsd') AND policy->'lookupSupported'=p_payload->'lookupSupported')
 OR coalesce(length(p_payload->>'provider'),0)=0 OR coalesce(length(p_payload->>'account'),0)=0 OR coalesce(length(p_payload->>'model'),0)=0
 OR coalesce(p_payload->>'requestHash','') !~ '^[a-f0-9]{64}$' OR p_payload->>'protocol' IS DISTINCT FROM 'fixture-cost-v1'
 OR (p_payload->>'inputLimit') IS NULL OR (p_payload->>'inputLimit')::integer<=0 OR (p_payload->>'outputLimit') IS NULL OR (p_payload->>'outputLimit')::integer<=0
 OR p_payload->>'automaticRetry' IS DISTINCT FROM 'false' OR p_payload->>'hiddenTools' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'BILL2_CALL_BUDGET_OR_CONTRACT';END IF;
 INSERT INTO bill2_calls(run_id,sequence,payload,provider,account_namespace,model,upper_usd) VALUES(r.id,p_sequence,p_payload,p_payload->>'provider',p_payload->>'account',p_payload->>'model',upper_cost) RETURNING * INTO c;
 RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',c.token);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_dispatch(p_actor_id uuid,p_run_id uuid,p_call_id uuid,p_token uuid,p_rotate boolean DEFAULT false,p_payload jsonb DEFAULT NULL) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;c bill2_calls;
BEGIN
 SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF r.id IS NOT NULL THEN PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);END IF;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_RUN_DENIED' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM bill2_calls WHERE id=p_call_id AND run_id=r.id FOR UPDATE;
 IF c.id IS NULL THEN RAISE EXCEPTION 'BILL2_CALL_DENIED';END IF;
 IF r.closed OR r.cancel_requested OR r.conflict OR clock_timestamp()>=r.deadline OR c.state<>'prepared' OR (NOT p_rotate AND c.token IS DISTINCT FROM p_token) THEN RETURN jsonb_build_object('dispatch',false);END IF;
 -- Final permission check serializes a concurrent account suspension before any HTTP grant.
 PERFORM id FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted='false' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'BILL2_ACTOR_DENIED' USING ERRCODE='42501';END IF;
 IF p_rotate THEN IF p_payload IS DISTINCT FROM c.payload THEN RAISE EXCEPTION 'BILL2_CALL_CONFLICT';END IF; UPDATE bill2_calls SET token=gen_random_uuid() WHERE id=c.id RETURNING * INTO c;
  RETURN jsonb_build_object('dispatch',false,'dispatchToken',c.token);END IF;
 UPDATE bill2_calls SET state='dispatched',dispatched_at=clock_timestamp() WHERE id=c.id;
 UPDATE bill2_runs SET state='dispatched',version=version+1 WHERE id=r.id;
 RETURN jsonb_build_object('dispatch',true);
END $$;

CREATE OR REPLACE FUNCTION public.bill2_private_input(p_actor_id uuid,p_run_id uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;BEGIN PERFORM bill2_actor(p_actor_id);SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id;
 IF r.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,r.scope),false) THEN RAISE EXCEPTION 'BILL2_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);
 RETURN jsonb_build_object('input',r.payload->'input','result',r.result);END $$;

CREATE OR REPLACE FUNCTION public.runtime_matching_call_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;c jsonb;wanted text;phase text;selected_policy jsonb;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE billing_run_id=NEW.run_id;
 IF e.id IS NULL OR NOT (e.payload ? 'matching') THEN RETURN NEW;END IF;
 phase:=NEW.payload->>'phase';
 IF NEW.sequence=1 THEN
  IF phase IS DISTINCT FROM 'skill_matching' THEN RAISE EXCEPTION 'RUNTIME_MATCH_CALL_DENIED';END IF;
  wanted:=e.payload->>'modelId';
 ELSE
  IF e.match_result IS NULL THEN RAISE EXCEPTION 'RUNTIME_MATCH_PENDING';END IF;
  SELECT x INTO c FROM jsonb_array_elements(e.payload->'matching'->'candidates') x WHERE x->>'key'=e.match_result->>'key';
  IF coalesce((c->>'requiresTask')::boolean,false) THEN RAISE EXCEPTION 'RUNTIME_SKILL_TASK_REQUIRED';END IF;
  IF phase='attached_organizer' AND e.primary_result IS NOT NULL THEN wanted:=e.payload->'attachedOrganizer'->>'modelId';
  ELSIF phase=(CASE WHEN c IS NULL THEN 'ordinary' ELSE 'skill' END)
   OR (phase='tool:search' AND e.payload->'tools' ? 'search' AND e.payload->>'network'<>'deny') THEN wanted:=coalesce(c->>'modelId',e.payload->>'modelId');
  ELSE RAISE EXCEPTION 'RUNTIME_MATCH_CALL_DENIED';END IF;
 END IF;
 SELECT x INTO selected_policy FROM bill2_runs r,LATERAL jsonb_array_elements(r.payload->'callPolicy') x WHERE r.id=NEW.run_id AND x->>'modelId'=wanted;
 IF selected_policy IS NULL
 OR NEW.payload->>'provider' IS DISTINCT FROM selected_policy->>'provider'
 OR NEW.payload->>'account' IS DISTINCT FROM selected_policy->>'account'
 OR NEW.payload->>'model' IS DISTINCT FROM selected_policy->>'model'
 OR NEW.payload->>'protocol' IS DISTINCT FROM selected_policy->>'protocol'
 OR NEW.payload->'lookupSupported' IS DISTINCT FROM selected_policy->'lookupSupported'
 OR (NEW.payload->>'inputLimit')::int>(selected_policy->>'inputLimit')::int
 OR (NEW.payload->>'outputLimit')::int>(selected_policy->>'outputLimit')::int
 OR bill2_decimal(NEW.payload->'upperUsd')>bill2_decimal(selected_policy->'upperUsd') THEN RAISE EXCEPTION 'RUNTIME_MATCH_CALL_DENIED';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runtime_matching_call_guard ON bill2_calls;
CREATE TRIGGER runtime_matching_call_guard BEFORE INSERT ON bill2_calls FOR EACH ROW EXECUTE FUNCTION runtime_matching_call_guard();

-- Explicit user cancellation closes future dispatch while retaining partial output.
CREATE OR REPLACE FUNCTION public.runtime_cancel(p_actor_id uuid,p_execution_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED';END IF;
 v:=bill2_cancel(p_actor_id,b.id);v:=bill2_finalize(p_actor_id,b.id);
 UPDATE runtime_executions SET state=CASE WHEN v->>'state' IN ('settled','refunded')
  THEN CASE WHEN result IS NULL THEN 'cancelled' ELSE 'completed' END ELSE 'cost_pending' END WHERE id=e.id RETURNING * INTO e;
 IF e.state IN ('cancelled','completed') THEN UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;END IF;
 RETURN jsonb_build_object('executionId',e.id,'state',e.state,'billing',v);
END $$;

-- Financial maintenance never returns execution content or grants dispatch rights.
CREATE OR REPLACE FUNCTION public.runtime_financial_recovery(p_actor_id uuid,p_execution_id uuid,p_finish boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;b bill2_runs;v jsonb;
BEGIN
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id;
 IF e.id IS NULL THEN RAISE EXCEPTION 'RUNTIME_EXECUTION_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO e FROM runtime_executions WHERE id=p_execution_id AND actor_id=p_actor_id FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id AND actor_id=p_actor_id FOR UPDATE;
 IF s.id IS NULL OR b.id IS NULL OR b.session_ref IS DISTINCT FROM e.session_id THEN RAISE EXCEPTION 'RUNTIME_BINDING_DENIED';END IF;
 IF e.result IS NULL AND runtime_history_available(e.id) AND e.state NOT IN ('cancelled','cost_pending') THEN
  RAISE EXCEPTION 'RUNTIME_EXECUTION_STILL_ALLOWED';
 END IF;
 IF p_finish THEN
  IF e.result IS NOT NULL THEN v:=bill2_close(p_actor_id,b.id,'delivered',e.result);
  ELSE v:=bill2_cancel(p_actor_id,b.id);END IF;
  v:=bill2_finalize(p_actor_id,b.id);
  IF v->>'state' IN ('settled','refunded') THEN
   UPDATE runtime_executions SET state=CASE WHEN result IS NULL THEN 'cancelled' ELSE 'completed' END WHERE id=e.id RETURNING * INTO e;
   UPDATE runtime_sessions SET active_execution=NULL WHERE id=s.id AND active_execution=e.id;
  ELSE
   UPDATE runtime_executions SET state='cost_pending' WHERE id=e.id RETURNING * INTO e;
  END IF;
 ELSE v:=bill2_public(b);END IF;
 RETURN jsonb_build_object('executionId',e.id,'runId',b.id,'state',e.state,'billing',v);
END $$;

DO $$ DECLARE t text;f record;BEGIN
 FOREACH t IN ARRAY ARRAY['runtime_scope_material','runtime_sessions','runtime_executions','runtime_session_batches','runtime_session_history','runtime_tool_calls','runtime_history_dependencies'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
 END LOOP;
 FOR f IN SELECT oid::regprocedure sig,proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'runtime_%' LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f.sig);
  IF f.proname IN ('runtime_material','runtime_start','runtime_admit','runtime_session_items','runtime_execution','runtime_response','runtime_receipt_saved','runtime_session_context','runtime_admission_replay','runtime_tool','runtime_source','runtime_view','runtime_financial_recovery','runtime_cancel') THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f.sig);END IF;
 END LOOP;
END $$;
COMMIT;
