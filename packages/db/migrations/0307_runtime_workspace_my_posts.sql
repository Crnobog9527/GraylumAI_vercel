/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- CHAT-AUTO-CONTEXT B2. Number 0307 assigned by the controller through Owner (2026-10-18).
-- Rollback: set chat_my_posts_enabled=false; keep this host/recovery and cleanup worker until in-flight
-- ownPosts Runtime/BILL2 runs close, then revert the host. Old hosts cannot parse the new frozen context field.
-- Retain SQL, journals, original posts/snapshots and accounting; no destructive down migration. Erasure still runs.
-- Patch the CURRENT function (0301 or later), preserving benchmarks and strategy reports byte for byte.
-- No new tables, no new model tool, no provider request. Service reads reuse PR-3a readData / publish_monitor_data.
BEGIN;
INSERT INTO system_settings(key,value) VALUES('chat_my_posts_enabled','false') ON CONFLICT(key) DO NOTHING;

-- One paid-rights projection for the directory, admission budget and saved-result visibility.
CREATE OR REPLACE FUNCTION public.runtime_workspace_post_window(p_actor_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE days integer:=0;
BEGIN
 PERFORM bill2_actor(p_actor_id);
 BEGIN
  PERFORM report_membership_check(p_actor_id);
  SELECT coalesce(max(mp.own_data_window_days),0) INTO days FROM membership_plans mp
   JOIN profiles p ON p.membership_level=mp.level WHERE p.id=p_actor_id;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM NOT IN ('REPORT_MEMBERSHIP_REQUIRED','REPORT_ENTITLEMENTS_UNAVAILABLE') THEN RAISE;END IF;
  RETURN 0;
 END;
 RETURN days;
END $$;
REVOKE ALL ON FUNCTION public.runtime_workspace_post_window(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_workspace_post_window(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.runtime_workspace_posts_visible(p_actor_id uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_actor(p_actor_id);
 IF p_result->>'status' IS DISTINCT FROM 'no_entitlement'
  AND runtime_workspace_post_window(p_actor_id)<coalesce((p_result->>'window_days')::int,14) THEN RETURN false;END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_result->'source_connections','[]')) ids(value)
  WHERE NOT EXISTS(SELECT 1 FROM social_connections c WHERE c.id::text=ids.value AND c.actor_id=p_actor_id
   AND c.status NOT IN ('deleting','pending_selection')));
END $$;
REVOKE ALL ON FUNCTION public.runtime_workspace_posts_visible(uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_workspace_posts_visible(uuid,jsonb) TO service_role;

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
   days:=runtime_workspace_post_window(p_actor_id);
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
DECLARE payload jsonb;reads integer;actor uuid;
BEGIN
 IF NEW.name<>'read_source' OR NEW.result->>'kind' IS DISTINCT FROM 'my_posts' THEN RETURN NEW;END IF;
 SELECT e.payload,e.actor_id INTO payload,actor FROM runtime_executions e WHERE e.id=NEW.execution_id FOR NO KEY UPDATE;
 -- Never wait behind a disconnect holding the connection and waiting for this tool row: refuse the stale copy.
 BEGIN
  PERFORM c.id FROM social_connections c WHERE c.actor_id=actor AND c.id::text IN
   (SELECT jsonb_array_elements_text(coalesce(NEW.result->'source_connections','[]'))) ORDER BY c.id FOR SHARE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN
  NEW.result:=jsonb_build_object('kind','unavailable','reason','source_deleted','dependencies','[]'::jsonb);RETURN NEW;
 END;
 IF NOT runtime_workspace_posts_visible(actor,NEW.result) THEN
  NEW.result:=jsonb_build_object('kind','unavailable','reason','source_deleted','dependencies','[]'::jsonb);RETURN NEW;
 END IF;
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

-- Disconnect/delete removes saved tool and history copies too (same answer-retention rule as library deletion).
-- In-progress work is stopped; closed BILL2 receipts are projected to money-only fields. No amounts are changed.
CREATE OR REPLACE FUNCTION public.runtime_workspace_posts_deleted() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE e runtime_executions;stamp timestamptz:=clock_timestamp();closed boolean;
BEGIN
 IF TG_OP<>'DELETE' AND (NEW.status<>'deleting' OR OLD.status='deleting') THEN RETURN NEW;END IF;
 FOR e IN SELECT DISTINCT ex.* FROM runtime_executions ex JOIN runtime_tool_calls t ON t.execution_id=ex.id
  WHERE ex.actor_id=OLD.actor_id AND t.result->>'kind'='my_posts' AND t.result->'source_connections' ? OLD.id::text
  ORDER BY ex.id LOOP
  IF e.state NOT IN ('completed','cancelled') THEN
   UPDATE runtime_executions SET unavailable_reason=coalesce(unavailable_reason,'source_deleted') WHERE id=e.id;
  END IF;
  UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp WHERE execution_id=e.id AND name='read_source'
   AND result->>'kind'='my_posts';
  UPDATE runtime_session_history SET item=NULL,erased_at=stamp
   WHERE execution_id=e.id AND erased_at IS NULL AND item->>'role' IS DISTINCT FROM 'user';
  UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=e.id AND erased_at IS NULL;
  IF e.billing_run_id IS NOT NULL THEN
   UPDATE bill2_runs SET content_deleted_at=coalesce(content_deleted_at,stamp) WHERE id=e.billing_run_id RETURNING bill2_runs.closed INTO closed;
   IF closed AND content_erasure_financial_allowed(e.actor_id,e.billing_run_id) THEN
    PERFORM account_erasure_scrub_receipts(e.actor_id,e.billing_run_id,100);
   END IF;
  END IF;
 END LOOP;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION public.runtime_workspace_posts_deleted() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS runtime_workspace_posts_deleted ON social_connections;
CREATE TRIGGER runtime_workspace_posts_deleted AFTER DELETE OR UPDATE OF status ON social_connections
 FOR EACH ROW EXECUTE FUNCTION public.runtime_workspace_posts_deleted();

-- Reuse the existing deletion worker, erased source journal and the original run's content marker.
-- content_deleted_at persists the pending authority while the original BILL2 run is still open. The next worker
-- batch retries after recovery settles it; receipt financial_projection_version is the existing completion marker.
DO $patch$ DECLARE d text;anchor text;work text;
BEGIN
 d:=pg_get_functiondef('public.runtime_library_propagate(uuid,integer)'::regprocedure);
 IF position('-- B2 pending own-post receipts' IN d)=0 THEN
  anchor:=$a$ RETURN jsonb_build_object('processed',done,'waiting',waiting);$a$;
  work:=$w$ -- B2 pending own-post receipts: separate bounded batch; a library backlog cannot starve these copies.
 FOR target IN SELECT ex.id execution_id FROM runtime_executions ex JOIN bill2_runs br ON br.id=ex.billing_run_id
  WHERE br.content_deleted_at IS NOT NULL AND ex.payload->>'ownPosts'='true'
   AND (p_actor_id IS NULL OR ex.actor_id=p_actor_id)
   AND EXISTS(SELECT 1 FROM runtime_tool_calls t WHERE t.execution_id=ex.id AND t.erased_at IS NOT NULL
    AND t.name='read_source' AND t.result IS NULL)
   AND EXISTS(SELECT 1 FROM bill2_receipts r JOIN bill2_calls c ON c.id=r.call_id
    WHERE c.run_id=br.id AND r.financial_projection_version IS NULL)
  ORDER BY ex.id LIMIT p_limit LOOP
  BEGIN
   SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id;
   PERFORM id FROM profiles WHERE id=e.actor_id FOR SHARE NOWAIT;
   SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id FOR UPDATE NOWAIT;
   SELECT * INTO b FROM bill2_runs WHERE id=e.billing_run_id FOR UPDATE NOWAIT;
   IF NOT b.closed OR NOT coalesce(content_erasure_financial_allowed(e.actor_id,coalesce(b.pre_deduct_id,b.id)),false) THEN
    waiting:=waiting+1;CONTINUE;
   END IF;
   scrub:=account_erasure_scrub_receipts(e.actor_id,b.id,100);
   IF (scrub->>'remaining')::bigint>(scrub->>'manualReview')::bigint THEN waiting:=waiting+1;
   ELSE done:=done+1;END IF;
  EXCEPTION WHEN lock_not_available THEN waiting:=waiting+1;
  END;
 END LOOP;
$w$;
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'B2_ERASURE_WORKER_MISMATCH';END IF;
  EXECUTE replace(d,anchor,work||anchor);
 END IF;
END $patch$;

COMMIT;
