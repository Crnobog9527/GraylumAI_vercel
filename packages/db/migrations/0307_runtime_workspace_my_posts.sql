/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- CHAT-AUTO-CONTEXT B2. Number 0307 assigned by the controller through Owner (2026-10-18).
-- Rollback: set chat_my_posts_enabled=false, then revert the host code. Existing sources, posts, snapshots and
-- Runtime journals remain intact; no destructive down migration. Saved results keep the normal erasure coverage.
-- Patch the CURRENT function (0301 or later), preserving benchmarks and strategy reports byte for byte.
-- No new tables, no new model tool, no provider request. Service reads reuse PR-3a readData / publish_monitor_data.
BEGIN;
INSERT INTO system_settings(key,value) VALUES('chat_my_posts_enabled','false') ON CONFLICT(key) DO NOTHING;
DO $migration$
DECLARE definition text;anchor text;replacement text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_workspace_source(uuid,uuid,text)'::regprocedure);
 IF position('-- B2 own posts' IN definition)=0 THEN
  anchor:=$anchor$ IF coalesce(p_query,'')='' THEN$anchor$;
  replacement:=$patch$ -- B2 own posts: no changes to the existing directory entries or dependencies.
 DECLARE post_entries jsonb:='[]';days integer:=0;chosen jsonb;
 BEGIN
  IF (SELECT value='true'::jsonb FROM system_settings WHERE key='chat_my_posts_enabled')
   AND (SELECT value='true'::jsonb FROM system_settings WHERE key='publish_monitor_enabled') THEN
   BEGIN
    PERFORM report_membership_check(p_actor_id);
    SELECT coalesce(max(mp.own_data_window_days),0) INTO days FROM membership_plans mp
     JOIN profiles p ON p.membership_level=mp.level WHERE p.id=p_actor_id;
   EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT IN ('REPORT_MEMBERSHIP_REQUIRED','REPORT_ENTITLEMENTS_UNAVAILABLE') THEN RAISE;END IF;
    days:=0;
   END;
   SELECT jsonb_agg(jsonb_build_object('id','my_posts:'||d,'kind','my_posts','name','我的作品 · '||d||' 天',
    'windowDays',d,'use','Saved own post metrics, free to read. Default 14 days. At most two reads per answer.') ORDER BY d)
    INTO post_entries FROM unnest(ARRAY[14,30,90]) d WHERE d=14 OR d<=days;
  END IF;
  IF coalesce(p_query,'')='' THEN
   RETURN jsonb_build_object('kind','workspace_index','entries',entries||post_entries,'limit',40+jsonb_array_length(post_entries),
    'dependencies',(SELECT coalesce(jsonb_agg(DISTINCT x->>'sourceVersionId'),'[]') FROM jsonb_array_elements(entries) x));
  END IF;
  IF p_query IN ('my_posts','my_posts:14','my_posts:30','my_posts:90') THEN
   SELECT x INTO chosen FROM jsonb_array_elements(post_entries) x WHERE x->>'id'=CASE WHEN p_query='my_posts' THEN 'my_posts:14' ELSE p_query END;
   IF chosen IS NULL THEN RETURN jsonb_build_object('kind','unavailable','dependencies','[]'::jsonb);END IF;
   RETURN jsonb_build_object('kind','workspace_posts_request','windowDays',(chosen->>'windowDays')::int,'entitled',days>0);
  END IF;
 END;
 IF coalesce(p_query,'')='' THEN$patch$;
  IF array_length(string_to_array(definition,anchor),1)<>2 THEN RAISE EXCEPTION 'B2_WORKSPACE_SOURCE_MISMATCH';END IF;
  EXECUTE replace(definition,anchor,replacement);
 END IF;
END $migration$;

-- Serialize with runtime_tool's execution lock. Saved calls replay without consuming another read.
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
REVOKE ALL ON FUNCTION public.runtime_workspace_posts_guard() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS runtime_workspace_posts_guard ON runtime_tool_calls;
CREATE TRIGGER runtime_workspace_posts_guard BEFORE INSERT OR UPDATE OF result ON runtime_tool_calls
 FOR EACH ROW EXECUTE FUNCTION public.runtime_workspace_posts_guard();
COMMIT;
