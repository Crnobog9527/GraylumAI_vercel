/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
CREATE OR REPLACE FUNCTION public.runtime_workspace_posts_history_visible(p_execution_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE lineage(id) AS (
  SELECT p_execution_id UNION SELECT d.dependency_id FROM runtime_history_dependencies d JOIN lineage l ON d.execution_id=l.id
 ) SELECT NOT EXISTS(SELECT 1 FROM lineage l JOIN runtime_tool_calls t ON t.execution_id=l.id
  JOIN runtime_executions ex ON ex.id=l.id WHERE (t.result->>'kind'='my_posts'
   AND NOT runtime_workspace_posts_visible(ex.actor_id,t.result)) OR (ex.payload->>'ownPosts'='true'
    AND t.name='read_source' AND t.erased_at IS NOT NULL AND t.result IS NULL))
$$;
