/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Read-only projection of existing business/draft/work-method identity.
-- No additional authority, writes, table access or dispatch permission.
BEGIN;
DO $$ BEGIN
 IF to_regprocedure('opc_query_before_entry_projection(uuid,uuid)') IS NULL THEN
  ALTER FUNCTION opc_query(uuid,uuid) RENAME TO opc_query_before_entry_projection;
 END IF;
END $$;
CREATE OR REPLACE FUNCTION opc_query(p_actor_id uuid,p_draft_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;
BEGIN
 result:=opc_query_before_entry_projection(p_actor_id,p_draft_id);
 IF p_draft_id IS NOT NULL THEN RETURN result;END IF;
 result:=jsonb_set(result,'{drafts}',coalesce((SELECT jsonb_agg(entry || jsonb_build_object(
   'businessId',b.id,'businessName',b.name,'createdAt',p.created_at,'currentVersion',p.current_version,'state',r.state) ORDER BY p.created_at DESC,p.id)
  FROM jsonb_array_elements(result->'drafts') entry
  JOIN opc_drafts d ON d.draft_id=(entry->>'draftId')::uuid AND d.actor_id=p_actor_id
  JOIN opc_draft_businesses db ON db.draft_id=d.draft_id
  JOIN opc_businesses b ON b.id=db.business_id AND b.actor_id=p_actor_id
  JOIN artifact_projects p ON p.id=d.project_id AND p.actor_id=p_actor_id
  JOIN artifact_rounds r ON r.id=d.round_id),'[]'::jsonb));
 result:=jsonb_set(result,'{accounts}',coalesce((SELECT jsonb_agg(jsonb_set(account,'{items}',coalesce((
  SELECT jsonb_agg(item || jsonb_build_object('moduleId',p.module_id,'methodRevisionId',r.revision_id))
  FROM jsonb_array_elements(account->'items') item
  JOIN artifact_projects p ON p.id=(item->>'workItemId')::uuid AND p.actor_id=p_actor_id
  JOIN opc_items i ON i.work_item_id=p.id
  JOIN artifact_versions v ON v.id=i.source_version_id
  JOIN artifact_rounds r ON r.id=v.round_id
 ),'[]'::jsonb))) FROM jsonb_array_elements(result->'accounts') account),'[]'::jsonb));
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION opc_query_before_entry_projection(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION opc_query(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION opc_query(uuid,uuid) TO service_role;
COMMIT;
