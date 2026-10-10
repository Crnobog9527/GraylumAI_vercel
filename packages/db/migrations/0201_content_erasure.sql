-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- D7: object-local deletion authority; account closure semantics stay unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.runtime_executions ADD COLUMN IF NOT EXISTS content_deleted_at timestamptz;
ALTER TABLE public.runtime_sessions ADD COLUMN IF NOT EXISTS content_deleted_at timestamptz;
ALTER TABLE public.artifact_projects ADD COLUMN IF NOT EXISTS content_deleted_at timestamptz;
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS content_deleted_at timestamptz;

CREATE OR REPLACE FUNCTION public.content_erasure_financial_allowed(a uuid,pre uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs;
BEGIN
 IF bill2_erasure_closed(a,pre) THEN RETURN true; END IF;
 SELECT * INTO r FROM bill2_runs WHERE actor_id=a AND content_deleted_at IS NOT NULL
  AND ((contract_version='bill2.v1' AND pre_deduct_id=pre) OR (contract_version='bill2.v2' AND id=pre));
 RETURN r.id IS NOT NULL AND bill2_payg_financial_binding(r);
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_financial_allowed(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- Reuse the exact existing money projections and original-call recovery. The new
-- authority is a marker on that original run, never a claim that its account closed.
DO $$
DECLARE sig text; source text;
BEGIN
 FOREACH sig IN ARRAY ARRAY[
  'bill2_evidence_immutable()', 'bill2_record(uuid,uuid,uuid,jsonb)',
  'bill2_close(uuid,uuid,text,jsonb)', 'bill2_read(uuid,uuid)',
  'bill2_payg_finalize(uuid,uuid)',
  'bill2_revoke_unstarted_dispatch(uuid,uuid,uuid,uuid,text,boolean)',
  'runtime_receipt_saved(uuid,uuid,uuid,uuid,jsonb)', 'runtime_financial_recovery(uuid,uuid,boolean)',
  'bill2_run_erasure_guard()', 'bill2_call_erasure_guard()',
  'account_erasure_scrub_receipts(uuid,uuid,integer)', 'account_erasure_scrub_run(uuid,uuid)',
  'account_erasure_scrub_calls(uuid,uuid)'
 ] LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('content_erasure_financial_allowed(' IN source)=0 THEN
   IF position('bill2_erasure_closed(' IN source)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: %',sig; END IF;
   EXECUTE replace(source,'bill2_erasure_closed(','content_erasure_financial_allowed(');
  END IF;
 END LOOP;
END $$;

-- Content deletion is not account closure, including in internal financial views.
CREATE OR REPLACE FUNCTION public.bill2_erasure_view(r bill2_runs,is_closed boolean)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT CASE WHEN is_closed THEN (bill2_public(r)-'scope')||jsonb_build_object(
  'accountClosed',bill2_erasure_closed(r.actor_id,coalesce(r.pre_deduct_id,r.id)),
  'contentDeleted',r.content_deleted_at IS NOT NULL) ELSE bill2_public(r) END;
$$;
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('public.runtime_financial_recovery(uuid,uuid,boolean)'::regprocedure);
 source:=replace(source,$old$(bill2_public(b)-'scope')||'{"accountClosed":true}'::jsonb$old$,
  'bill2_erasure_view(b,true)');
 source:=replace(source,$old$(v-'scope')||'{"accountClosed":true}'::jsonb$old$,
  $new$(v-'scope')||jsonb_build_object('accountClosed',bill2_erasure_closed(b.actor_id,coalesce(b.pre_deduct_id,b.id)),
   'contentDeleted',b.content_deleted_at IS NOT NULL)$new$);
 EXECUTE source;
END $$;

-- Markers may only advance, through owner-executed functions. They carry no body.
CREATE OR REPLACE FUNCTION public.content_erasure_marker_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.content_deleted_at IS NOT NULL THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_MARKER_DENIED' USING ERRCODE='42501';
 ELSIF TG_OP='UPDATE' THEN
  IF OLD.content_deleted_at IS NOT NULL AND NEW.content_deleted_at IS DISTINCT FROM OLD.content_deleted_at
   OR OLD.content_deleted_at IS NULL AND NEW.content_deleted_at IS NOT NULL
    AND current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID)) THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_MARKER_DENIED' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['runtime_executions','runtime_sessions','artifact_projects','bill2_runs'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS content_erasure_marker_guard ON public.%I',t);
  EXECUTE format('CREATE TRIGGER content_erasure_marker_guard BEFORE INSERT OR UPDATE ON public.%I'
   ' FOR EACH ROW EXECUTE FUNCTION public.content_erasure_marker_guard()',t);
 END LOOP;
END $$;

-- This check is composed with existing scope, actor, source and money checks.
CREATE OR REPLACE FUNCTION public.content_erasure_runtime_check(a uuid,eid uuid)
RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
  WHERE e.id=eid AND e.actor_id=a AND (e.erased_at IS NOT NULL OR e.content_deleted_at IS NOT NULL
   OR s.erased_at IS NOT NULL OR s.content_deleted_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501';
 END IF;
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_runtime_check(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;

DO $$
DECLARE source text; needle text;
BEGIN
 source:=pg_get_functiondef('public.runtime_billing_allowed(uuid,jsonb,uuid)'::regprocedure);
 IF position('-- D7 original execution' IN source)=0 THEN
  needle:='BEGIN';
  source:=regexp_replace(source,'\mBEGIN\M',E'BEGIN\n -- D7 original execution\n PERFORM content_erasure_runtime_check(a,(SELECT id FROM runtime_executions WHERE billing_run_id=p_run_id AND actor_id=a));');
  EXECUTE source;
 END IF;
 source:=pg_get_functiondef('public.runtime_direct_billing_allowed(uuid,jsonb,uuid)'::regprocedure);
 IF position('-- D7 original execution' IN source)=0 THEN
  EXECUTE regexp_replace(source,'\mBEGIN\M',E'BEGIN\n -- D7 original execution\n PERFORM content_erasure_runtime_check(a,(SELECT id FROM runtime_executions WHERE billing_run_id=p_run_id AND actor_id=a));');
 END IF;
END $$;

-- Existing history availability already calls runtime_direct_billing_allowed.
-- Preserve display of the user's original prompt after answer deletion. It is
-- deliberately kept outside erased_at: account erasure will clear it later.
CREATE OR REPLACE FUNCTION public.content_erasure_execution_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF OLD.content_deleted_at IS NULL AND NEW.content_deleted_at IS NULL THEN RETURN NEW; END IF;
 IF NEW.erased_at IS NOT NULL AND erasure_update_allowed(to_jsonb(OLD),to_jsonb(NEW),
  ARRAY['payload','result','primary_result','match_result']) THEN RETURN NEW; END IF;
 IF OLD.content_deleted_at IS NULL THEN
  IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
   OR NEW.payload IS DISTINCT FROM jsonb_build_object('input',OLD.payload->'input')
   OR NEW.result IS NOT NULL OR NEW.primary_result IS NOT NULL OR NEW.match_result IS NOT NULL
   OR (to_jsonb(NEW)-ARRAY['content_deleted_at','payload','result','primary_result','match_result','unavailable_reason'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['content_deleted_at','payload','result','primary_result','match_result','unavailable_reason'])
   OR NEW.unavailable_reason IS DISTINCT FROM 'content_deleted' THEN
   RAISE EXCEPTION 'CONTENT_ERASURE_WRITE_DENIED' USING ERRCODE='42501';
  END IF;
 ELSIF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=OLD.session_id AND content_deleted_at IS NOT NULL)
  AND NEW.payload=jsonb_build_object('input',NULL) AND NEW.result IS NULL AND NEW.primary_result IS NULL
  AND NEW.match_result IS NULL AND (to_jsonb(NEW)-'payload')=(to_jsonb(OLD)-'payload') THEN RETURN NEW;
 ELSE
  -- Original financial recovery may advance state, never restore private content.
  IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
   RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS content_erasure_execution_guard ON public.runtime_executions;
CREATE TRIGGER content_erasure_execution_guard BEFORE UPDATE ON public.runtime_executions
 FOR EACH ROW EXECUTE FUNCTION public.content_erasure_execution_guard();

REVOKE ALL ON FUNCTION public.content_erasure_marker_guard(),public.content_erasure_execution_guard()
 FROM PUBLIC,anon,authenticated,service_role;

-- IDs are structured references. Free text, titles and substring matches are not
-- provenance. Frozen JSON encoded as a string is visited only when it is an object/array.
CREATE OR REPLACE FUNCTION public.content_erasure_references(v jsonb,ids uuid[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE x record;
BEGIN
 IF cardinality(ids)=0 OR v IS NULL THEN RETURN false; END IF;
 IF jsonb_typeof(v)='object' THEN
  FOR x IN SELECT * FROM jsonb_each(v) LOOP
   IF x.key IN ('executionId','sourceExecutionId','sourceVersionId','sourceContentId','projectId',
    'workItemId','roundId','conversationId','sessionId','dependencyId','source_message_id',
    'sourceScriptId','contentId','draftId')
    AND lower(x.value#>>'{}')=ANY(ids::text[]) THEN RETURN true; END IF;
   IF content_erasure_references(x.value,ids) THEN RETURN true; END IF;
  END LOOP;
 ELSIF jsonb_typeof(v)='array' THEN
  FOR x IN SELECT value FROM jsonb_array_elements(v) LOOP
   IF content_erasure_references(x.value,ids) THEN RETURN true; END IF;
  END LOOP;
 ELSIF jsonb_typeof(v)='string' AND ((v#>>'{}') IS JSON OBJECT OR (v#>>'{}') IS JSON ARRAY) THEN
  RETURN content_erasure_references((v#>>'{}')::jsonb,ids);
 END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_references(jsonb,uuid[]) FROM PUBLIC,anon,authenticated,service_role;

-- V3 includes complete pending suggestions in organizer input without their source ID.
-- Match structured field identity and the complete original proposal, never text substrings.
CREATE OR REPLACE FUNCTION public.content_erasure_capture_copy(payload jsonb,result jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE input jsonb;output jsonb;
BEGIN
 IF NOT coalesce((payload#>>'{attachedOrganizer,input}') IS JSON OBJECT,false)
  OR NOT coalesce((result->>'summary') IS JSON OBJECT,false) THEN RETURN false; END IF;
 input:=(payload#>>'{attachedOrganizer,input}')::jsonb;output:=(result->>'summary')::jsonb;
 RETURN EXISTS(SELECT 1
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(input->'checklist')='array' THEN input->'checklist' ELSE '[]' END) step,
   jsonb_array_elements(CASE WHEN jsonb_typeof(step->'fields')='array' THEN step->'fields' ELSE '[]' END) field,
   jsonb_array_elements(CASE WHEN jsonb_typeof(output->'patches')='array' THEN output->'patches' ELSE '[]' END) patch
  WHERE step->>'id'=patch->>'stepId' AND field->>'id'=patch->>'fieldId'
   AND jsonb_typeof(field->'pendingSuggestion')='object'
   AND jsonb_typeof(patch->'value')='string'
   AND jsonb_strip_nulls(field->'pendingSuggestion')=jsonb_strip_nulls(jsonb_build_object(
    'value',patch->'value','nature',patch->'nature','basis',patch->'basis')));
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_capture_copy(jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.content_erasure_scope(a uuid,k text,target uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE sessions uuid[]:='{}'; executions uuid[]:='{}'; projects uuid[]:='{}'; versions uuid[]:='{}';
 content_ids uuid[]:='{}'; refs uuid[]:='{}';
 root_e runtime_executions;root_s runtime_sessions;root_p artifact_projects;root_c opc_content_versions;
 deleted boolean:=false;more uuid[];n integer;preserved bigint;dependents jsonb;
BEGIN
 IF a IS NULL OR target IS NULL THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
 IF k='answer' THEN
  SELECT * INTO root_e FROM runtime_executions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  executions:=ARRAY[root_e.id];deleted:=root_e.content_deleted_at IS NOT NULL OR root_e.erased_at IS NOT NULL;
 ELSIF k='session' THEN
  SELECT * INTO root_s FROM runtime_sessions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  sessions:=ARRAY[root_s.id];deleted:=root_s.content_deleted_at IS NOT NULL OR root_s.erased_at IS NOT NULL;
 ELSIF k='artifact' THEN
  SELECT * INTO root_p FROM artifact_projects WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  projects:=ARRAY[root_p.id];deleted:=root_p.content_deleted_at IS NOT NULL OR root_p.erased_at IS NOT NULL;
  versions:=ARRAY(SELECT id FROM artifact_versions WHERE project_id=root_p.id ORDER BY id);
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=root_p.id ORDER BY id);
 ELSIF k='content' THEN
  SELECT * INTO root_c FROM opc_content_versions WHERE id=target AND actor_id=a;
  IF NOT FOUND THEN RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501'; END IF;
  content_ids:=ARRAY(SELECT id FROM opc_content_versions WHERE actor_id=a AND work_item_id=root_c.work_item_id AND kind=root_c.kind);
  deleted:=NOT EXISTS(SELECT 1 FROM opc_content_versions WHERE id=ANY(content_ids) AND erased_at IS NULL);
 ELSE RAISE EXCEPTION 'CONTENT_TARGET_INVALID' USING ERRCODE='22023'; END IF;
 -- Independent saved descendants stay intact, while their copied source contexts are invalidated.
 WITH RECURSIVE descendants(id) AS (
  SELECT id FROM opc_content_versions WHERE id=ANY(content_ids)
  UNION SELECT c.id FROM opc_content_versions c JOIN descendants d ON c.source_content_id=d.id WHERE c.actor_id=a
 ) SELECT coalesce(array_agg(id ORDER BY id),'{}') INTO refs FROM descendants;
 refs:=refs||executions||sessions||projects||versions||content_ids||
  ARRAY(SELECT id FROM artifact_evidence WHERE project_id=ANY(projects))||
  ARRAY(SELECT operation_id FROM artifact_evidence WHERE project_id=ANY(projects) AND operation_id IS NOT NULL)||
  ARRAY(SELECT draft_id FROM opc_drafts WHERE actor_id=a AND project_id=ANY(projects))||
  ARRAY(SELECT conversation_id FROM artifact_chats WHERE project_id=ANY(projects))||
  ARRAY(SELECT work_item_id FROM opc_items WHERE source_version_id=ANY(versions))||
  ARRAY(SELECT session_id FROM opc_topic_workspaces WHERE actor_id=a AND source_version_id=ANY(versions))||ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 executions:=ARRAY(SELECT DISTINCT ex.id FROM runtime_executions ex WHERE ex.actor_id=a AND
  (ex.id=ANY(executions) OR ex.session_id=ANY(sessions) OR content_erasure_references(ex.payload,refs)
   OR EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=ex.session_id AND content_erasure_references(rs.scope,refs))
   OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.source_script_id=ANY(refs)
    AND b.session_id=ex.session_id AND b.request_id=ex.request_id)
   OR EXISTS(SELECT 1 FROM runtime_scope_material mat WHERE
    (mat.request_id=ANY(refs) OR content_erasure_references(mat.request,refs) OR content_erasure_references(mat.content,refs)
     OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.actor_id=a AND b.session_id=mat.session_id
      AND b.material_revision=mat.revision AND b.source_script_id=ANY(refs)))
    AND mat.session_id::text=ex.payload#>>'{scopeMaterial,sessionId}' AND mat.revision::text=ex.payload#>>'{scopeMaterial,revision}')));
 -- Exact dependency closure; UNION bounds malformed cycles.
 LOOP
  n:=cardinality(executions);
  more:=ARRAY(SELECT DISTINCT ex.id FROM runtime_executions ex WHERE ex.actor_id=a AND
   (EXISTS(SELECT 1 FROM runtime_history_dependencies d WHERE d.execution_id=ex.id AND d.dependency_id=ANY(executions))
    OR content_erasure_references(ex.payload,executions)
    OR EXISTS(SELECT 1 FROM runtime_executions src WHERE src.id=ANY(executions)
     AND src.actor_id=a AND src.session_id=ex.session_id AND (src.created_at,src.id)<(ex.created_at,ex.id)
     AND content_erasure_capture_copy(ex.payload,src.result))));
  executions:=ARRAY(SELECT DISTINCT x FROM unnest(executions||more) x ORDER BY x);
  EXIT WHEN cardinality(executions)=n;
 END LOOP;
 SELECT count(*) INTO preserved FROM opc_content_versions c0 WHERE c0.actor_id=a AND c0.erased_at IS NULL
  AND NOT c0.id=ANY(content_ids) AND (c0.execution_id=ANY(executions) OR c0.source_content_id=ANY(content_ids));
 preserved:=preserved+(SELECT count(*) FROM artifact_versions v WHERE NOT v.project_id=ANY(projects)
  AND EXISTS(SELECT 1 FROM artifact_projects p0 WHERE p0.id=v.project_id AND p0.actor_id=a)
  AND (EXISTS(SELECT 1 FROM artifact_work_references r WHERE r.project_id=v.project_id AND r.source_version_id=ANY(versions))
   OR EXISTS(SELECT 1 FROM opc_result_links l WHERE l.round_id=v.round_id AND l.execution_id=ANY(executions))));
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',kind,'id',id) ORDER BY kind,id),'[]') INTO dependents FROM (
  SELECT 'account' kind,p.project_id id FROM opc_accounts p WHERE p.actor_id=a AND p.source_version_id=ANY(versions)
  UNION SELECT 'work_item',i.work_item_id FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id
   WHERE p.actor_id=a AND i.source_version_id=ANY(versions)
  UNION SELECT 'reference',r.project_id FROM artifact_work_references r JOIN artifact_projects p ON p.id=r.project_id
   WHERE p.actor_id=a AND r.source_version_id=ANY(versions)
  UNION SELECT 'content',c.id FROM opc_content_versions c WHERE c.actor_id=a AND NOT c.id=ANY(content_ids)
   AND (c.execution_id=ANY(executions) OR c.id=ANY(refs))
 ) affected;
 -- Canonical sets make the preview hash independent of query plans and physical row order.
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO sessions FROM unnest(sessions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO executions FROM unnest(executions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO projects FROM unnest(projects) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO versions FROM unnest(versions) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO content_ids FROM unnest(content_ids) id WHERE id IS NOT NULL;
 SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}') INTO refs FROM unnest(refs) id WHERE id IS NOT NULL;
 RETURN jsonb_build_object('kind',k,'id',target,'alreadyDeleted',deleted,
  'sessions',to_jsonb(sessions),'executions',to_jsonb(executions),'projects',to_jsonb(projects),
  'versions',to_jsonb(versions),'contents',to_jsonb(content_ids),'references',to_jsonb(refs),
  'affectedSources',dependents,'preservedSavedVersions',preserved);
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_scope(uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

-- One request transaction, not a deletion queue. Caller identity comes from the
-- protected API; anon/authenticated have no direct RPC or table mutation grant.
CREATE OR REPLACE FUNCTION public.content_erasure_preview(a uuid,k text,target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE scope jsonb;
BEGIN
 PERFORM bill2_actor(a);
 scope:=content_erasure_scope(a,k,target);
 RETURN jsonb_build_object('kind',k,'id',target,'alreadyDeleted',scope->'alreadyDeleted',
  'affectedExecutions',jsonb_array_length(scope->'executions'),'affectedSources',scope->'affectedSources',
  'preservedSavedVersions',scope->'preservedSavedVersions',
  'previewHash',encode(sha256(convert_to(scope::text,'utf8')),'hex'));
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_preview(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.content_erasure_preview(uuid,text,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.content_erasure_confirm(a uuid,k text,target uuid,expected_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE scope jsonb; ids uuid[]; sessions uuid[]; projects uuid[]; versions uuid[]; contents uuid[];
 refs uuid[]; rounds uuid[]; chats uuid[]; research_ids uuid[]; research_plan_ids uuid[]; stamp timestamptz:=clock_timestamp(); row record; financial jsonb;
 remaining bigint:=0; deleted boolean;
BEGIN
 PERFORM bill2_actor(a);
 -- Runtime writers use session -> execution -> run. NOWAIT prevents inverse
 -- legacy/project lock orders from turning erasure into a cross-domain deadlock.
 PERFORM id FROM profiles WHERE id=a FOR SHARE NOWAIT;
 PERFORM bill2_actor(a);
 PERFORM id FROM runtime_sessions WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM artifact_projects WHERE actor_id=a ORDER BY id FOR UPDATE NOWAIT;
 scope:=content_erasure_scope(a,k,target);
 deleted:=(scope->>'alreadyDeleted')::boolean;
 IF NOT deleted AND expected_hash IS DISTINCT FROM encode(sha256(convert_to(scope::text,'utf8')),'hex') THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_PREVIEW_CHANGED' USING ERRCODE='40001';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO ids FROM jsonb_array_elements_text(scope->'executions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO sessions FROM jsonb_array_elements_text(scope->'sessions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO projects FROM jsonb_array_elements_text(scope->'projects') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO versions FROM jsonb_array_elements_text(scope->'versions') v;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO contents FROM jsonb_array_elements_text(scope->'contents') v;
 -- Existing UI writers lock their item/account before updating private settings.
 PERFORM work_item_id FROM opc_items WHERE work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM project_id FROM opc_accounts WHERE project_id=ANY(projects) ORDER BY project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 PERFORM account_project_id FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects) ORDER BY account_project_id FOR UPDATE NOWAIT;
 PERFORM work_item_id FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects) ORDER BY work_item_id FOR UPDATE NOWAIT;
 rounds:=ARRAY(SELECT id FROM artifact_rounds WHERE project_id=ANY(projects));
 chats:=ARRAY(SELECT c.conversation_id FROM artifact_chats c JOIN conversations v ON v.id=c.conversation_id
  WHERE c.project_id=ANY(projects) AND v.user_id=a);
 PERFORM id FROM conversations WHERE id=ANY(chats) ORDER BY id FOR UPDATE NOWAIT;
 research_ids:=ARRAY(SELECT DISTINCT o.id FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  JOIN artifact_evidence e ON e.operation_id=o.id WHERE p.actor_id=a AND
   (e.project_id=ANY(projects) OR e.id IN (SELECT evidence_id FROM opc_result_links WHERE execution_id=ANY(ids))));
 research_plan_ids:=ARRAY(SELECT DISTINCT plan_id FROM research_operations WHERE id=ANY(research_ids));
 -- Research RPCs serialize on the plan. NOWAIT avoids their plan -> project lock inversion.
 PERFORM id FROM research_plans WHERE id=ANY(research_plan_ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM research_operations WHERE id=ANY(research_ids) ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM research_operations WHERE id=ANY(research_ids) AND erased_at IS NULL AND
   (state NOT IN ('succeeded','failed','cancelled') OR (pre_deduct_id IS NOT NULL AND charged_credits IS NULL))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 SELECT coalesce(array_agg(v::uuid),'{}') INTO refs FROM jsonb_array_elements_text(scope->'references') v;
 refs:=refs||ids||sessions||projects||versions||contents||rounds;
 PERFORM id FROM runtime_executions WHERE id=ANY(ids) ORDER BY id FOR UPDATE NOWAIT;
 PERFORM id FROM bill2_runs WHERE id IN (SELECT billing_run_id FROM runtime_executions WHERE id=ANY(ids))
  ORDER BY id FOR UPDATE NOWAIT;
 IF EXISTS(SELECT 1 FROM artifact_generations g WHERE g.state NOT IN ('succeeded','refunded')
  AND (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs))) THEN
  RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
 END IF;
 -- Keep only source IDs in the existing dependency graph before clearing copies.
 -- Repeated deletion/financial cleanup must find the same original dependent runs.
 INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
 SELECT ex.id,src.id FROM runtime_executions ex JOIN runtime_executions src ON src.session_id=ex.session_id
 WHERE ex.id=ANY(ids) AND src.id=ANY(ids) AND ex.actor_id=a AND src.actor_id=a
  AND (src.created_at,src.id)<(ex.created_at,ex.id) AND content_erasure_capture_copy(ex.payload,src.result)
 ON CONFLICT DO NOTHING;
 -- Retain only binding identities for later cleanup/recovery after frozen material is gone.
 INSERT INTO runtime_history_dependencies(execution_id,dependency_id)
 SELECT ex.id,src.id FROM opc_video_material_bindings b JOIN runtime_executions src
  ON src.actor_id=b.actor_id AND src.session_id=b.session_id AND src.request_id=b.request_id
 JOIN runtime_executions ex ON ex.actor_id=b.actor_id AND ex.session_id=b.session_id AND ex.id<>src.id
 WHERE b.actor_id=a AND src.id=ANY(ids) AND ex.id=ANY(ids)
  AND ex.payload#>>'{scopeMaterial,sessionId}'=b.session_id::text
  AND ex.payload#>>'{scopeMaterial,revision}'=b.material_revision::text
 ON CONFLICT DO NOTHING;
 UPDATE runtime_sessions SET content_deleted_at=stamp WHERE id=ANY(sessions) AND content_deleted_at IS NULL;
 UPDATE artifact_projects SET content_deleted_at=stamp WHERE id=ANY(projects) AND content_deleted_at IS NULL;
 UPDATE bill2_runs SET content_deleted_at=stamp WHERE actor_id=a AND content_deleted_at IS NULL
  AND id IN (SELECT billing_run_id FROM runtime_executions WHERE id=ANY(ids));
 -- Preserve original delivery/unknown facts before clearing the execution body.
 -- No adapter, redispatch, new request ID or fabricated provider failure exists here.
 FOR row IN SELECT id,billing_run_id FROM runtime_executions WHERE id=ANY(ids) ORDER BY id LOOP
  IF row.billing_run_id IS NOT NULL THEN
   financial:=runtime_financial_recovery(a,row.id,true);
   PERFORM account_erasure_scrub_calls(a,row.billing_run_id);
   PERFORM account_erasure_scrub_run(a,row.billing_run_id);
   financial:=account_erasure_scrub_receipts(a,row.billing_run_id,100);
   remaining:=remaining+coalesce((financial->>'remaining')::bigint,0);
  END IF;
 END LOOP;
 UPDATE runtime_scope_material m SET request=NULL,content=NULL,content_hash=NULL,erased_at=stamp
  WHERE m.erased_at IS NULL AND EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=m.session_id AND s.actor_id=a)
   AND (m.session_id=ANY(refs) OR m.request_id=ANY(refs)
    OR EXISTS(SELECT 1 FROM runtime_sessions rs WHERE rs.id=m.session_id AND content_erasure_references(rs.scope,refs))
    OR content_erasure_references(m.request,refs) OR content_erasure_references(m.content,refs)
    OR EXISTS(SELECT 1 FROM opc_video_material_bindings b WHERE b.session_id=m.session_id AND b.material_revision=m.revision AND b.source_script_id=ANY(refs)));
 UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL;
 UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL;
 UPDATE runtime_session_history SET item=NULL,erased_at=stamp WHERE execution_id=ANY(ids) AND erased_at IS NULL
  AND (session_id=ANY(sessions) OR item->>'role' IS DISTINCT FROM 'user');
 UPDATE runtime_history_dependencies SET erased_at=stamp WHERE erased_at IS NULL
  AND (execution_id=ANY(ids) OR dependency_id=ANY(ids));
 UPDATE runtime_executions SET payload=jsonb_build_object('input',payload->'input'),result=NULL,primary_result=NULL,match_result=NULL,
  unavailable_reason='content_deleted',content_deleted_at=stamp WHERE id=ANY(ids) AND content_deleted_at IS NULL AND erased_at IS NULL;
 -- Whole sessions also clear retained questions; an answer deletion retains them.
 UPDATE runtime_executions SET payload=NULL,result=NULL,primary_result=NULL,match_result=NULL,erased_at=stamp
  WHERE session_id=ANY(sessions) AND erased_at IS NULL AND state IN ('completed','cancelled');
 UPDATE runtime_executions SET payload=jsonb_build_object('input',NULL)
  WHERE session_id=ANY(sessions) AND erased_at IS NULL AND content_deleted_at IS NOT NULL;
 UPDATE bill2_drafts SET revoked=true WHERE actor_id=a AND id IN
  (SELECT (rs.scope->>'draftId')::uuid FROM runtime_sessions rs WHERE rs.id=ANY(sessions) AND rs.scope->>'kind' IN ('positioning_draft','positioning_topic'));
 UPDATE runtime_sessions SET scope=NULL,start_payload=NULL,erased_at=stamp WHERE id=ANY(sessions) AND erased_at IS NULL;
 UPDATE opc_content_versions SET body=NULL,title=NULL,erased_at=stamp WHERE id=ANY(contents) AND erased_at IS NULL;
 -- System capture fields and suggestions carry exact execution provenance. Preserve
 -- unrelated manual fields and independently saved published bodies.
 UPDATE artifact_rounds r SET steps=content_erasure_capture_steps(r.steps)
  WHERE r.erased_at IS NULL AND NOT r.id=ANY(rounds)
  AND EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=r.project_id AND p.actor_id=a)
  AND content_erasure_references(r.steps,ids)
  AND r.steps IS DISTINCT FROM content_erasure_capture_steps(r.steps);
 UPDATE artifact_generations g SET input=NULL,result=(SELECT jsonb_object_agg(key,value)
  FROM jsonb_each(coalesce(g.result,'{}')) WHERE key IN ('credits','inputTokens','outputTokens','costUsd')),erased_at=stamp
  WHERE g.erased_at IS NULL AND g.state IN ('succeeded','refunded') AND
   (g.project_id=ANY(projects) OR content_erasure_references(g.input,refs));
 UPDATE agent_slice_executions SET preference_refs=NULL,discussion_refs=NULL,input_hash=NULL,erased_at=stamp
  WHERE erased_at IS NULL AND project_id=ANY(projects);
 UPDATE agent_slice_links SET source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND round_id=ANY(rounds);
 UPDATE opc_library_requests SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (request_id IN (SELECT request_id FROM opc_content_versions WHERE id=ANY(contents))
   OR result->>'id'=ANY(contents::text[]) OR content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_handoffs SET payload=NULL,result=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (content_erasure_references(payload,refs) OR content_erasure_references(result,refs));
 UPDATE opc_topic_draft_versions SET request=NULL,body=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (source_version_id=ANY(versions) OR content_erasure_references(request,refs) OR content_erasure_references(body,refs));
 -- Frozen source bodies and request caches are system copies, not independent saved content.
 UPDATE opc_turns t SET input_hash=NULL,erased_at=stamp WHERE t.erased_at IS NULL AND
  (t.session_id=ANY(sessions) OR t.round_id=ANY(rounds) OR EXISTS(SELECT 1 FROM runtime_executions e
   WHERE e.id=ANY(ids) AND e.session_id=t.session_id AND e.request_id=t.request_id));
 UPDATE opc_topic_workspaces SET source_hash=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (session_id=ANY(sessions) OR source_version_id=ANY(versions));
 UPDATE opc_topic_openings SET input=NULL,erased_at=stamp WHERE erased_at IS NULL AND draft_id IN
  (SELECT draft_id FROM opc_drafts WHERE actor_id=a AND (session_id=ANY(sessions) OR project_id=ANY(projects)));
 UPDATE opc_plans SET request=NULL,body=NULL,erased_at=stamp WHERE erased_at IS NULL AND source_version_id=ANY(versions);
 -- Same private-setting removal as account erasure, restricted to the selected family.
 DELETE FROM opc_work_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 DELETE FROM opc_account_ui WHERE actor_id=a AND account_project_id=ANY(projects);
 DELETE FROM opc_publication_ui WHERE actor_id=a AND work_item_id=ANY(projects);
 UPDATE opc_item_edits SET title=NULL,brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_items SET brief=NULL,erased_at=stamp WHERE erased_at IS NULL AND work_item_id=ANY(projects);
 UPDATE opc_accounts SET account_key='erased:'||project_id,erased_at=stamp WHERE erased_at IS NULL AND project_id=ANY(projects);
 -- Guided Skill chats belong to the selected artifact family. Clear snapshots
 -- before message bodies and retain content-free identity shells for accounting.
 UPDATE conversation_context_snapshots SET content=NULL,metadata=NULL,erased_at=stamp
  WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE messages SET content=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_chat_turns SET body=NULL,erased_at=stamp WHERE conversation_id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET is_deleted='true',deleted_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE conversations SET title=NULL,summary=NULL,summary_metadata=NULL,erased_at=stamp WHERE id=ANY(chats) AND erased_at IS NULL;
 UPDATE artifact_versions SET report=NULL,report_hash=NULL,erased_at=stamp WHERE project_id=ANY(projects) AND erased_at IS NULL;
 UPDATE artifact_candidates SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_confirmations SET body=NULL,erased_at=stamp WHERE round_id=ANY(rounds) AND erased_at IS NULL;
 -- Same terminal-result cost projection as account erasure; original amounts and charge IDs stay intact.
 UPDATE research_operations o SET erased_at=stamp,
  result=(SELECT jsonb_object_agg(e.key,e.value) FROM jsonb_each(
   CASE WHEN jsonb_typeof(o.result)='object' THEN o.result ELSE '{}'::jsonb END) e WHERE e.key='cost')
 WHERE o.id=ANY(research_ids) AND o.erased_at IS NULL;
 -- Plans contain approved operation IDs/hashes/quote ceilings, never query text. Preserve
 -- mixed plans for unrelated operations; clear only when every approved operation is erased.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.id=ANY(research_plan_ids)
  AND p.erased_at IS NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.operations) item
   WHERE NOT EXISTS(SELECT 1 FROM research_operations o WHERE o.plan_id=p.id
    AND o.id::text=item->>'operationId' AND o.erased_at IS NOT NULL));
 UPDATE artifact_evidence SET payload=NULL,content_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR id IN (SELECT evidence_id FROM opc_result_links WHERE execution_id=ANY(ids)));
 UPDATE artifact_requests SET payload=(SELECT jsonb_object_agg(key,value) FROM jsonb_each(coalesce(payload,'{}'))
  WHERE key IN ('sliceExecution','slicePhase')),response=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  EXISTS(SELECT 1 FROM artifact_projects p WHERE p.id=artifact_requests.project_id AND p.actor_id=a)
  AND (project_id=ANY(projects) OR content_erasure_references(payload,refs) OR content_erasure_references(response,refs));
 UPDATE artifact_rounds SET steps=NULL,erased_at=stamp WHERE id=ANY(rounds) AND erased_at IS NULL;
 UPDATE artifact_work_references SET creation_payload=NULL,source_hash=NULL,erased_at=stamp WHERE erased_at IS NULL AND
  (project_id=ANY(projects) OR source_version_id=ANY(versions));
 UPDATE artifact_projects SET work_title=NULL,account='erased:'||id,erased_at=stamp WHERE id=ANY(projects) AND erased_at IS NULL;
 FOR row IN SELECT * FROM (VALUES
  ('token_stats','metadata=erasure_ledger_metadata(metadata),content_erased_at=$2'),
  ('billing_history','reason=NULL,metadata=erasure_ledger_metadata(metadata),content_erased_at=$2'),
  ('credit_transactions','description=NULL,metadata=erasure_ledger_metadata(metadata),content_erased_at=$2'),
  ('ai_usage_logs','error_message=NULL,ip_address=NULL,user_agent=NULL,metadata=erasure_ledger_metadata(metadata),content_erased_at=$2')
 ) x(tbl,assignment) LOOP
  EXECUTE format('UPDATE public.%I t SET %s WHERE t.user_id=$1 AND t.content_erased_at IS NULL AND content_erasure_ledger_owned(to_jsonb(t))',
   row.tbl,row.assignment) USING a,stamp;
 END LOOP;
 -- This status is about content. Unknown money remains on its original run.
 RETURN jsonb_build_object('kind',k,'id',target,'status',CASE WHEN remaining>0 THEN 'review_required' ELSE 'deleted' END,
  'alreadyDeleted',deleted,'preservedSavedVersions',scope->'preservedSavedVersions','financialReviewCount',remaining);
EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
 RAISE EXCEPTION 'CONTENT_ERASURE_BUSY' USING ERRCODE='55P03';
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_confirm(uuid,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.content_erasure_confirm(uuid,text,uuid,text) TO service_role;

CREATE OR REPLACE FUNCTION public.content_erasure_visible(a uuid,eid uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(a);
 IF NOT EXISTS(SELECT 1 FROM runtime_executions e JOIN runtime_sessions s ON s.id=e.session_id
  WHERE e.id=eid AND e.actor_id=a AND s.actor_id=a) THEN
  RAISE EXCEPTION 'CONTENT_NOT_FOUND' USING ERRCODE='42501';
 END IF;
 PERFORM content_erasure_runtime_check(a,eid);
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_visible(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.content_erasure_visible(uuid,uuid) TO service_role;

-- Only the selected, already-marked artifact may extend the existing closed-account
-- conversation guard. Ordinary open-account conversations keep the original denial.
CREATE OR REPLACE FUNCTION public.erasure_closed_conversation_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.erased_at IS NOT NULL THEN
  RAISE EXCEPTION 'ERASURE_INSERT_DENIED' USING ERRCODE='42501';
 END IF;
 IF NEW.erased_at IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=NEW.user_id)
  AND NOT EXISTS(SELECT 1 FROM artifact_chats c JOIN artifact_projects p ON p.id=c.project_id
   WHERE c.conversation_id=NEW.id AND p.actor_id=NEW.user_id AND p.content_deleted_at IS NOT NULL)
 THEN RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE='42501'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.erasure_closed_conversation_guard() FROM PUBLIC,anon,authenticated,service_role;

-- Fail closed before a replay can return an old request/result. These are
-- narrow guards on existing functions, not duplicate Runtime entry points.
DO $$
DECLARE sig text;source text;guard text;
BEGIN
 FOR sig,guard IN SELECT * FROM (VALUES
  ('runtime_start(uuid,uuid,jsonb)',
   'IF EXISTS(SELECT 1 FROM runtime_sessions WHERE actor_id=p_actor_id AND start_request_id=p_request_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('artifact_chat(uuid,text,uuid,jsonb)',
   'IF EXISTS(SELECT 1 FROM artifact_projects deleted_project WHERE deleted_project.actor_id=p_actor_id AND deleted_project.erased_at IS NOT NULL AND (deleted_project.id=(p_payload->>''projectId'')::uuid OR deleted_project.id IN (SELECT project_id FROM artifact_chats WHERE conversation_id=p_conversation_id))) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('opc_query(uuid,uuid)',
   'IF EXISTS(SELECT 1 FROM opc_drafts d JOIN artifact_projects p ON p.id=d.project_id WHERE d.actor_id=p_actor_id AND d.draft_id=p_draft_id AND p.erased_at IS NOT NULL) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('runtime_response(uuid,uuid,integer,text)',
   'PERFORM content_erasure_runtime_check(p_actor_id,p_execution_id);'),
  ('runtime_session_items(uuid,uuid,uuid,text,jsonb,integer,integer)',
   'PERFORM content_erasure_runtime_check(p_actor_id,p_execution_id);'),
  ('runtime_material(uuid,uuid,text,uuid,bigint,jsonb)',
   'IF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('opc_content_from_execution(uuid,uuid,uuid,bigint,text,text,uuid,uuid)',
   'PERFORM content_erasure_runtime_check(p_actor_id,p_execution_id); IF EXISTS(SELECT 1 FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind=p_kind AND erased_at IS NOT NULL) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('opc_content_manual_save(uuid,uuid,uuid,bigint,uuid,text,text,text,text)',
   'IF EXISTS(SELECT 1 FROM opc_content_versions WHERE actor_id=p_actor_id AND request_id=p_request_id AND kind=p_kind AND erased_at IS NOT NULL) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('runtime_execution(uuid,uuid,text,jsonb)',
   'PERFORM content_erasure_runtime_check(p_actor_id,p_execution_id);'),
  ('runtime_admission_replay(uuid,uuid,jsonb)',
   'PERFORM content_erasure_runtime_check(p_actor_id,(SELECT id FROM runtime_executions WHERE actor_id=p_actor_id AND request_id=p_request_id));'),
  ('runtime_session_context(uuid,uuid)',
   'IF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('runtime_admit(uuid,uuid,uuid,jsonb,jsonb)',
   'IF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('runtime_view(uuid,uuid)',
   'IF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;'),
  ('opc_source_allowed(uuid,uuid)',
   'IF EXISTS(SELECT 1 FROM artifact_versions WHERE id=v_id AND erased_at IS NOT NULL) THEN RETURN false; END IF;'),
  ('opc_content_allowed(uuid,uuid)',
   'IF EXISTS(SELECT 1 FROM opc_content_versions WHERE id=p_content_id AND actor_id=p_actor_id AND erased_at IS NOT NULL) THEN RETURN false; END IF;')
 ) x(sig,guard) LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- D7 read boundary' IN source)=0 THEN
   EXECUTE regexp_replace(source,'\mBEGIN\M',E'BEGIN\n -- D7 read boundary\n '||guard);
  END IF;
 END LOOP;
 -- Navigation must not continue listing a tombstoned guided conversation.
 source:=pg_get_functiondef('public.artifact_chat(uuid,text,uuid,jsonb)'::regprocedure);
 IF position('WHERE ap.actor_id=p_actor_id AND ap.erased_at IS NULL);' IN source)=0 THEN
  IF position('WHERE ap.actor_id=p_actor_id);' IN source)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: artifact_chat stats'; END IF;
  EXECUTE replace(source,'WHERE ap.actor_id=p_actor_id);','WHERE ap.actor_id=p_actor_id AND ap.erased_at IS NULL);');
 END IF;
 -- Every ancestor, not only the initial selected content, must be available.
 source:=pg_get_functiondef('public.opc_content_allowed(uuid,uuid)'::regprocedure);
 IF position('IF NOT FOUND OR c.erased_at IS NOT NULL' IN source)=0 THEN
  IF position('IF NOT FOUND THEN RETURN false;END IF;' IN source)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: opc_content_allowed';END IF;
  EXECUTE replace(source,'IF NOT FOUND THEN RETURN false;END IF;','IF NOT FOUND OR c.erased_at IS NOT NULL THEN RETURN false;END IF;');
 END IF;
END $$;

-- Hide deleted root sessions from navigation without losing independent artifacts.
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('public.opc_free_conversations(uuid)'::regprocedure);
 IF position('session.content_deleted_at IS NULL' IN source)=0 THEN
  IF position('WHERE session.actor_id=p_actor_id' IN source)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: opc_free_conversations';END IF;
  EXECUTE replace(source,'WHERE session.actor_id=p_actor_id',
   'WHERE session.erased_at IS NULL AND session.content_deleted_at IS NULL AND session.actor_id=p_actor_id');
 END IF;
END $$;

-- Scrub a known capture's information and suggestion together; never leave the
-- value while dropping only its provenance. Non-capture fields stay byte-identical.
CREATE OR REPLACE FUNCTION public.content_erasure_capture_steps(steps jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE st record;f record;v jsonb;meta jsonb;result jsonb:=steps;changed boolean;information_changed boolean;ids uuid[];
BEGIN
 ids:=ARRAY(SELECT id FROM runtime_executions WHERE content_deleted_at IS NOT NULL OR erased_at IS NOT NULL);
 IF jsonb_typeof(steps) IS DISTINCT FROM 'object' THEN RETURN steps; END IF;
 FOR st IN SELECT * FROM jsonb_each(steps) LOOP
  v:=st.value;changed:=false;information_changed:=false;
  FOR f IN SELECT * FROM jsonb_each(coalesce(v->'fieldMeta','{}')) LOOP
   meta:=f.value;
   IF meta->>'source'='capture' AND lower(meta->>'executionId')=ANY(ids::text[]) THEN
    IF meta->>'fp'=artifact_hash(v#>ARRAY['information',f.key]) THEN
     v:=jsonb_set(v,ARRAY['information',f.key],'{"value":"","status":"unknown","nature":"unknown"}');
     information_changed:=true;
    END IF;
    meta:=meta-ARRAY['source','executionId','fp'];changed:=true;
   END IF;
   IF content_erasure_references(meta->'suggestion',ids) THEN meta:=meta-'suggestion';changed:=true; END IF;
   IF content_erasure_references(meta->'withdrawnSuggestion',ids) THEN meta:=meta-'withdrawnSuggestion';changed:=true; END IF;
   IF content_erasure_references(meta->'suggestions',ids) THEN
    meta:=jsonb_set(meta,'{suggestions}',(SELECT coalesce(jsonb_agg(x),'[]') FROM jsonb_array_elements(meta->'suggestions') x
     WHERE NOT content_erasure_references(x,ids)));changed:=true;
   END IF;
   v:=jsonb_set(v,ARRAY['fieldMeta',f.key],meta);
  END LOOP;
  IF changed THEN
   IF information_changed THEN
    v:=v||jsonb_build_object('valid',false,'version',coalesce((v->>'version')::integer,0)+1);
   END IF;
   result:=jsonb_set(result,ARRAY[st.key],v);
  END IF;
 END LOOP;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_capture_steps(jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('public.artifact_round_identity()'::regprocedure);
 IF position('-- D7 capture scrub' IN source)=0 THEN
  EXECUTE regexp_replace(source,'\mBEGIN\M',$patch$BEGIN
 -- D7 capture scrub: exact one-way calculation from committed execution markers.
 IF TG_OP='UPDATE' AND OLD.erased_at IS NULL AND NEW.erased_at IS NULL
  AND current_user=pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  AND (to_jsonb(NEW)-'steps')=(to_jsonb(OLD)-'steps')
  AND NEW.steps IS NOT DISTINCT FROM content_erasure_capture_steps(OLD.steps)
  AND NEW.steps IS DISTINCT FROM OLD.steps THEN RETURN NEW; END IF;
$patch$);
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.content_erasure_saved_readable(a uuid,cid uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE c opc_content_versions;p artifact_projects;v artifact_versions;r artifact_rounds;
 current_id uuid:=cid;seen uuid[]:='{}';first_row boolean:=true;e runtime_executions;
BEGIN
 IF opc_content_allowed(a,cid) THEN RETURN true; END IF;
 LOOP
  IF current_id IS NULL THEN RETURN true; END IF;
  IF current_id=ANY(seen) THEN RETURN false; END IF;
  SELECT * INTO c FROM opc_content_versions WHERE id=current_id AND actor_id=a;
  IF NOT FOUND OR (first_row AND c.erased_at IS NOT NULL) THEN RETURN false; END IF;
  SELECT * INTO p FROM artifact_projects WHERE id=c.work_item_id AND actor_id=a;
  IF NOT FOUND OR (first_row AND p.erased_at IS NOT NULL) THEN RETURN false; END IF;
  SELECT av.* INTO v FROM opc_items i JOIN artifact_versions av ON av.id=i.source_version_id WHERE i.work_item_id=p.id;
  SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a;
  SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND state='published';
  IF p.id IS NULL OR r.id IS NULL THEN RETURN false; END IF;
  -- Retain current package/actor authorization even when the source body is gone.
  PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
  IF v.erased_at IS NULL AND NOT opc_source_allowed(a,v.id) THEN RETURN false; END IF;
  IF c.execution_id IS NOT NULL THEN
   SELECT * INTO e FROM runtime_executions WHERE id=c.execution_id AND actor_id=a;
   IF e.id IS NULL OR (e.content_deleted_at IS NULL AND NOT runtime_history_available(e.id)) THEN RETURN false; END IF;
  END IF;
  seen:=array_append(seen,current_id);current_id:=c.source_content_id;first_row:=false;
 END LOOP;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_saved_readable(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('public.opc_library_before_workspace_ui(uuid,text,date,date)'::regprocedure);
 IF position('content_erasure_saved_readable' IN source)=0 THEN
  IF position('opc_content_allowed(p_actor_id,version.id)' IN source)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: library';END IF;
  source:=replace(source,'opc_content_allowed(p_actor_id,version.id)','content_erasure_saved_readable(p_actor_id,version.id)');
  source:=replace(source,'''contentAvailable'',c.allowed',
   '''contentAvailable'',c.allowed,''sourceAvailable'',opc_content_allowed(p_actor_id,c.id)');
  EXECUTE source;
 END IF;
 source:=pg_get_functiondef('public.opc_library_before_workspace_ui(uuid,text,date,date)'::regprocedure);
 IF position('LEFT JOIN runtime_sessions s' IN source)=0 THEN
  IF position('JOIN runtime_sessions s' IN source)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: library session';END IF;
  EXECUTE replace(source,'JOIN runtime_sessions s','LEFT JOIN runtime_sessions s');
 END IF;
 source:=pg_get_functiondef('public.opc_library_before_workspace_ui(uuid,text,date,date)'::regprocedure);
 IF position('-- D7 library roots' IN source)=0 THEN
  IF position('WHERE version.work_item_id=i.work_item_id)' IN source)=0 OR
   position('WHERE i.account_project_id=a.project_id AND' IN source)=0 THEN
   RAISE EXCEPTION 'D7 library roots boundary mismatch'; END IF;
  source:=replace(source,'WHERE version.work_item_id=i.work_item_id)',
   'WHERE version.work_item_id=i.work_item_id AND version.erased_at IS NULL)');
  source:=replace(source,'WHERE i.account_project_id=a.project_id AND',
   E'WHERE i.erased_at IS NULL AND p.erased_at IS NULL AND p.content_deleted_at IS NULL\n -- D7 library roots\n AND i.account_project_id=a.project_id AND');
  source:=replace(source,'FROM opc_accounts a WHERE a.actor_id=p_actor_id',
   'FROM opc_accounts a WHERE a.erased_at IS NULL AND a.actor_id=p_actor_id');
  EXECUTE source;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION public.content_erasure_ledger_owned(j jsonb)
RETURNS boolean LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM bill2_runs r WHERE r.actor_id::text=j->>'user_id' AND r.content_deleted_at IS NOT NULL
  AND (r.id::text=j->>'bill2_run_id' OR r.pre_deduct_id::text=j->>'id'
   OR r.id::text=j#>>'{metadata,usage,runId}' OR r.id::text=j#>>'{metadata,runId}'
   OR r.pre_deduct_id::text=j#>>'{metadata,preDeductId}'))
;
$$;
REVOKE ALL ON FUNCTION public.content_erasure_ledger_owned(jsonb) FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('public.erasure_ledger_guard()'::regprocedure);
 IF position('-- D7 original ledger binding' IN source)=0 THEN
  IF position(' IF prior->>''content_erased_at'' IS NOT NULL THEN' IN source)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: ledger';END IF;
  EXECUTE replace(source,' IF prior->>''content_erased_at'' IS NOT NULL THEN',
   E' -- D7 original ledger binding\n closed:=closed OR content_erasure_ledger_owned(incoming);\n IF prior->>''content_erased_at'' IS NOT NULL THEN');
 END IF;
 source:=pg_get_functiondef('public.runtime_view(uuid,uuid)'::regprocedure);
 IF position('''contentDeleted''' IN source)=0 THEN
  source:=replace(source,'''input'',CASE WHEN availability.available THEN e.payload->>''input'' ELSE NULL END',
   '''contentDeleted'',e.content_deleted_at IS NOT NULL,''input'',CASE WHEN availability.available OR e.content_deleted_at IS NOT NULL THEN e.payload->>''input'' ELSE NULL END');
  EXECUTE source;
 END IF;
END $$;

DO $$
DECLARE source text;
BEGIN
 source:=pg_get_functiondef('public.artifact_evidence_allowed(uuid,jsonb)'::regprocedure);
 IF position('-- D7 source tombstones' IN source)=0 THEN
  EXECUTE replace(source,' SELECT artifact_evidence_allowed_before_opc',
   E' -- D7 source tombstones\n SELECT NOT EXISTS(SELECT 1 FROM artifact_projects WHERE id=project AND erased_at IS NOT NULL)\n AND NOT EXISTS(SELECT 1 FROM artifact_evidence WHERE ids ? id::text AND erased_at IS NOT NULL)\n AND artifact_evidence_allowed_before_opc');
 END IF;
 source:=pg_get_functiondef('public.artifact_query_before_opc(uuid,text,uuid,uuid)'::regprocedure);
 IF position('-- D7 project list' IN source)=0 THEN
  IF position('FROM artifact_projects ap WHERE actor_id=p_actor_id);' IN source)=0 THEN
   RAISE EXCEPTION 'D7 project list boundary mismatch'; END IF;
  EXECUTE replace(source,'FROM artifact_projects ap WHERE actor_id=p_actor_id);',
   E'FROM artifact_projects ap WHERE actor_id=p_actor_id AND ap.erased_at IS NULL AND ap.content_deleted_at IS NULL); -- D7 project list');
 END IF;
 source:=pg_get_functiondef('public.artifact_query(uuid,text,uuid,uuid)'::regprocedure);
 IF position('-- D7 project read' IN source)=0 THEN
  EXECUTE regexp_replace(source,'\mBEGIN\M',$patch$BEGIN
 -- D7 project read
 IF EXISTS(SELECT 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id AND erased_at IS NOT NULL)
 THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
$patch$);
 END IF;
 source:=pg_get_functiondef('public.bill2_scope_allowed(uuid,jsonb)'::regprocedure);
 IF position('-- D7 scope tombstones' IN source)=0 THEN
  IF position(' SELECT (bill2_scope_allowed_before_topic' IN source)=0 THEN RAISE EXCEPTION 'CONTENT_ERASURE_SOURCE_MISMATCH: scope';END IF;
  EXECUTE replace(source,' SELECT (bill2_scope_allowed_before_topic',
   E' -- D7 scope tombstones\n SELECT NOT EXISTS(SELECT 1 FROM artifact_projects p WHERE p.actor_id=a AND p.erased_at IS NOT NULL\n AND (p.id::text=s->>''projectId'' OR p.id::text=s->>''workItemId''\n OR p.id IN (SELECT project_id FROM opc_drafts WHERE draft_id::text=s->>''draftId'')))\n AND (bill2_scope_allowed_before_topic');
 END IF;
END $$;
-- Check research tombstones only after the authoritative plan lock and ownership check.
-- Unsettled terminal charges are refused above so this never interrupts their original recovery.
DO $$ DECLARE source text; sig text; needle text; BEGIN
 FOREACH sig IN ARRAY ARRAY['research_transition(text,uuid,uuid,uuid,jsonb)','research_lookup(uuid,uuid,uuid)'] LOOP
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('-- D7 research tombstones' IN source)=0 THEN
   needle:=CASE WHEN sig LIKE 'research_transition%' THEN
    'IF NOT FOUND OR p.actor_id<>p_actor_id THEN RAISE EXCEPTION ''research denied'' USING ERRCODE=''42501''; END IF;'
    ELSE 'IF p.actor_id<>p_actor_id THEN RAISE EXCEPTION ''research denied'' USING ERRCODE=''42501''; END IF;' END;
   IF position(needle IN source)=0 THEN RAISE EXCEPTION 'D7 research boundary mismatch'; END IF;
   EXECUTE replace(source,needle,needle||E'\n -- D7 research tombstones\n IF p.erased_at IS NOT NULL OR EXISTS(SELECT 1 FROM research_operations WHERE id=p_operation_id AND plan_id=p.id AND erased_at IS NOT NULL) THEN RAISE EXCEPTION ''CONTENT_ERASED'' USING ERRCODE=''42501''; END IF;');
  END IF;
 END LOOP;
END $$;

-- Serialize late child inserts with the same parent rows locked by confirmation.
-- No table grants change; these guards also cover an RPC admitted before deletion.
CREATE OR REPLACE FUNCTION public.content_erasure_parent_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE j jsonb:=to_jsonb(NEW);sid uuid;eid uuid;pid uuid;deleted boolean;
BEGIN
 IF TG_TABLE_NAME IN ('runtime_executions','runtime_scope_material','runtime_session_history','runtime_session_batches') THEN
  sid:=(j->>'session_id')::uuid;
  SELECT erased_at IS NOT NULL OR content_deleted_at IS NOT NULL INTO deleted FROM runtime_sessions WHERE id=sid FOR SHARE;
  IF deleted THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME IN ('runtime_session_history','runtime_session_batches','runtime_tool_calls','runtime_history_dependencies','opc_content_versions') THEN
  eid:=(j->>'execution_id')::uuid;
  SELECT erased_at IS NOT NULL OR content_deleted_at IS NOT NULL INTO deleted FROM runtime_executions WHERE id=eid FOR SHARE;
  IF deleted THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME='runtime_history_dependencies' THEN
  SELECT erased_at IS NOT NULL OR content_deleted_at IS NOT NULL INTO deleted FROM runtime_executions WHERE id=(j->>'dependency_id')::uuid FOR SHARE;
  IF deleted THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME IN ('artifact_rounds','artifact_versions','artifact_requests','artifact_evidence','artifact_generations','artifact_chats') THEN
  pid:=(j->>'project_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('artifact_candidates','artifact_confirmations') THEN
  SELECT project_id INTO pid FROM artifact_rounds WHERE id=(j->>'round_id')::uuid;
 ELSIF TG_TABLE_NAME='artifact_chat_turns' THEN
  SELECT project_id INTO pid FROM artifact_chats WHERE conversation_id=(j->>'conversation_id')::uuid;
 ELSIF TG_TABLE_NAME='artifact_chat_summaries' THEN
  SELECT c.project_id INTO pid FROM artifact_chats c JOIN artifact_chat_turns t ON t.conversation_id=c.conversation_id
   WHERE t.request_id=(j->>'turn_id')::uuid;
 ELSIF TG_TABLE_NAME IN ('opc_content_versions','opc_work_ui','opc_publication_ui') THEN pid:=(j->>'work_item_id')::uuid;
 ELSIF TG_TABLE_NAME='opc_account_ui' THEN pid:=(j->>'account_project_id')::uuid;
 END IF;
 IF pid IS NOT NULL THEN
  SELECT erased_at IS NOT NULL OR content_deleted_at IS NOT NULL INTO deleted FROM artifact_projects WHERE id=pid FOR SHARE;
  IF deleted THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 IF TG_TABLE_NAME='opc_content_versions' AND j->>'source_content_id' IS NOT NULL THEN
  -- Source reads stay denied; independently saved existing bodies are not new source grants.
  IF NOT opc_content_allowed((j->>'actor_id')::uuid,(j->>'source_content_id')::uuid) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_parent_guard() FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['runtime_executions','runtime_scope_material','runtime_session_history','runtime_session_batches',
  'runtime_tool_calls','runtime_history_dependencies','artifact_chats','artifact_chat_turns','artifact_chat_summaries','artifact_rounds','artifact_versions','artifact_requests','artifact_evidence',
  'artifact_generations','artifact_candidates','artifact_confirmations','opc_content_versions'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS content_erasure_parent_guard ON public.%I',t);
  EXECUTE format('CREATE TRIGGER content_erasure_parent_guard BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION content_erasure_parent_guard()',t);
 END LOOP;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['opc_work_ui','opc_account_ui','opc_publication_ui'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS content_erasure_parent_guard ON public.%I',t);
  EXECUTE format('CREATE TRIGGER content_erasure_parent_guard BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION content_erasure_parent_guard()',t);
 END LOOP;
END $$;
-- Read-only saved-result availability is separate from permission to reuse a source.
CREATE OR REPLACE FUNCTION public.content_erasure_artifact_readable(a uuid,vid uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE v artifact_versions;p artifact_projects;r artifact_rounds;eid text;
BEGIN
 SELECT * INTO v FROM artifact_versions WHERE id=vid AND erased_at IS NULL;
 SELECT * INTO p FROM artifact_projects WHERE id=v.project_id AND actor_id=a AND erased_at IS NULL;
 SELECT * INTO r FROM artifact_rounds WHERE id=v.round_id AND erased_at IS NULL AND state='published';
 IF v.id IS NULL OR p.id IS NULL OR r.id IS NULL THEN RETURN false; END IF;
 PERFORM bill2_actor(a);
 PERFORM read_skill_package(a,p.module_id,p.skill_id,r.revision_id,r.package_hash,NULL);
 IF artifact_evidence_allowed(p.id,v.evidence_ids) THEN RETURN true; END IF;
 FOR eid IN SELECT jsonb_array_elements_text(v.evidence_ids) LOOP
  IF EXISTS(SELECT 1 FROM artifact_evidence_restrictions WHERE evidence_id::text=eid
   AND (deleted OR expires_at<=clock_timestamp())) THEN RETURN false; END IF;
  IF NOT artifact_evidence_allowed(p.id,jsonb_build_array(eid)) AND NOT EXISTS(
   SELECT 1 FROM opc_result_links l JOIN runtime_executions e ON e.id=l.execution_id
    JOIN artifact_evidence ev ON ev.id=l.evidence_id
   WHERE l.evidence_id::text=eid AND ev.project_id=p.id AND e.actor_id=a AND e.content_deleted_at IS NOT NULL
   UNION ALL
   SELECT 1 FROM artifact_work_references ref JOIN artifact_versions src ON src.id=ref.source_version_id
    JOIN artifact_projects owner ON owner.id=src.project_id
   WHERE ref.evidence_id::text=eid AND ref.project_id=p.id AND owner.actor_id=a AND owner.content_deleted_at IS NOT NULL
  ) THEN RETURN false; END IF;
 END LOOP;
 RETURN true;
EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.content_erasure_artifact_readable(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $$ DECLARE source text; BEGIN
 source:=pg_get_functiondef('public.artifact_transition(uuid,uuid,uuid,text,uuid,uuid,uuid,jsonb)'::regprocedure);
 IF position('-- D7 saved report read' IN source)=0 THEN
  EXECUTE regexp_replace(source,'\mBEGIN\M',$patch$BEGIN
 -- D7 saved report read
 IF EXISTS(SELECT 1 FROM artifact_projects WHERE id=p_project_id AND actor_id=p_actor_id AND erased_at IS NOT NULL)
 THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
 IF p_action='report' AND EXISTS(SELECT 1 FROM artifact_versions v JOIN artifact_projects p ON p.id=v.project_id
  WHERE v.round_id=p_round_id AND p.id=p_project_id AND p.actor_id=p_actor_id
   AND p.module_id=p_module_id AND p.skill_id=p_skill_id AND content_erasure_artifact_readable(p_actor_id,v.id)) THEN
  RETURN (SELECT jsonb_build_object('available',true,'sourceAvailable',artifact_evidence_allowed(v.project_id,v.evidence_ids),
   'version',v.version,'id',v.id,'report',v.report,'hash',v.report_hash) FROM artifact_versions v WHERE v.round_id=p_round_id AND v.project_id=p_project_id);
 END IF;
$patch$);
 END IF;
 source:=pg_get_functiondef('public.opc_work_results(uuid,uuid)'::regprocedure);
 IF position('content_erasure_artifact_readable' IN source)=0 THEN
  source:=replace(source,'s.id IS NULL OR NOT bill2_scope_allowed(p_actor_id,s.scope)',
   's.id IS NULL OR (s.content_deleted_at IS NULL AND NOT bill2_scope_allowed(p_actor_id,s.scope))');
  source:=replace(source,'artifact_evidence_allowed(v.project_id,v.evidence_ids)','content_erasure_artifact_readable(p_actor_id,v.id)');
  source:=replace(source,$old$'artifactId',v.id,'version',v.version,$old$,
   $new$'artifactId',v.id,'version',v.version,'sourceAvailable',artifact_evidence_allowed(v.project_id,v.evidence_ids),$new$);
  EXECUTE source;
 END IF;
END $$;
COMMIT;
