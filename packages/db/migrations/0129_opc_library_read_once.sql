/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Evaluate the unchanged ancestry/access check once per displayed version.
-- MATERIALIZED is statement-local: a later read rechecks withdrawals and ownership.
-- Keep the existing UI/account projection wrappers and their ACLs intact.
BEGIN;
CREATE OR REPLACE FUNCTION opc_library_before_workspace_ui(p_actor_id uuid,p_search text DEFAULT '',p_from date DEFAULT NULL,p_to date DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q text:='%'||lower(trim(coalesce(p_search,'')))||'%';
BEGIN
 PERFORM bill2_actor(p_actor_id);
 RETURN jsonb_build_object('businesses',coalesce((SELECT jsonb_agg(jsonb_build_object(
  'businessId',b.id,'name',b.name,'revision',b.revision,'sourceVersionId',b.current_source_version_id,
  'sourceAvailable',CASE WHEN b.current_source_version_id IS NULL THEN false ELSE opc_source_allowed(p_actor_id,b.current_source_version_id) END,
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('projectId',a.project_id,'platform',a.platform,'account',a.account_key,'stage',a.stage,'revision',a.revision,
   'strategyDraftId',(SELECT d.draft_id FROM artifact_versions v JOIN opc_drafts d ON d.project_id=v.project_id AND d.actor_id=p_actor_id
    WHERE v.id=a.source_version_id AND opc_source_allowed(p_actor_id,v.id)
     AND NOT EXISTS(SELECT 1 FROM bill2_drafts retired WHERE retired.id=d.draft_id AND retired.revoked)
    LIMIT 1),
   'items',coalesce((SELECT jsonb_agg(jsonb_build_object('workItemId',i.work_item_id,'title',coalesce(ed.title,p.work_title),'brief',CASE WHEN opc_source_allowed(p_actor_id,i.source_version_id) THEN coalesce(ed.brief,i.brief) ELSE NULL END,'day',coalesce(ed.day,i.day),'revision',coalesce(ed.revision,1),'contentType',opc_item_content_type(i.work_item_id),'sessionId',s.id,'sourceAvailable',opc_source_allowed(p_actor_id,i.source_version_id),
    'lastActivityAt',coalesce((SELECT max(c.created_at) FROM opc_content_versions c WHERE c.work_item_id=i.work_item_id),p.created_at),
    'content',coalesce((WITH checked AS MATERIALIZED (SELECT version.*,opc_content_allowed(p_actor_id,version.id) AS allowed FROM opc_content_versions version WHERE version.work_item_id=i.work_item_id) SELECT jsonb_agg(jsonb_build_object('id',c.id,'kind',c.kind,'version',c.version,'status',c.status,'title',CASE WHEN c.allowed THEN c.title ELSE NULL END,'body',CASE WHEN c.allowed THEN c.body ELSE NULL END,'contentAvailable',c.allowed,'sourceContentId',c.source_content_id,'executionId',c.execution_id,'requestId',c.request_id,'createdAt',c.created_at) ORDER BY c.created_at) FROM checked c),'[]'::jsonb)) ORDER BY i.day,p.work_title)
    FROM opc_items i JOIN artifact_projects p ON p.id=i.work_item_id LEFT JOIN opc_item_edits ed ON ed.work_item_id=i.work_item_id JOIN runtime_sessions s ON s.actor_id=p_actor_id AND s.scope=jsonb_build_object('kind','work_item','projectId',a.project_id,'workItemId',i.work_item_id)
    WHERE i.account_project_id=a.project_id AND (p_from IS NULL OR coalesce(ed.day,i.day)>=p_from) AND (p_to IS NULL OR coalesce(ed.day,i.day)<=p_to)
     AND (q='%%' OR lower(coalesce(ed.title,p.work_title)) LIKE q OR (opc_source_allowed(p_actor_id,i.source_version_id) AND lower(coalesce(ed.brief,i.brief)) LIKE q))),'[]'::jsonb)) ORDER BY a.platform,a.account_key)
   FROM opc_accounts a WHERE a.actor_id=p_actor_id AND a.business_id=b.id),'[]'::jsonb)) ORDER BY b.created_at)
  FROM opc_businesses b WHERE b.actor_id=p_actor_id),'[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION opc_library_before_workspace_ui(uuid,text,date,date) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
