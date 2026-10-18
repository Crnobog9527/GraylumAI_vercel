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

-- Keep revoked source copies out of future model history while asynchronous erasure is pending.
-- This filters model context only; runtime_view retains already displayed answers under the existing rule.
CREATE OR REPLACE FUNCTION public.runtime_workspace_posts_history_visible(p_execution_id uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 WITH RECURSIVE lineage(id) AS (
  SELECT p_execution_id UNION SELECT d.dependency_id FROM runtime_history_dependencies d JOIN lineage l ON d.execution_id=l.id
 ) SELECT NOT EXISTS(SELECT 1 FROM lineage l JOIN runtime_tool_calls t ON t.execution_id=l.id
  JOIN runtime_executions ex ON ex.id=l.id WHERE (t.result->>'kind'='my_posts'
   AND NOT runtime_workspace_posts_visible(ex.actor_id,t.result)) OR (ex.payload->>'ownPosts'='true'
    AND t.name='read_source' AND t.erased_at IS NOT NULL AND t.result IS NULL))
$$;
REVOKE ALL ON FUNCTION public.runtime_workspace_posts_history_visible(uuid) FROM PUBLIC,anon,authenticated,service_role;
DO $history$ DECLARE sig text;d text;expected integer;
BEGIN
 FOR sig,expected IN SELECT * FROM (VALUES ('runtime_admit(uuid,uuid,uuid,jsonb,jsonb)',1),
  ('runtime_session_items(uuid,uuid,uuid,text,jsonb,integer,integer)',2)) v(sig,n) LOOP
  d:=pg_get_functiondef(('public.'||sig)::regprocedure);
  IF position('runtime_workspace_posts_history_visible(' IN d)=0 THEN
   IF array_length(string_to_array(d,'WHERE available'),1)<>expected+1 THEN RAISE EXCEPTION 'B2_HISTORY_SOURCE_MISMATCH';END IF;
   EXECUTE replace(d,'WHERE available','WHERE available AND runtime_workspace_posts_history_visible(execution_id)');
  END IF;
 END LOOP;
END $history$;

-- Connection revocation never scans/locks historical conversations. Check only the current execution on entry;
-- the existing worker below discovers stale saved sources and removes copies in bounded, retryable batches.
DO $entry$ DECLARE d text;anchor text;patch text;
BEGIN
 d:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);
 IF position('-- B2 own-post source deleted' IN d)=0 THEN
  anchor:=$a$ -- 0262 library source deleted$a$;
  patch:=$p$ -- B2 own-post source deleted
 IF e.state NOT IN ('completed','cancelled') AND NOT runtime_workspace_posts_history_visible(e.id) THEN
  UPDATE runtime_executions SET unavailable_reason=coalesce(unavailable_reason,'source_deleted')
   WHERE id=e.id RETURNING * INTO e;
 END IF;
$p$;
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'B2_EXECUTION_SOURCE_MISMATCH';END IF;
  EXECUTE replace(d,anchor,patch||anchor);
 END IF;
END $entry$;

-- Final provider permission fence: serialize only used connections with a concurrent disconnect, then recheck.
-- Receipt recording and financial recovery are intentionally unchanged; only a NEW HTTP grant is denied.
DO $dispatch$ DECLARE d text;anchor text;fence text;
BEGIN
 d:=pg_get_functiondef('public.bill2_dispatch(uuid,uuid,uuid,uuid,boolean,jsonb)'::regprocedure);
 IF position('-- B2 own-post dispatch fence' IN d)=0 THEN
  anchor:=$a$ IF r.id IS NOT NULL THEN PERFORM runtime_billing_allowed(p_actor_id,r.payload,r.id);END IF;$a$;
  fence:=$dispatchFence$ -- B2 own-post dispatch fence
 BEGIN
  PERFORM id FROM profiles WHERE id=p_actor_id AND EXISTS(
   WITH RECURSIVE lineage(id) AS (
    SELECT ex.id FROM runtime_executions ex WHERE ex.billing_run_id=r.id
    UNION SELECT hd.dependency_id FROM runtime_history_dependencies hd JOIN lineage l ON hd.execution_id=l.id
   ) SELECT 1 FROM lineage l JOIN runtime_tool_calls t ON t.execution_id=l.id WHERE t.result->>'kind'='my_posts'
  ) FOR SHARE NOWAIT;
  PERFORM sc.id FROM social_connections sc WHERE sc.id::text IN (
   WITH RECURSIVE lineage(id) AS (
    SELECT ex.id FROM runtime_executions ex WHERE ex.billing_run_id=r.id
    UNION SELECT hd.dependency_id FROM runtime_history_dependencies hd JOIN lineage l ON hd.execution_id=l.id
   ) SELECT jsonb_array_elements_text(coalesce(t.result->'source_connections','[]')) FROM lineage l
    JOIN runtime_tool_calls t ON t.execution_id=l.id WHERE t.result->>'kind'='my_posts'
  ) ORDER BY sc.id FOR SHARE NOWAIT;
 EXCEPTION WHEN lock_not_available THEN RAISE EXCEPTION 'RUNTIME_CONTEXT_REVOKED';END;
 IF EXISTS(SELECT 1 FROM runtime_executions ex WHERE ex.billing_run_id=r.id
  AND NOT runtime_workspace_posts_history_visible(ex.id)) THEN RAISE EXCEPTION 'RUNTIME_CONTEXT_REVOKED';END IF;
$dispatchFence$;
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'B2_DISPATCH_SOURCE_MISMATCH';END IF;
  EXECUTE replace(d,anchor,anchor||E'\n'||fence);
 END IF;
END $dispatch$;

-- Classify receipt readiness using the existing trusted money projection, without changing evidence.
CREATE OR REPLACE FUNCTION public.runtime_workspace_posts_receipt_ready(p jsonb,c bill2_calls) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM bill2_erasure_receipt_projection(p,c);RETURN true;
EXCEPTION WHEN raise_exception THEN
 IF SQLERRM NOT IN ('BILL2_UNTRUSTED_RECEIPT','BILL2_INVALID_FINANCIAL_PROJECTION',
  'BILL2_INVALID_COVERAGE','BILL2_INVALID_DECIMAL') THEN RAISE;END IF;
 RETURN false;
WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_time_zone_displacement_value OR invalid_parameter_value THEN
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.runtime_workspace_posts_receipt_ready(jsonb,bill2_calls) FROM PUBLIC,anon,authenticated,service_role;

-- Reuse the existing deletion worker, erased source journal and the original run's content marker.
-- content_deleted_at persists the pending authority while the original BILL2 run is still open. The next worker
-- batch retries after recovery settles it; receipt financial_projection_version is the existing completion marker.
DO $patch$ DECLARE d text;anchor text;work text;
BEGIN
 d:=pg_get_functiondef('public.runtime_library_propagate(uuid,integer)'::regprocedure);
 IF position('-- B2 pending own-post receipts' IN d)=0 THEN
  anchor:=$a$ RETURN jsonb_build_object('processed',done,'waiting',waiting);$a$;
  work:=$w$ -- B2 pending own-post receipts: separate bounded batches; no connection transaction owns historical cleanup.
 FOR target IN SELECT ex.id execution_id FROM runtime_executions ex JOIN profiles p ON p.id=ex.actor_id
  WHERE ex.payload->>'ownPosts'='true' AND (p_actor_id IS NULL OR ex.actor_id=p_actor_id)
   AND EXISTS(SELECT 1 FROM runtime_tool_calls t WHERE t.execution_id=ex.id AND t.result->>'kind'='my_posts'
    AND NOT runtime_workspace_posts_visible(ex.actor_id,t.result))
   AND (ex.billing_run_id IS NULL OR EXISTS(SELECT 1 FROM bill2_runs br WHERE br.id=ex.billing_run_id FOR UPDATE SKIP LOCKED))
  ORDER BY ex.id LIMIT p_limit FOR UPDATE OF ex,p SKIP LOCKED LOOP
  SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id;
  IF e.state NOT IN ('completed','cancelled') THEN
   UPDATE runtime_executions SET unavailable_reason=coalesce(unavailable_reason,'source_deleted') WHERE id=e.id;
  END IF;
  UPDATE runtime_tool_calls SET arguments=NULL,result=NULL,erased_at=stamp WHERE execution_id=e.id AND name='read_source'
   AND result->>'kind'='my_posts';
  UPDATE runtime_session_history SET item=NULL,erased_at=stamp
   WHERE execution_id=e.id AND erased_at IS NULL AND item->>'role' IS DISTINCT FROM 'user';
  UPDATE runtime_session_batches SET items=NULL,erased_at=stamp WHERE execution_id=e.id AND erased_at IS NULL;
  UPDATE bill2_runs SET content_deleted_at=coalesce(content_deleted_at,stamp) WHERE id=e.billing_run_id;
  done:=done+1;
 END LOOP;
 -- Readiness and SKIP LOCKED are evaluated before LIMIT: open, untrusted or locked rows cannot starve later runs.
 FOR target IN SELECT ex.id execution_id FROM runtime_executions ex JOIN bill2_runs br ON br.id=ex.billing_run_id
  JOIN profiles p ON p.id=ex.actor_id
  WHERE br.content_deleted_at IS NOT NULL AND br.closed AND ex.payload->>'ownPosts'='true'
   AND (p_actor_id IS NULL OR ex.actor_id=p_actor_id)
   AND coalesce(content_erasure_financial_allowed(ex.actor_id,coalesce(br.pre_deduct_id,br.id)),false)
   AND EXISTS(SELECT 1 FROM runtime_tool_calls t WHERE t.execution_id=ex.id AND t.erased_at IS NOT NULL
    AND t.name='read_source' AND t.result IS NULL)
   AND EXISTS(SELECT 1 FROM bill2_receipts r JOIN bill2_calls c ON c.id=r.call_id
    WHERE c.run_id=br.id AND r.financial_projection_version IS NULL AND runtime_workspace_posts_receipt_ready(r.payload,c))
  ORDER BY ex.id LIMIT p_limit FOR UPDATE OF ex,br,p SKIP LOCKED LOOP
  BEGIN
   SELECT * INTO e FROM runtime_executions WHERE id=target.execution_id;
   scrub:=account_erasure_scrub_receipts(e.actor_id,e.billing_run_id,100);
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
