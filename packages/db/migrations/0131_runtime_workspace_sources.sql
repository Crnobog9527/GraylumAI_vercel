/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Model-requested, read-only context for free conversations. No account data is
-- injected at admission. Existing source permissions apply to reads and history.
BEGIN;
CREATE OR REPLACE FUNCTION runtime_workspace_session(p_actor_id uuid,p_session_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(p_actor_id);
 RETURN EXISTS(SELECT 1 FROM runtime_sessions s WHERE s.id=p_session_id AND s.actor_id=p_actor_id
  AND s.scope->>'kind'='positioning_draft' AND bill2_scope_allowed(p_actor_id,s.scope)
  AND NOT EXISTS(SELECT 1 FROM opc_drafts d WHERE d.session_id=s.id)
  AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces w WHERE w.session_id=s.id));
END $$;
CREATE OR REPLACE FUNCTION runtime_workspace_source(p_actor_id uuid,p_session_id uuid,p_query text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entries jsonb;entry jsonb;body text;version_id uuid;
BEGIN
 IF NOT runtime_workspace_session(p_actor_id,p_session_id) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_DENIED';END IF;
 IF length(coalesce(p_query,''))>2000 THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_QUERY_DENIED';END IF;
 -- Metadata is requested by the model, not loaded into every conversation.
 SELECT coalesce(jsonb_agg(x.entry ORDER BY x.id),'[]') INTO entries FROM (
  SELECT ac.project_id::text id,jsonb_build_object('id',ac.project_id,'kind','strategy','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'sourceVersionId',ac.source_version_id) entry
  FROM opc_accounts ac WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,ac.source_version_id)
  UNION ALL
  SELECT i.work_item_id::text,jsonb_build_object('id',i.work_item_id,'kind','topic','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'title',coalesce((SELECT title FROM opc_item_edits WHERE work_item_id=i.work_item_id),p.work_title),'sourceVersionId',i.source_version_id)
  FROM opc_items i JOIN opc_accounts ac ON ac.project_id=i.account_project_id JOIN artifact_projects p ON p.id=i.work_item_id AND p.actor_id=p_actor_id
  WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,i.source_version_id)
  ORDER BY id LIMIT 40
 ) x;
 IF coalesce(p_query,'')='' THEN
  RETURN jsonb_build_object('kind','workspace_index','entries',entries,'limit',40,'dependencies',(SELECT coalesce(jsonb_agg(DISTINCT x->>'sourceVersionId'),'[]') FROM jsonb_array_elements(entries) x));
 END IF;
 SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'id'=p_query;
 IF entry IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
 version_id:=(entry->>'sourceVersionId')::uuid;
 IF entry->>'kind'='strategy' THEN body:=opc_profile(version_id)::text;
 ELSE SELECT coalesce((SELECT ed.brief FROM opc_item_edits ed WHERE ed.work_item_id=i.work_item_id),i.brief) INTO body FROM opc_items i WHERE i.work_item_id=(entry->>'id')::uuid;END IF;
 RETURN jsonb_build_object('kind','workspace_source','identity',entry,'body',left(body,4000),'truncated',length(body)>4000,'dependencies',jsonb_build_array(version_id));
END $$;
DO $$ BEGIN
 IF to_regprocedure('runtime_context_allowed_before_workspace(uuid,jsonb)') IS NULL THEN
  ALTER FUNCTION runtime_context_allowed(uuid,jsonb) RENAME TO runtime_context_allowed_before_workspace;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION runtime_context_allowed(p_actor_id uuid,p_context jsonb) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE dep text;
BEGIN
 PERFORM runtime_context_allowed_before_workspace(p_actor_id,p_context);
 IF p_context->>'workspaceContext'='true' THEN
  IF NOT runtime_workspace_session(p_actor_id,(p_context->'request'->>'sessionId')::uuid) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_DENIED';END IF;
  -- Retrieved snapshots remain immutable, but source revocation invalidates both
  -- replay and descendant history through the existing context dependency check.
  FOR dep IN SELECT jsonb_array_elements_text(t.result->'dependencies')
   FROM runtime_executions e JOIN runtime_tool_calls t ON t.execution_id=e.id
   WHERE e.actor_id=p_actor_id AND e.request_id=(p_context->'request'->>'requestId')::uuid AND e.session_id=(p_context->'request'->>'sessionId')::uuid
    AND t.name='read_source' AND t.result IS NOT NULL
  LOOP
   IF NOT opc_source_allowed(p_actor_id,dep::uuid) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_SOURCE_REVOKED';END IF;
  END LOOP;
 END IF;
END $$;
REVOKE ALL ON FUNCTION runtime_context_allowed_before_workspace(uuid,jsonb),runtime_context_allowed(uuid,jsonb),runtime_workspace_session(uuid,uuid),runtime_workspace_source(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION runtime_workspace_session(uuid,uuid),runtime_workspace_source(uuid,uuid,text) TO service_role;
COMMIT;
