-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- Rollback for 0407: the previous complete claim, step and erasure_remaining, and the old per-user period key.
-- Valid only while publish_monitor_coach_enabled has never been true (no per-brand or non-weekly rows). New tables
-- and columns stay: nothing old reads them. Review rows, BILL2 runs and journals are not touched.
BEGIN;
UPDATE system_settings SET value='false' WHERE key='publish_monitor_coach_enabled';
ALTER TABLE public.social_review_runs ADD CONSTRAINT social_review_runs_actor_id_period_start_key UNIQUE(actor_id,period_start);
-- publish_monitor_review_claim(integer)
CREATE OR REPLACE FUNCTION public.publish_monitor_review_claim(p_limit integer DEFAULT 5)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
END $function$;
;
-- publish_monitor_review_step(uuid,uuid,text,text)
CREATE OR REPLACE FUNCTION public.publish_monitor_review_step(p_id uuid, p_token uuid, p_action text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE r social_review_runs;x runtime_executions;allowed boolean;
BEGIN
 SELECT * INTO r FROM social_review_runs WHERE id=p_id FOR UPDATE;
 IF r.id IS NULL OR r.lease_token IS DISTINCT FROM p_token OR r.status<>'claimed'
  OR r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_LEASE_LOST';END IF;
 allowed:=publish_monitor_review_allowed(r.actor_id) AND r.created_at>=(SELECT auto_review_enabled_at
  FROM social_monitor_settings WHERE actor_id=r.actor_id);
 IF p_action='skip' THEN
  -- Serialize the terminal decision with a result commit. Native admission locks session -> review,
  -- so never wait for its execution row while owning the review: a busy owner makes this RPC retry.
  SELECT * INTO x FROM runtime_executions WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id FOR UPDATE NOWAIT;
 ELSE
  SELECT * INTO x FROM runtime_executions WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id;
 END IF;
 IF x.id IS NOT NULL THEN
  UPDATE social_review_runs SET runtime_execution_id=x.id,bill2_run_id=x.billing_run_id WHERE id=r.id;
 END IF;
 IF p_action IN ('observe','skip') AND x.state='completed' THEN
  UPDATE social_review_runs SET status='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 ELSIF p_action='skip' AND x.result IS NOT NULL THEN
  -- The owner completed after expiry was observed, but billing can still be cost_pending.
  -- Keep the original claim so native financial recovery and the next observe can publish it.
  RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'executionId',x.id,'state',x.state,'expired',false);
 ELSIF p_action='skip' OR p_action='observe' AND x.state IN ('cancelled','failed') THEN
  -- An unknown financial outcome keeps the claim: existing Runtime recovery owns the held credits.
  IF x.id IS NOT NULL AND NOT coalesce((SELECT closed FROM bill2_runs WHERE id=x.billing_run_id),false) THEN
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'executionId',x.id,'state','cost_pending');END IF;
  UPDATE social_review_runs SET status='skipped',skip_reason=coalesce(p_reason,'RUNTIME_ENDED'),
   finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 ELSIF p_action NOT IN ('authorize','observe') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 RETURN jsonb_build_object('allowed',allowed,'actorId',r.actor_id,'executionId',x.id,'state',x.state,
  'sessionId',r.runtime_session_id,'requestId',r.runtime_request_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text,
  -- A scheduler-owned review has no user present to resume it. A live dispatch still owns its lease.
  -- Return only a deadline decision here: cancellation takes the native session/run locks in a separate RPC,
  -- never while holding this review row (admission uses session -> review).
  'expired',r.created_at<=clock_timestamp()-interval '15 minutes' AND x.result IS NULL
   AND NOT EXISTS(SELECT 1 FROM bill2_runs b WHERE b.id=x.billing_run_id AND NOT b.closed
    AND b.runtime_dispatch_deadline>clock_timestamp()));
END $function$;
;
-- publish_monitor_erasure_remaining(uuid)
CREATE OR REPLACE FUNCTION public.publish_monitor_erasure_remaining(a uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT (SELECT count(*) FROM social_monitor_settings WHERE actor_id=a)
 +(SELECT count(*) FROM social_review_runs WHERE actor_id=a)
 +(SELECT count(*) FROM social_metric_snapshots WHERE actor_id=a)
 +(SELECT count(*) FROM social_posts WHERE actor_id=a)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NULL)
 +(SELECT count(*) FROM social_connections WHERE actor_id=a AND provider_account_id IS NOT NULL
   AND (status<>'deleting' OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_publish_jobs WHERE actor_id=a
   AND (state NOT IN ('claimed','dispatching','unknown') OR business_id IS NOT NULL))
 +(SELECT count(*) FROM social_connect_requests WHERE actor_id=a
   AND (business_id IS NOT NULL OR target_account_project_id IS NOT NULL
    OR NOT (state IN ('awaiting_callback','pending_confirm') OR cleaned_at IS NULL
     OR created_at>clock_timestamp()-interval '30 days')))
$function$;
;
DROP FUNCTION IF EXISTS public.publish_monitor_review_claim_item(social_review_runs);
DROP FUNCTION IF EXISTS public.publish_monitor_settle_facts(integer);
DROP FUNCTION IF EXISTS public.publish_monitor_review_pack_rows(uuid,uuid,integer);
COMMIT;
