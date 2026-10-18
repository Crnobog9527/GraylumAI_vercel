/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- PUBLISH-MONITOR PR-6. Temporary development number; request the final number after B2 is delivered.
-- Reuse social_review_runs, Runtime sessions/executions/tool journal and BILL2's caps; no new tables or queues.
-- Current-session Owner instruction: switches default OFF (supersedes the older default-on proposal).
-- Rollback: turn publish_monitor_review_enabled off, then revert the host code. Keep all existing claims/accounting;
-- pending Runtime calls settle through the existing financial recovery. Never delete unsettled runs to roll back.
BEGIN;
INSERT INTO system_settings(key,value) VALUES('publish_monitor_review_enabled','false'),
 ('publish_monitor_review_model_id','null'),('publish_monitor_review_max_usd','"0"') ON CONFLICT(key) DO NOTHING;
ALTER TABLE social_monitor_settings ALTER COLUMN auto_review_enabled SET DEFAULT false;
ALTER TABLE social_review_runs ADD COLUMN IF NOT EXISTS lease_token uuid,
 ADD COLUMN IF NOT EXISTS runtime_session_id uuid,ADD COLUMN IF NOT EXISTS model_id uuid,
 ADD COLUMN IF NOT EXISTS max_cost_usd numeric(18,12);

CREATE OR REPLACE FUNCTION public.publish_monitor_settings(a uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('autoReviewEnabled',coalesce(s.auto_review_enabled,false),
  'autoReviewEnabledAt',s.auto_review_enabled_at)
 FROM (SELECT 1) one LEFT JOIN social_monitor_settings s ON s.actor_id=a
$$;

CREATE OR REPLACE FUNCTION public.publish_monitor_review_allowed(a uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT publish_monitor_actor_open(a) OR NOT coalesce((SELECT value='true'::jsonb FROM system_settings
  WHERE key='publish_monitor_enabled'),false) OR NOT coalesce((SELECT value='true'::jsonb FROM system_settings
  WHERE key='publish_monitor_review_enabled'),false) THEN RETURN false;END IF;
 BEGIN PERFORM report_membership_check(a);
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM IN ('REPORT_MEMBERSHIP_REQUIRED','REPORT_ENTITLEMENTS_UNAVAILABLE') THEN RETURN false;ELSE RAISE;END IF;
 END;
 RETURN coalesce((SELECT p.membership_level='gold' AND bool_or(mp.allow_weekly_auto_review)
  FROM profiles p JOIN membership_plans mp ON mp.level=p.membership_level WHERE p.id=a GROUP BY p.membership_level),false)
  AND coalesce((SELECT auto_review_enabled FROM social_monitor_settings WHERE actor_id=a),false);
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_review_claim(p_limit integer DEFAULT 5) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE a uuid;s social_monitor_settings;r social_review_runs;base timestamptz;out jsonb:='[]';
 cfg jsonb;mid text;cap text;session jsonb;
BEGIN
 -- Missing user settings are OFF. No creation time or migration time can silently opt a user into paid work.
 IF p_limit NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 FOR a IN SELECT actor_id FROM social_review_runs WHERE status='claimed' AND lease_expires_at<=clock_timestamp()
  UNION SELECT actor_id FROM social_monitor_settings WHERE auto_review_enabled ORDER BY actor_id LOOP
  EXIT WHEN jsonb_array_length(out)>=p_limit;
  SELECT * INTO s FROM social_monitor_settings WHERE actor_id=a FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN CONTINUE;END IF;
  SELECT * INTO r FROM social_review_runs WHERE actor_id=a AND status='claimed' ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
   IF r.lease_expires_at>clock_timestamp() THEN CONTINUE;END IF;
   UPDATE social_review_runs SET lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '5 minutes'
    WHERE id=r.id RETURNING * INTO r;
  ELSE
   IF NOT publish_monitor_review_allowed(a) THEN CONTINUE;END IF;
   SELECT greatest(s.auto_review_enabled_at,coalesce(max(finished_at),s.auto_review_enabled_at)) INTO base
    FROM social_review_runs WHERE actor_id=a AND status IN ('completed','skipped');
   IF base+interval '7 days'>clock_timestamp() THEN CONTINUE;END IF;
   SELECT value#>>'{}' INTO mid FROM system_settings WHERE key='publish_monitor_review_model_id';
   IF mid IS NULL OR mid='' THEN SELECT value#>>'{}' INTO mid FROM system_settings WHERE key='primary_model_id';END IF;
   SELECT value#>>'{}' INTO cap FROM system_settings WHERE key='publish_monitor_review_max_usd';
   INSERT INTO social_review_runs(actor_id,period_start,status,lease_expires_at,lease_token,runtime_request_id,model_id,max_cost_usd)
   VALUES(a,(base+interval '7 days')::date,'claimed',clock_timestamp()+interval '5 minutes',gen_random_uuid(),gen_random_uuid(),
    CASE WHEN mid~'^[0-9a-fA-F-]{36}$' THEN mid::uuid END,
    CASE WHEN cap~'^(0|[1-9][0-9]{0,3})(\.[0-9]{1,6})?$' THEN cap::numeric ELSE 0 END)
   ON CONFLICT(actor_id,period_start) DO NOTHING RETURNING * INTO r;
   IF NOT FOUND THEN CONTINUE;END IF;
   session:=runtime_start(a,r.runtime_request_id,'{"scope":{"kind":"positioning_draft"}}');
   UPDATE social_review_runs SET runtime_session_id=(session->>'sessionId')::uuid WHERE id=r.id RETURNING * INTO r;
  END IF;
  out:=out||jsonb_build_array(jsonb_build_object('id',r.id,'actorId',a,'token',r.lease_token,
   'requestId',r.runtime_request_id,'sessionId',r.runtime_session_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text));
 END LOOP;
 RETURN out;
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_review_step(p_id uuid,p_token uuid,p_action text,p_reason text DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r social_review_runs;x runtime_executions;allowed boolean;
BEGIN
 SELECT * INTO r FROM social_review_runs WHERE id=p_id FOR UPDATE;
 IF r.id IS NULL OR r.lease_token IS DISTINCT FROM p_token OR r.status<>'claimed'
  OR r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_LEASE_LOST';END IF;
 allowed:=publish_monitor_review_allowed(r.actor_id) AND r.created_at>=(SELECT auto_review_enabled_at
  FROM social_monitor_settings WHERE actor_id=r.actor_id);
 SELECT * INTO x FROM runtime_executions WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id;
 IF x.id IS NOT NULL THEN
  UPDATE social_review_runs SET runtime_execution_id=x.id,bill2_run_id=x.billing_run_id WHERE id=r.id;
 END IF;
 IF p_action='observe' AND x.state='completed' THEN
  UPDATE social_review_runs SET status='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 ELSIF p_action='skip' OR p_action='observe' AND x.state IN ('cancelled','failed') THEN
  -- An unknown financial outcome keeps the claim: existing Runtime recovery owns the held credits.
  IF x.id IS NOT NULL AND NOT coalesce((SELECT closed FROM bill2_runs WHERE id=x.billing_run_id),false) THEN
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'executionId',x.id,'state','cost_pending');END IF;
  UPDATE social_review_runs SET status='skipped',skip_reason=coalesce(p_reason,'RUNTIME_ENDED'),
   finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 ELSIF p_action NOT IN ('authorize','observe') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 RETURN jsonb_build_object('allowed',allowed,'actorId',r.actor_id,'executionId',x.id,'state',x.state,
  'sessionId',r.runtime_session_id,'requestId',r.runtime_request_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text);
END $$;

-- One atomic bind on runtime_admit: a stale lease, another actor, another request/session, or a larger cap is refused.
CREATE OR REPLACE FUNCTION public.publish_monitor_review_admit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r social_review_runs;b bill2_runs;meta jsonb:=NEW.payload->'weeklyReview';
BEGIN
 IF meta IS NULL THEN RETURN NEW;END IF;
 SELECT * INTO r FROM social_review_runs WHERE id=(meta->>'id')::uuid FOR UPDATE;
 SELECT * INTO b FROM bill2_runs WHERE id=NEW.billing_run_id;
 IF r.id IS NULL OR r.actor_id IS DISTINCT FROM NEW.actor_id OR r.status IS DISTINCT FROM 'claimed'
  OR r.lease_token IS DISTINCT FROM (meta->>'token')::uuid
  OR r.lease_expires_at<=clock_timestamp() OR r.runtime_request_id IS DISTINCT FROM NEW.request_id OR r.runtime_session_id IS DISTINCT FROM NEW.session_id
  OR NOT publish_monitor_review_allowed(NEW.actor_id) OR r.created_at<(SELECT auto_review_enabled_at
   FROM social_monitor_settings WHERE actor_id=r.actor_id) OR r.max_cost_usd IS NULL OR b.budget_usd IS NULL OR b.budget_usd>r.max_cost_usd
  OR NEW.payload->>'modelId' IS DISTINCT FROM r.model_id::text OR NEW.payload->>'role' IS DISTINCT FROM 'ordinary'
  OR NEW.payload->>'network' IS DISTINCT FROM 'deny' OR NEW.payload->'tools' IS DISTINCT FROM '["read_source"]'::jsonb
  OR NEW.payload->>'ownPosts' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_DENIED';END IF;
 UPDATE social_review_runs SET runtime_execution_id=NEW.id,bill2_run_id=NEW.billing_run_id WHERE id=r.id;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS publish_monitor_review_admit_guard ON runtime_executions;
CREATE TRIGGER publish_monitor_review_admit_guard BEFORE INSERT ON runtime_executions
 FOR EACH ROW EXECUTE FUNCTION public.publish_monitor_review_admit_guard();

CREATE OR REPLACE FUNCTION public.publish_monitor_review_call_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r social_review_runs;
BEGIN
 SELECT * INTO r FROM social_review_runs WHERE bill2_run_id=NEW.run_id;
 IF r.id IS NOT NULL AND (TG_OP='INSERT' OR OLD.dispatched_at IS NULL AND NEW.dispatched_at IS NOT NULL)
  AND (NOT publish_monitor_review_allowed(r.actor_id) OR r.created_at<(SELECT auto_review_enabled_at
   FROM social_monitor_settings WHERE actor_id=r.actor_id)) THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_DISABLED';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS publish_monitor_review_call_guard ON bill2_calls;
CREATE TRIGGER publish_monitor_review_call_guard BEFORE INSERT OR UPDATE OF dispatched_at ON bill2_calls
 FOR EACH ROW EXECUTE FUNCTION public.publish_monitor_review_call_guard();

-- A prompt alone cannot require grounding: the host journal must contain the real Gold source before delivery.
CREATE OR REPLACE FUNCTION public.publish_monitor_review_result_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NEW.payload ? 'weeklyReview' AND NEW.result IS NOT NULL AND NEW.result IS DISTINCT FROM OLD.result AND NOT EXISTS(
  SELECT 1 FROM runtime_tool_calls t WHERE t.execution_id=NEW.id AND t.name='read_source'
   AND t.result->>'kind'='my_posts' AND t.result->>'window_days'='90'
   AND t.result->>'status' IN ('available','stale','no_recent_posts','not_connected')
   AND jsonb_typeof(t.result->'review')='object' AND runtime_workspace_posts_visible(NEW.actor_id,t.result))
  THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_SOURCE_REQUIRED';END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS publish_monitor_review_result_guard ON runtime_executions;
CREATE TRIGGER publish_monitor_review_result_guard BEFORE UPDATE OF state,result ON runtime_executions
 FOR EACH ROW EXECUTE FUNCTION public.publish_monitor_review_result_guard();

CREATE OR REPLACE FUNCTION public.publish_monitor_reviews(a uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM publish_monitor_actor(a);
 RETURN coalesce((SELECT jsonb_agg(v ORDER BY v->>'createdAt' DESC) FROM (
  SELECT jsonb_build_object('id',r.id,'periodStart',r.period_start,'status',r.status,'skipReason',r.skip_reason,
   'createdAt',r.created_at,'sessionId',r.runtime_session_id,'executionId',r.runtime_execution_id,
   'body',CASE WHEN r.status='completed' AND x.content_deleted_at IS NULL AND x.erased_at IS NULL THEN x.result->>'body' END,
   -- The numeric table comes only from the host's tool journal. Model text is never parsed into these columns.
   'tables',CASE WHEN r.status='completed' AND x.content_deleted_at IS NULL AND x.erased_at IS NULL THEN
    (SELECT t.result->'review' FROM runtime_tool_calls t WHERE t.execution_id=x.id AND t.result->>'kind'='my_posts'
     AND t.result->>'window_days'='90' AND runtime_workspace_posts_visible(a,t.result) ORDER BY (t.result->>'window_days')::int DESC,t.call_id DESC LIMIT 1) END,
   'notice',CASE WHEN r.status='completed' THEN '本周复盘已生成' WHEN r.skip_reason='BALANCE_LOW' THEN '余额不足，未复盘' END) v
  FROM social_review_runs r LEFT JOIN runtime_executions x ON x.id=r.runtime_execution_id AND x.actor_id=a
  WHERE r.actor_id=a ORDER BY r.created_at DESC LIMIT 52) q),'[]'::jsonb);
END $$;

-- Stored Gold benchmark posts and own account snapshots. No refresh and no provider calls.
CREATE OR REPLACE FUNCTION public.publish_monitor_review_supplement(a uuid,p_window_days integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE gold boolean;since timestamptz;out jsonb;
BEGIN
 PERFORM report_membership_check(a);
 IF p_window_days NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 SELECT membership_level='gold' INTO gold FROM profiles WHERE id=a;
 IF NOT gold AND p_window_days>30 THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED';END IF;
 since:=clock_timestamp()-make_interval(days=>p_window_days);
 WITH accounts AS (SELECT c.id,c.platform FROM social_connections c WHERE c.actor_id=a AND c.role='benchmark'
  AND c.status='connected' AND c.consent_read AND gold),
 posts AS (SELECT p.* FROM social_posts p JOIN accounts c ON c.id=p.connection_id
  WHERE p.actor_id=a AND p.posted_at>=since AND p.posted_at<=clock_timestamp() ORDER BY p.posted_at DESC,p.id LIMIT 30)
 SELECT jsonb_build_object('connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'platform',platform)) FROM accounts),'[]'),
 'posts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'connectionId',p.connection_id,'postedAt',p.posted_at,
  'source',p.source,'titleExcerpt',p.title_excerpt)) FROM posts p),'[]'),
 'histories',coalesce((SELECT jsonb_agg(jsonb_build_object('postId',p.id,'snapshots',coalesce((SELECT jsonb_agg(
  jsonb_build_object('capturedOn',s.captured_on,'metrics',s.metrics,'missingFields',to_jsonb(s.missing_fields),'source',s.source)
  ORDER BY s.captured_on) FROM social_metric_snapshots s WHERE s.post_id=p.id AND s.actor_id=a
   AND s.captured_on>=(since AT TIME ZONE 'UTC')::date),'[]'))) FROM posts p),'[]'),
 'followers',coalesce((SELECT jsonb_agg(jsonb_build_object('connectionId',c.id,'platform',c.platform,'source',c.source,
  'current',(SELECT jsonb_build_object('date',s.captured_on,'value',s.metrics->'followers') FROM social_metric_snapshots s
   WHERE s.connection_id=c.id AND s.post_id IS NULL AND s.actor_id=a AND s.metrics ? 'followers'
    AND NOT ('followers'=ANY(s.missing_fields)) ORDER BY s.captured_on DESC LIMIT 1),
  'previous',(SELECT jsonb_build_object('date',s.captured_on,'value',s.metrics->'followers') FROM social_metric_snapshots s
   WHERE s.connection_id=c.id AND s.post_id IS NULL AND s.actor_id=a AND s.metrics ? 'followers'
    AND NOT ('followers'=ANY(s.missing_fields)) AND s.captured_on=(clock_timestamp() AT TIME ZONE 'UTC')::date-7 LIMIT 1),
  'note',CASE WHEN c.source='postforme' THEN '平台不提供' ELSE '未取到时不比较' END))
  FROM social_connections c WHERE c.actor_id=a AND c.role='own' AND c.status='connected'),'[]')) INTO out;
 RETURN out;
END $$;
REVOKE ALL ON FUNCTION public.publish_monitor_review_supplement(uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.publish_monitor_review_supplement(uuid,integer) TO service_role;

-- A saved 14-day Gold review can contain benchmark data too: downgrade must deny replay of that copy.
DO $$ DECLARE d text;anchor text;
BEGIN
 d:=pg_get_functiondef('public.runtime_workspace_posts_visible(uuid,jsonb)'::regprocedure);
 IF position('-- PR6 benchmark rights' IN d)=0 THEN
  anchor:=' PERFORM bill2_actor(p_actor_id);';
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'PUBLISH_REVIEW_VISIBILITY_MISMATCH';END IF;
  EXECUTE replace(d,anchor,anchor||$p$
 -- PR6 benchmark rights
 IF p_result->>'gold_review'='true' AND NOT coalesce((SELECT membership_level='gold' FROM profiles WHERE id=p_actor_id),false)
  THEN RETURN false;END IF;$p$);
 END IF;
END $$;

-- Add review metadata only to the new my_posts descriptor, preserving all existing directory and read behavior.
DO $$ DECLARE d text;anchor text;
BEGIN
 d:=pg_get_functiondef('public.runtime_workspace_source(uuid,uuid,text)'::regprocedure);
 IF position('-- PR6 review descriptor' IN d)=0 THEN
  anchor:=$a$'entitled',days>0);$a$;
  IF array_length(string_to_array(d,anchor),1)<>2 THEN RAISE EXCEPTION 'PUBLISH_REVIEW_SOURCE_MISMATCH';END IF;
  EXECUTE replace(d,anchor,$b$'entitled',days>0,'review',coalesce((SELECT value='true'::jsonb
   FROM system_settings WHERE key='publish_monitor_review_enabled'),false)); -- PR6 review descriptor$b$);
 END IF;
END $$;
DO $$ DECLARE f regprocedure;
BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  AND p.proname IN ('publish_monitor_review_allowed','publish_monitor_review_claim','publish_monitor_review_step',
   'publish_monitor_review_admit_guard','publish_monitor_review_call_guard','publish_monitor_review_result_guard','publish_monitor_reviews') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  IF split_part(f::text,'(',1) IN ('publish_monitor_review_claim','publish_monitor_review_step','publish_monitor_reviews')
   THEN EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);END IF;
 END LOOP;
END $$;
COMMIT;
