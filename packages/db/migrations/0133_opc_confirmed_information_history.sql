/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Retain previously confirmed fields for explicit reconfirmation after edits.
-- Read-only metadata from existing history; no new storage, API or grants.
-- Rollback: restore opc_query from 0120; saved information remains untouched.
BEGIN;
CREATE OR REPLACE FUNCTION opc_query(p_actor_id uuid,p_draft_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result jsonb;information jsonb;
BEGIN
 result:=opc_query_before_entry_projection(p_actor_id,p_draft_id);
 IF p_draft_id IS NOT NULL THEN
  -- The predecessor already verifies actor ownership and source access. Only
  -- successful immutable writes of this same project/round/step can prove a
  -- field was confirmed; a revision may also inherit confirmed fields from its
  -- exact published predecessor. Reach alone includes deferred questions.
  SELECT jsonb_object_agg(info.key,info.value || jsonb_build_object('previouslyConfirmed',coalesce((
   SELECT jsonb_agg(field->>'id' ORDER BY ord)
   FROM jsonb_array_elements(info.value->'schema') WITH ORDINALITY fields(field,ord)
   WHERE EXISTS(SELECT 1 FROM artifact_requests a
    WHERE a.project_id=(result->>'projectId')::uuid AND a.round_id=(result->>'roundId')::uuid
     AND a.action='opc_information' AND a.payload->>'stepId'=info.key
     AND a.payload->'values'->(field->>'id')->>'status'='confirmed')
    OR EXISTS(SELECT 1 FROM artifact_requests revision
     JOIN artifact_rounds prior ON prior.id=(revision.payload->>'fromRoundId')::uuid
      AND prior.project_id=revision.project_id AND prior.state='published'
     WHERE revision.project_id=(result->>'projectId')::uuid AND revision.round_id=(result->>'roundId')::uuid
      AND revision.request_id=revision.round_id AND revision.action='opc_revision'
      AND prior.steps->info.key->'information'->(field->>'id')->>'status'='confirmed')
  ),'[]'::jsonb))) INTO information FROM jsonb_each(result->'information') info;
  RETURN jsonb_set(result,'{information}',coalesce(information,'{}'::jsonb));
 END IF;
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
