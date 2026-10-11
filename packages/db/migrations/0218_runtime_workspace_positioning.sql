/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- RUNTIME-PROD: free conversations can read the user's own confirmed positioning
-- before any social account is bound. Only 0131's runtime_workspace_source changes:
-- each business's current published positioning (opc_businesses.current_source_version_id)
-- is listed beside account strategies and topics. The same owner/session gate,
-- opc_source_allowed check (owned, published, not erased, draft not revoked), 40-entry
-- index, 4000-character body and dependency recheck apply; erased businesses are skipped. Unpublished
-- rounds never have a version, so drafts stay unreadable. Positioning is listed
-- first so many topics cannot push it out of the index; the confirmation time tells
-- apart profiles that still carry the default name.
BEGIN;
CREATE OR REPLACE FUNCTION runtime_workspace_source(p_actor_id uuid,p_session_id uuid,p_query text DEFAULT '') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE entries jsonb;entry jsonb;body text;version_id uuid;
BEGIN
 IF NOT runtime_workspace_session(p_actor_id,p_session_id) THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_DENIED';END IF;
 IF length(coalesce(p_query,''))>2000 THEN RAISE EXCEPTION 'RUNTIME_WORKSPACE_QUERY_DENIED';END IF;
 -- Metadata is requested by the model, not loaded into every conversation.
 SELECT coalesce(jsonb_agg(x.entry ORDER BY x.rank,x.id),'[]') INTO entries FROM (
  SELECT 0 rank,b.id::text id,jsonb_build_object('id',b.id,'kind','positioning','name',b.name,'confirmedAt',v.created_at,'sourceVersionId',b.current_source_version_id) entry
  FROM opc_businesses b JOIN artifact_versions v ON v.id=b.current_source_version_id WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id IS NOT NULL
   AND opc_source_allowed(p_actor_id,b.current_source_version_id)
  UNION ALL
  SELECT 1,ac.project_id::text,jsonb_build_object('id',ac.project_id,'kind','strategy','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'sourceVersionId',ac.source_version_id)
  FROM opc_accounts ac WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,ac.source_version_id)
  UNION ALL
  SELECT 1,i.work_item_id::text,jsonb_build_object('id',i.work_item_id,'kind','topic','platform',ac.platform,'account',coalesce((SELECT display_name FROM opc_account_ui WHERE actor_id=p_actor_id AND account_project_id=ac.project_id),ac.account_key),'title',coalesce((SELECT title FROM opc_item_edits WHERE work_item_id=i.work_item_id),p.work_title),'sourceVersionId',i.source_version_id)
  FROM opc_items i JOIN opc_accounts ac ON ac.project_id=i.account_project_id JOIN artifact_projects p ON p.id=i.work_item_id AND p.actor_id=p_actor_id
  WHERE ac.actor_id=p_actor_id AND opc_source_allowed(p_actor_id,i.source_version_id)
  ORDER BY rank,id LIMIT 40
 ) x;
 IF coalesce(p_query,'')='' THEN
  RETURN jsonb_build_object('kind','workspace_index','entries',entries,'limit',40,'dependencies',(SELECT coalesce(jsonb_agg(DISTINCT x->>'sourceVersionId'),'[]') FROM jsonb_array_elements(entries) x));
 END IF;
 SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'id'=p_query;
 IF entry IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
 version_id:=(entry->>'sourceVersionId')::uuid;
 IF entry->>'kind' IN ('strategy','positioning') THEN body:=opc_profile(version_id)::text;
 ELSE SELECT coalesce((SELECT ed.brief FROM opc_item_edits ed WHERE ed.work_item_id=i.work_item_id),i.brief) INTO body FROM opc_items i WHERE i.work_item_id=(entry->>'id')::uuid;END IF;
 RETURN jsonb_build_object('kind','workspace_source','identity',entry,'body',left(body,4000),'truncated',length(body)>4000,'dependencies',jsonb_build_array(version_id));
END $$;
REVOKE ALL ON FUNCTION runtime_workspace_source(uuid,uuid,text) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION runtime_workspace_source(uuid,uuid,text) TO service_role;
COMMIT;
