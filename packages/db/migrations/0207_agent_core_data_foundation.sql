-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- AGENT-CORE R9. Number assigned by controller on #782. No remote application.
BEGIN;
-- Existing records retain unknown historical times; only future inserts use the default.
-- Cover the audited OPC/artifact/runtime records, including source snapshots and action caches.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY[
  'artifact_accounts','artifact_chat_summaries','artifact_chats','artifact_evidence_restrictions',
  'artifact_reference_configs','artifact_requests','artifact_work_references','artifact_workflows',
  'opc_account_strategy_drafts','opc_account_strategy_request_bases','opc_account_ui','opc_accounts',
  'opc_draft_businesses','opc_drafts','opc_handoffs','opc_item_edits','opc_items','opc_publication_ui',
  'opc_result_links','opc_turns','opc_work_ui','runtime_history_dependencies','runtime_scope_material',
  'runtime_session_batches','runtime_session_history','runtime_tool_calls'] LOOP
  EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS created_at timestamptz',t);
  EXECUTE format('ALTER TABLE public.%I ALTER COLUMN created_at SET DEFAULT clock_timestamp()',t);
 END LOOP;
END $$;
-- Existing version tables remain authoritative for saved content. This small source/action
-- table covers the missing execution-to-adoption link and explicit rewrite/abandon signals.
-- Physical erasure removes it: it is not a financial or permanent audit ledger.
CREATE TABLE IF NOT EXISTS public.opc_data_events (
 actor_id uuid NOT NULL REFERENCES profiles(id), request_id uuid NOT NULL, item_key text NOT NULL,
 action text NOT NULL CHECK(action IN ('topic_draft','topic_adoption','rewrite','abandon')),
 execution_id uuid NOT NULL REFERENCES runtime_executions(id),
 project_id uuid REFERENCES artifact_projects(id), target_project_id uuid REFERENCES artifact_projects(id),
 source_version_id uuid REFERENCES artifact_versions(id),
 original jsonb, adopted jsonb, reason text CHECK(length(reason)<=1000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(actor_id,request_id,item_key), CHECK(octet_length(original::text)<=262144),
 CHECK(octet_length(adopted::text)<=64000)
);
CREATE INDEX IF NOT EXISTS opc_data_events_execution ON opc_data_events(execution_id);
ALTER TABLE opc_data_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON opc_data_events FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.opc_data_execution(a uuid,eid uuid) RETURNS runtime_executions
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;s runtime_sessions;
BEGIN
 PERFORM 1 FROM profiles WHERE id=a FOR SHARE;
 PERFORM bill2_actor(a);
 SELECT * INTO e FROM runtime_executions WHERE id=eid AND actor_id=a;
 IF NOT FOUND THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 SELECT * INTO s FROM runtime_sessions WHERE id=e.session_id AND actor_id=a FOR SHARE;
 -- Re-read after the session lock: D7 deletion locks sessions before executions.
 SELECT * INTO e FROM runtime_executions WHERE id=eid AND actor_id=a;
 IF s.id IS NULL OR e.state<>'completed' OR NOT runtime_history_available(e.id)
  OR s.content_deleted_at IS NOT NULL OR e.content_deleted_at IS NOT NULL
  OR NOT coalesce(bill2_scope_allowed(a,s.scope),false)
 THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 RETURN e;
END $$;
CREATE OR REPLACE FUNCTION public.opc_data_event_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'OPC_DATA_IMMUTABLE';END IF;
 PERFORM opc_data_execution(NEW.actor_id,NEW.execution_id);
 IF NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM artifact_projects
  WHERE id=NEW.project_id AND actor_id=NEW.actor_id AND erased_at IS NULL AND content_deleted_at IS NULL)
 THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_DENIED';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS opc_data_event_guard ON opc_data_events;
CREATE TRIGGER opc_data_event_guard BEFORE INSERT OR UPDATE ON opc_data_events
 FOR EACH ROW EXECUTE FUNCTION opc_data_event_guard();

-- This parses an existing structured output envelope; it does not infer user intent.
CREATE OR REPLACE FUNCTION public.opc_topic_original(a uuid,did uuid,vid uuid,eid uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;w opc_topic_workspaces;d opc_drafts;raw text;part text[];candidate jsonb;result jsonb;
BEGIN
 e:=opc_data_execution(a,eid);
 SELECT * INTO d FROM opc_drafts WHERE draft_id=did AND actor_id=a;
 SELECT * INTO w FROM opc_topic_workspaces WHERE draft_id=did AND actor_id=a;
 IF d.draft_id IS NULL OR w.session_id IS DISTINCT FROM e.session_id OR w.source_version_id IS DISTINCT FROM vid
  OR NOT opc_source_allowed(a,vid) THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 raw:=coalesce(e.result->>'body',e.primary_result->>'body');
 IF raw IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 FOR part IN SELECT regexp_matches(raw,'```(?:json)?\s*(\[[\s\S]*?\])\s*```','g') LOOP
  BEGIN
   candidate:=part[1]::jsonb;
   IF jsonb_typeof(candidate)='array' AND jsonb_array_length(candidate) BETWEEN 1 AND 28 THEN result:=candidate;END IF;
  EXCEPTION WHEN invalid_text_representation THEN NULL;END;
 END LOOP;
 BEGIN
  candidate:=btrim(raw)::jsonb;
  IF jsonb_typeof(candidate)='array' AND jsonb_array_length(candidate) BETWEEN 1 AND 28 THEN result:=candidate;END IF;
 EXCEPTION WHEN invalid_text_representation THEN NULL;END;
 IF result IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(result) x
  WHERE jsonb_typeof(x)<>'object' OR coalesce(x->>'id','')!~*'^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
   OR nullif(btrim(x->>'title'),'') IS NULL OR nullif(btrim(x->>'brief'),'') IS NULL)
  OR (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(result) x)<>jsonb_array_length(result)
 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.opc_topic_draft_from_execution(
 p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_expected_version bigint,p_source_version_id uuid,
 p_execution_id uuid,p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE original jsonb;result jsonb;prior opc_data_events;project uuid;
BEGIN
 original:=opc_topic_original(p_actor_id,p_draft_id,p_source_version_id,p_execution_id);
 SELECT project_id INTO project FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 PERFORM 1 FROM artifact_projects WHERE id=project FOR UPDATE;
 IF jsonb_typeof(p_body) IS DISTINCT FROM 'array' OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_body) x
  WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(original) o WHERE o->>'id'=x->>'id'))
 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 SELECT * INTO prior FROM opc_data_events WHERE actor_id=p_actor_id AND request_id=p_request_id AND item_key='';
 IF FOUND AND (prior.action<>'topic_draft' OR prior.execution_id<>p_execution_id OR prior.project_id<>project
  OR prior.source_version_id<>p_source_version_id OR prior.adopted IS DISTINCT FROM p_body)
 THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
 result:=opc_topic_draft_save(p_actor_id,p_draft_id,p_request_id,p_expected_version,p_source_version_id,p_body);
 IF prior.request_id IS NULL THEN
  INSERT INTO opc_data_events(actor_id,request_id,item_key,action,execution_id,project_id,source_version_id,original,adopted)
  VALUES(p_actor_id,p_request_id,'','topic_draft',p_execution_id,project,p_source_version_id,original,p_body);
 END IF;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.opc_adopt_topics_with_source(
 p_actor_id uuid,p_draft_id uuid,p_request_id uuid,p_expected_version bigint,p_source_version_id uuid,
 p_body jsonb,p_accounts jsonb,p_sources jsonb DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE item jsonb;original jsonb;eid uuid;ids uuid[];project uuid;result jsonb;bound jsonb:='[]';prior opc_data_events;
BEGIN
 PERFORM 1 FROM profiles WHERE id=p_actor_id FOR SHARE;PERFORM bill2_actor(p_actor_id);
 -- Same actor lock as the existing adoption RPC, before project locking.
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text,107));
 SELECT project_id INTO project FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
 IF project IS NULL THEN RAISE EXCEPTION 'OPC_DENIED';END IF;
 IF jsonb_typeof(p_body) IS DISTINCT FROM 'array' OR jsonb_array_length(p_body) NOT BETWEEN 1 AND 28
 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 IF p_sources IS NOT NULL AND (jsonb_typeof(p_sources) IS DISTINCT FROM 'array'
  OR jsonb_array_length(p_sources)<>jsonb_array_length(p_body)
  OR (SELECT count(DISTINCT x->>'itemId') FROM jsonb_array_elements(p_sources) x)<>jsonb_array_length(p_body)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_sources) x WHERE x-ARRAY['itemId','executionId']<>'{}'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_body) i WHERE i->>'id'=x->>'itemId')))
 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_body) LOOP
  SELECT * INTO prior FROM opc_data_events WHERE actor_id=p_actor_id AND request_id=p_request_id AND item_key=item->>'id';
  IF p_sources IS NOT NULL THEN
   SELECT (x->>'executionId')::uuid INTO eid FROM jsonb_array_elements(p_sources) x WHERE x->>'itemId'=item->>'id';
  ELSIF prior.request_id IS NOT NULL THEN eid:=prior.execution_id;
  ELSE
   -- Legacy clients are accepted only when durable source records prove one execution.
   SELECT array_agg(DISTINCT candidate.id) INTO ids FROM (
    SELECT event.execution_id AS id FROM opc_data_events event
    WHERE event.actor_id=p_actor_id AND event.project_id=project AND event.source_version_id=p_source_version_id
     AND event.action='topic_draft' AND EXISTS(SELECT 1 FROM jsonb_array_elements(event.original) o WHERE o->>'id'=item->>'id')
    UNION
    -- The shipped topic client used the execution UUID as its draft-save request UUID.
    -- Verify the same owned workspace and actual execution output below; never infer by time.
    SELECT e.id FROM opc_topic_draft_versions v JOIN runtime_executions e ON e.id=v.request_id
     JOIN opc_topic_workspaces w ON w.draft_id=v.draft_id AND w.session_id=e.session_id
    WHERE v.actor_id=p_actor_id AND e.actor_id=p_actor_id AND v.draft_id=p_draft_id
     AND v.source_version_id=p_source_version_id AND v.erased_at IS NULL AND e.state='completed'
     AND runtime_history_available(e.id)
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.body) o WHERE o->>'id'=item->>'id')
   ) candidate;
   IF cardinality(ids) IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_REQUIRED';END IF;
   eid:=ids[1];
  END IF;
  original:=opc_topic_original(p_actor_id,p_draft_id,p_source_version_id,eid);
  SELECT o INTO original FROM jsonb_array_elements(original) o WHERE o->>'id'=item->>'id';
  IF original IS NULL THEN RAISE EXCEPTION 'OPC_TOPIC_SOURCE_INVALID';END IF;
  IF prior.request_id IS NOT NULL AND (prior.action<>'topic_adoption' OR prior.project_id<>project
   OR prior.execution_id<>eid OR prior.adopted IS DISTINCT FROM item OR prior.source_version_id<>p_source_version_id)
  THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  bound:=bound||jsonb_build_array(jsonb_build_object('executionId',eid,'original',original,'adopted',item));
 END LOOP;
 result:=opc_adopt_topics(p_actor_id,p_draft_id,p_request_id,p_expected_version,p_source_version_id,p_body,p_accounts);
 FOR item IN SELECT value FROM jsonb_array_elements(bound) LOOP
  INSERT INTO opc_data_events(actor_id,request_id,item_key,action,execution_id,project_id,target_project_id,
   source_version_id,original,adopted)
  SELECT p_actor_id,p_request_id,item#>>'{adopted,id}','topic_adoption',(item->>'executionId')::uuid,project,
   i.work_item_id,p_source_version_id,item->'original',item->'adopted'
  FROM opc_items i WHERE i.plan_id=(result->>'planId')::uuid AND i.item_key=(item#>>'{adopted,id}')::uuid
  ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN result;
END $$;
CREATE OR REPLACE FUNCTION public.opc_content_reaction(
 p_actor_id uuid,p_request_id uuid,p_execution_id uuid,p_action text,p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;prior opc_data_events;project uuid;
BEGIN
 IF p_request_id IS NULL OR p_action IS NULL OR p_action NOT IN ('rewrite','abandon') OR length(p_reason)>1000
 THEN RAISE EXCEPTION 'OPC_DATA_EVENT_INVALID';END IF;
 e:=opc_data_execution(p_actor_id,p_execution_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(p_actor_id::text||p_request_id::text,207));
 SELECT * INTO prior FROM opc_data_events WHERE actor_id=p_actor_id AND request_id=p_request_id AND item_key='';
 IF FOUND THEN
  IF prior.execution_id<>p_execution_id OR prior.action<>p_action OR prior.reason IS DISTINCT FROM p_reason
  THEN RAISE EXCEPTION 'OPC_REQUEST_CONFLICT';END IF;
  RETURN jsonb_build_object('recorded',true,'createdAt',prior.created_at);
 END IF;
 SELECT p.id INTO project FROM runtime_sessions s JOIN artifact_projects p
  ON p.actor_id=p_actor_id AND (p.id::text IN (s.scope->>'projectId',s.scope->>'workItemId')
   OR EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=s.id AND d.project_id=p.id))
  WHERE s.id=e.session_id ORDER BY p.id LIMIT 1;
 INSERT INTO opc_data_events(actor_id,request_id,item_key,action,execution_id,project_id,reason)
 VALUES(p_actor_id,p_request_id,'',p_action,p_execution_id,project,p_reason) RETURNING * INTO prior;
 RETURN jsonb_build_object('recorded',true,'createdAt',prior.created_at);
END $$;

-- Patch the live definitions at unique anchors. Do not replace predecessor migrations.
DO $$ DECLARE source text;sig text;needle text;replacement text;marker text; BEGIN
 FOR sig,needle,replacement,marker IN SELECT * FROM (VALUES
 ('opc_capture_resolve(uuid,uuid,uuid,text,text,uuid,text,text,integer)',
  $n$meta:=jsonb_build_object('source','user','fp',artifact_hash(value));$n$,
  $r$meta:=jsonb_build_object('source','user','fp',artifact_hash(value),'basis',suggestion->'basis',
   'executionId',p_execution_id,'acceptedAt',clock_timestamp(),'createdAt',suggestion->'createdAt');$r$,'accepted provenance'),
 ('opc_capture_apply(uuid,uuid,uuid)',
  $n$meta:=jsonb_build_object('source','capture','basis',patch->'basis','executionId',e.id,'fp',artifact_hash(value));$n$,
  $r$meta:=jsonb_build_object('source','capture','basis',patch->'basis','executionId',e.id,'fp',artifact_hash(value),
   'createdAt',clock_timestamp());$r$,'capture provenance'),
 ('opc_capture_apply(uuid,uuid,uuid)',
  $n$suggestion:=suggestion||jsonb_build_object('hash',artifact_hash(suggestion));$n$,
  $r$suggestion:=suggestion||jsonb_build_object('createdAt',clock_timestamp());
    suggestion:=suggestion||jsonb_build_object('hash',artifact_hash(suggestion));$r$,'suggestion time'),
 ('opc_information(uuid,uuid,text,uuid,integer,jsonb)',
  $n$coalesce(st->'fieldMeta'->(field->>'id'),'{}')||jsonb_build_object('source','user','fp',artifact_hash(value))$n$,
  $r$(coalesce(st->'fieldMeta'->(field->>'id'),'{}')-ARRAY['executionId','basis','acceptedAt'])
    ||jsonb_build_object('source','user','basis','user_statement','fp',artifact_hash(value),'createdAt',clock_timestamp(),
     'origin',coalesce(st#>ARRAY['fieldMeta',field->>'id','origin'],
      jsonb_strip_nulls(jsonb_build_object('executionId',st#>ARRAY['fieldMeta',field->>'id','executionId'],
       'basis',st#>ARRAY['fieldMeta',field->>'id','basis']))))$r$,'manual provenance'),
 ('runtime_work_projection(uuid,uuid,uuid)',
  $n$'basis',coalesce(st#>>ARRAY['fieldMeta',field_id,'basis'],'unknown'),$n$,
  $r$'basis',coalesce(st#>>ARRAY['fieldMeta',field_id,'basis'],'unknown'),
    'executionId',st#>ARRAY['fieldMeta',field_id,'executionId'],
    'origin',st#>ARRAY['fieldMeta',field_id,'origin'],'createdAt',st#>ARRAY['fieldMeta',field_id,'createdAt'],$r$,'frozen provenance'),
 ('content_erasure_capture_steps(jsonb)',
  $n$   v:=jsonb_set(v,ARRAY['fieldMeta',f.key],meta);$n$,
  $r$   IF meta->>'source'='user' AND (content_erasure_references(meta->'executionId',ids)
    OR content_erasure_references(meta->'origin',ids)) THEN
    meta:=(meta-ARRAY['executionId','origin'])||jsonb_build_object('sourceAvailable',false);changed:=true;
   END IF;
   v:=jsonb_set(v,ARRAY['fieldMeta',f.key],meta);$r$,'erase provenance'),
 ('content_erasure_scope(uuid,text,uuid)',
  $n$'affectedSources',dependents,'preservedSavedVersions',preserved);$n$,
  $r$'affectedSources',dependents,'preservedSavedVersions',preserved,
  'dataEvents',coalesce((SELECT jsonb_agg(jsonb_build_array(request_id,item_key,created_at) ORDER BY request_id,item_key)
   FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(executions) OR project_id=ANY(projects)
    OR target_project_id=ANY(projects) OR source_version_id=ANY(versions))),'[]'::jsonb));$r$,'erasure preview'),
 ('content_erasure_confirm(uuid,text,uuid,text)',
  $n$ UPDATE opc_topic_draft_versions SET request=NULL,body=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (source_version_id=ANY(versions) OR content_erasure_references(request,refs) OR content_erasure_references(body,refs));$n$,
  $r$ UPDATE opc_topic_draft_versions SET request=NULL,body=NULL,erased_at=stamp WHERE actor_id=a AND erased_at IS NULL
  AND (source_version_id=ANY(versions) OR request_id=ANY(ids)
   OR content_erasure_references(request,refs) OR content_erasure_references(body,refs)
   OR request_id IN (SELECT event.request_id FROM opc_data_events event WHERE event.actor_id=a
    AND event.action='topic_draft' AND event.execution_id=ANY(ids)));
 DELETE FROM opc_data_events WHERE actor_id=a AND (execution_id=ANY(ids) OR project_id=ANY(projects)
  OR target_project_id=ANY(projects) OR source_version_id=ANY(versions));$r$,'erasure content'),
 ('account_erasure_scrub_content(uuid)', $n$  RETURN counts;$n$,
  $r$  DELETE FROM opc_data_events WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('opc_data_events',n);
  RETURN counts;$r$,'account scrub'),
 ('account_erasure_body_remaining(uuid)', $n$total bigint:=0;$n$,
  $r$total bigint:=(SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id);$r$,'account proof'),
 ('account_erasure_business_remaining(uuid)', $n$SELECT public.library_erasure_remaining(p_profile_id)$n$,
  $r$SELECT (SELECT count(*) FROM opc_data_events WHERE actor_id=p_profile_id)
 +public.library_erasure_remaining(p_profile_id)$r$,'business proof')
 ) changes(signature,anchor,patch,label) LOOP
  marker:='-- R9 '||marker;
  source:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position(marker IN source)=0 THEN
   IF length(source)-length(replace(source,needle,''))<>length(needle)
   THEN RAISE EXCEPTION 'OPC_DATA_SOURCE_MISMATCH: % %',sig,marker;END IF;
   -- Put comments at the start of the body, not inside a SQL expression.
   source:=replace(source,needle,replacement);
   source:=replace(source,'AS $function$',E'AS $function$\n'||marker||E'\n');
   EXECUTE source;
  END IF;
 END LOOP;
END $$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('opc_data_execution','opc_data_event_guard','opc_topic_original',
   'opc_topic_draft_from_execution','opc_adopt_topics_with_source','opc_content_reaction') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) IN ('opc_topic_draft_from_execution','opc_adopt_topics_with_source','opc_content_reaction') THEN
   EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END IF;
 END LOOP;
END $$;
COMMIT;
