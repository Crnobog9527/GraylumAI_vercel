/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Free conversations reuse Runtime storage and appear separately from account work.
BEGIN;
CREATE OR REPLACE FUNCTION public.opc_free_conversations(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE conversations jsonb;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 WITH recent AS MATERIALIZED (
 SELECT s.id,first_turn.id AS execution_id,first_turn.payload,activity.last_activity
 FROM (
  SELECT session.* FROM runtime_sessions session
  WHERE session.actor_id=p_actor_id AND session.scope->>'kind'='positioning_draft'
   AND bill2_scope_allowed(p_actor_id,session.scope)
   AND NOT EXISTS(SELECT 1 FROM opc_drafts draft WHERE draft.session_id=session.id)
   AND NOT EXISTS(SELECT 1 FROM opc_topic_workspaces topics WHERE topics.session_id=session.id)
 ) s
 CROSS JOIN LATERAL (
  SELECT e.id,e.payload FROM runtime_executions e
  WHERE e.session_id=s.id AND e.actor_id=p_actor_id AND e.payload->>'role' IN ('ordinary','skill')
  ORDER BY e.created_at,e.id LIMIT 1
 ) first_turn
 CROSS JOIN LATERAL (
  SELECT max(e.created_at) AS last_activity FROM runtime_executions e
  WHERE e.session_id=s.id AND e.actor_id=p_actor_id
 ) activity
 ORDER BY activity.last_activity DESC,s.id LIMIT 100
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object(
  'sessionId',s.id,
  'title',CASE WHEN runtime_history_available(s.execution_id)
    THEN left(coalesce(nullif(btrim(s.payload->>'input'),''),'新对话'),80)
    ELSE '对话记录' END,
  'lastActivityAt',s.last_activity
 ) ORDER BY s.last_activity DESC,s.id),'[]'::jsonb) INTO conversations
 FROM recent s;
 RETURN conversations;
END $$;
REVOKE ALL ON FUNCTION public.opc_free_conversations(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.opc_free_conversations(uuid) TO service_role;
COMMIT;
