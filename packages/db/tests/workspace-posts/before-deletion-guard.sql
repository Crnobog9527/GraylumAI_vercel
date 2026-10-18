/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- Pre-fix guard, only for the local first-red regression.
CREATE OR REPLACE FUNCTION public.runtime_workspace_posts_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE payload jsonb;reads integer;
BEGIN
 IF NEW.name<>'read_source' OR NEW.result->>'kind' IS DISTINCT FROM 'my_posts' THEN RETURN NEW;END IF;
 SELECT e.payload INTO payload FROM runtime_executions e WHERE e.id=NEW.execution_id FOR NO KEY UPDATE;
 SELECT count(*) INTO reads FROM runtime_tool_calls t WHERE t.execution_id=NEW.execution_id
  AND t.call_id<>NEW.call_id AND t.result->>'kind'='my_posts';
 IF payload->>'ownPosts' IS DISTINCT FROM 'true' OR reads>=2 OR octet_length(NEW.result::text)>12000 THEN
  NEW.result:=jsonb_build_object('kind','unavailable','reason',CASE WHEN reads>=2 THEN 'read_limit' ELSE 'capacity_exhausted' END,
   'dependencies','[]'::jsonb);
 END IF;
 RETURN NEW;
END $$;
