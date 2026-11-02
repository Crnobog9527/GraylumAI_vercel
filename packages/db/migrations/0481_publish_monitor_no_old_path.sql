-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CORE-PATH-V2 V2-12 B8c (Owner 2026-11-03: the old paths are deleted completely before launch, nothing is left for batch F): the
-- publish monitor no longer touches the old Runtime / BILL2 objects.
--   * publish_monitor_post_window / publish_monitor_pack_visible: the monitor's own copies of the own-data window and the source
--     visibility check (they were runtime_workspace_post_window / runtime_workspace_posts_visible); no bill2_actor.
--   * publish_monitor_review_step: only turns; the branch for a review that still had a Runtime execution is gone.
--   * publish_monitor_reviews: only turn-written reviews; the page no longer reads runtime_executions or runtime_tool_calls.
--   * publish_monitor_review_supplement: the window comes from publish_monitor_post_window.
--   * publish_monitor_billed_run / billed_recovery: only turns and ledger rows (no bill2_runs, no bill2_calls); publish_monitor_billed_legacy
--     keeps its answer without naming an old object.
--   * The three guard triggers on runtime_executions and bill2_calls are dropped; their functions and publish_monitor_billed_legacy are
--     rewritten as shells / without old objects (CREATE OR REPLACE), nothing else is dropped.
--   * Leftovers written by the old path are closed here: reviews that were claimed with a Runtime execution end as skipped (their period
--     stays used), billed reads left open on a BILL2 run are closed with their live attempts abandoned. Completed reviews written by
--     the old path stay as rows (the schedule needs their dates) but are no longer listed (their text lived in runtime_executions).
-- publish_monitor_tool_only_run stays: bill2_prepare calls it and goes with it in batch F. Repeatable except the one-time closures
-- (which only touch rows that still match). Recovery: re-apply 0477's functions and 0307's triggers (functions history).
BEGIN;
SET LOCAL lock_timeout='5s';

-- The own-data window of a member in days (0: no entitlement), and whether every source account of a saved pack is still visible.
CREATE OR REPLACE FUNCTION public.publish_monitor_post_window(p_actor_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE days integer:=0;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM profiles WHERE id=p_actor_id AND status='active' AND is_deleted::text='false') THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
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

CREATE OR REPLACE FUNCTION public.publish_monitor_pack_visible(p_actor_id uuid,p_result jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF p_result->>'gold_review'='true' AND NOT coalesce((SELECT p.membership_level='gold' AND bool_or(mp.allow_benchmark_monitor)
  FROM profiles p JOIN membership_plans mp ON mp.level=p.membership_level WHERE p.id=p_actor_id GROUP BY p.membership_level),false)
  THEN RETURN false;END IF;
 IF p_result->>'status' IS DISTINCT FROM 'no_entitlement'
  AND publish_monitor_post_window(p_actor_id)<coalesce((p_result->>'window_days')::int,14) THEN RETURN false;END IF;
 RETURN NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(coalesce(p_result->'source_connections','[]')) ids(value)
  WHERE NOT EXISTS(SELECT 1 FROM social_connections c WHERE c.id::text=ids.value AND c.actor_id=p_actor_id
   AND c.status NOT IN ('deleting','pending_selection')));
END $$;

CREATE OR REPLACE FUNCTION public.publish_monitor_review_supplement(a uuid, p_window_days integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE gold boolean;since timestamptz;out jsonb;days integer;
BEGIN
 days:=publish_monitor_post_window(a);
 IF p_window_days NOT BETWEEN 1 AND 90 THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 SELECT coalesce(bool_or(mp.allow_benchmark_monitor),false) AND p.membership_level='gold' INTO gold
  FROM profiles p JOIN membership_plans mp ON mp.level=p.membership_level WHERE p.id=a GROUP BY p.membership_level;
 IF p_window_days>days THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ENTITLEMENT_REQUIRED';END IF;
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

CREATE OR REPLACE FUNCTION public.publish_monitor_review_step(p_id uuid,p_token uuid,p_action text,p_reason text DEFAULT NULL::text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r social_review_runs;x turns;allowed boolean;spent numeric;st text;why text;
BEGIN
 SELECT * INTO r FROM social_review_runs WHERE id=p_id FOR UPDATE;
 IF r.id IS NULL OR r.lease_token IS DISTINCT FROM p_token OR r.status<>'claimed'
  OR r.lease_expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'PUBLISH_MONITOR_REVIEW_LEASE_LOST';END IF;
 IF p_action NOT IN ('authorize','observe','skip') THEN RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID';END IF;
 allowed:=publish_monitor_review_allowed(r.actor_id) AND r.created_at>=(SELECT auto_review_enabled_at
  FROM social_monitor_settings WHERE actor_id=r.actor_id);
 SELECT * INTO x FROM turns WHERE actor_id=r.actor_id AND request_id=r.runtime_request_id AND kind='review';
 IF x.id IS NOT NULL AND r.turn_id IS DISTINCT FROM x.id THEN
  UPDATE social_review_runs SET turn_id=x.id WHERE id=r.id;
 END IF;
 st:=CASE WHEN x.id IS NULL THEN NULL WHEN x.state<>'closed' THEN 'running'
  WHEN x.close_kind='completed' AND x.delivered THEN 'completed' ELSE 'failed' END;
 IF p_action IN ('observe','skip') AND st='completed' THEN
  UPDATE social_review_runs SET status='completed',finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
  -- Only a completed strategy check consumes a stage change; a skipped one is scheduled again (Owner 2026-10-27).
  IF r.cadence='quarterly' AND r.business_id IS NOT NULL THEN
   UPDATE social_coach_profiles SET strategy_check_stages=(SELECT coalesce(jsonb_object_agg(project_id::text,stage),'{}')
     FROM opc_accounts WHERE actor_id=r.actor_id AND business_id=r.business_id AND erased_at IS NULL),
    strategy_checked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE actor_id=r.actor_id AND business_id=r.business_id;
  END IF;
 ELSIF p_action='skip' AND st='running' THEN
  -- The caller closes an expired or disabled turn before it skips; a turn still running here keeps the claim.
  RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',x.id,'state','running','expired',false);
 ELSIF p_action='skip' OR p_action='observe' AND st='failed' THEN
  -- An interruption the turn recovery job closed before this scheduler looked (observe) is retried like one reported by skip.
  why:=coalesce(p_reason,CASE WHEN p_action='observe' AND x.close_kind IN ('interrupted','failed','expired') THEN 'RUNTIME_INTERRUPTED' END);
  -- An unknown financial outcome keeps the claim: the turn recovery owns the held credits until the turn is settled.
  IF x.id IS NOT NULL AND x.settlement IS DISTINCT FROM 'done' THEN
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',x.id,'state','cost_pending');END IF;
  spent:=CASE WHEN x.id IS NULL THEN 0 ELSE (SELECT coalesce(sum(turn_call_spent_usd(call_kind,nominal_usd,actual_usd)) FILTER (WHERE status='ok'),0)
    +coalesce(sum(actual_usd) FILTER (WHERE status='unusable'),0) FROM turn_calls WHERE turn_id=x.id) END;
  IF why='RUNTIME_INTERRUPTED' AND r.attempt<3 AND allowed AND r.max_cost_usd-spent>0 THEN
   -- A deploy or a killed invocation is not the user's week lost: the settled attempt keeps its own request and receipts; the next
   -- attempt gets a new request in the same session, claimable by the next batch at once. Every attempt shares one cap: the known
   -- cost comes off it; a turn whose cost is still unknown (settlement pending) never retries (returned above).
   UPDATE social_review_runs SET attempt=attempt+1,runtime_request_id=gen_random_uuid(),turn_id=NULL,max_cost_usd=r.max_cost_usd-spent,
    created_at=clock_timestamp(),lease_expires_at=clock_timestamp() WHERE id=r.id;
   RETURN jsonb_build_object('allowed',false,'actorId',r.actor_id,'turnId',x.id,'state','retrying','expired',false);
  END IF;
  UPDATE social_review_runs SET status='skipped',skip_reason=coalesce(why,'RUNTIME_ENDED'),
   finished_at=clock_timestamp(),lease_expires_at=NULL WHERE id=r.id;
 END IF;
 RETURN jsonb_build_object('allowed',allowed,'actorId',r.actor_id,'turnId',x.id,'state',st,
  'sessionId',r.runtime_session_id,'requestId',r.runtime_request_id,'modelId',r.model_id,'maxCostUsd',r.max_cost_usd::text,
  'cadence',r.cadence,'businessId',r.business_id,'attempt',r.attempt,
  -- A scheduler-owned review has no user present to resume it: a turn still running after 15 minutes is expired (the caller
  -- closes it as interrupted and then skips); the turn recovery job closes what the caller never reaches.
  'expired',coalesce(st='running' AND r.created_at<=clock_timestamp()-interval '15 minutes',false));
END $$;


CREATE OR REPLACE FUNCTION public.publish_monitor_reviews(a uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM publish_monitor_actor(a);
 RETURN coalesce((SELECT jsonb_agg(v ORDER BY v->>'createdAt' DESC) FROM (
  SELECT jsonb_build_object('id',r.id,'periodStart',r.period_start,'status',r.status,'skipReason',r.skip_reason,
   'createdAt',r.created_at,'sessionId',r.runtime_session_id,'executionId',r.turn_id::text,
   -- The body is the turn's saved assistant message; a deleted conversation or an erasing account shows nothing.
   'body',CASE WHEN r.status='completed' AND r.turn_id IS NOT NULL AND s.id IS NOT NULL AND s.content_deleted_at IS NULL AND s.erased_at IS NULL
      AND r.pack IS NOT NULL AND publish_monitor_pack_visible(a,r.pack) THEN
     (SELECT m.content FROM session_messages m WHERE m.session_id=s.id AND m.turn_id=r.turn_id AND m.role='assistant'
       AND m.deleted_at IS NULL ORDER BY m.seq DESC LIMIT 1)
    END,
   -- The numeric table comes only from the host's code-computed result saved with the review. Model text is never parsed into it.
   'tables',CASE WHEN r.status='completed' AND r.turn_id IS NOT NULL AND r.pack IS NOT NULL AND s.content_deleted_at IS NULL AND s.erased_at IS NULL
      AND publish_monitor_pack_visible(a,r.pack) THEN r.pack->'review'
 END,
   'notice',CASE WHEN r.status='completed' THEN '本周复盘已生成'
    WHEN r.status='claimed' AND t.close_kind='completed' AND t.delivered AND t.settlement='pending' THEN '本周复盘已生成，费用正在核对。'
    WHEN r.skip_reason='BALANCE_LOW' THEN '余额不足，未复盘'
    WHEN r.skip_reason='RUNTIME_INTERRUPTED' THEN CASE
     WHEN t.id IS NULL OR t.settlement='done' THEN '本周复盘生成中断，已用积分按实际结算，未用部分已退回。'
     ELSE '本周复盘生成中断，费用正在核对；核对后退回未用部分。' END
    WHEN r.skip_reason='RUNTIME_ENDED' THEN '本周复盘生成未完成，这一周已结束，下周会正常安排。' END) v
  FROM social_review_runs r LEFT JOIN runtime_sessions s ON s.id=r.runtime_session_id AND s.actor_id=a
  LEFT JOIN turns t ON t.id=r.turn_id AND t.actor_id=a
  WHERE r.actor_id=a AND NOT (r.status='completed' AND r.turn_id IS NULL) ORDER BY r.created_at DESC LIMIT 52) q),'[]'::jsonb);
END $$;


-- One-time closure of what the old path left behind (only rows that still match).
UPDATE public.social_review_runs r SET status='skipped',skip_reason='RUNTIME_ENDED',finished_at=clock_timestamp(),lease_expires_at=NULL
 WHERE r.status='claimed' AND r.turn_id IS NULL
  AND EXISTS(SELECT 1 FROM runtime_executions x WHERE x.actor_id=r.actor_id AND x.request_id=r.runtime_request_id);
UPDATE public.social_billed_reads r SET state='abandoned',updated_at=clock_timestamp()
 WHERE r.state IN ('opened','dispatched') AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.request_id=r.run_id);
UPDATE public.social_billed_runs b SET closed_at=clock_timestamp()
 WHERE b.closed_at IS NULL AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.request_id=b.run_id);

CREATE OR REPLACE FUNCTION public.publish_monitor_billed_run(p_connection_id uuid,p_lease uuid,p_refresh_id uuid,
 p_run_id uuid,p_policies jsonb) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c social_connections; b social_billed_runs;
BEGIN
 c:=publish_monitor_refresh_current(p_connection_id,p_lease,p_refresh_id);
 IF c.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO b FROM social_billed_runs WHERE connection_id=c.id AND refresh_id=p_refresh_id AND closed_at IS NULL FOR UPDATE;
 IF b.run_id IS NULL AND p_run_id IS NOT NULL THEN
  IF jsonb_typeof(p_policies) IS DISTINCT FROM 'array'
   OR NOT EXISTS(SELECT 1 FROM turns WHERE request_id=p_run_id AND actor_id=c.actor_id AND kind='review') THEN
   RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
  INSERT INTO social_billed_runs(run_id,connection_id,refresh_id,actor_id,policies)
  VALUES(p_run_id,c.id,p_refresh_id,c.actor_id,p_policies) RETURNING * INTO b;
 END IF;
 RETURN CASE WHEN b.run_id IS NULL THEN jsonb_build_object('runId',NULL)
  ELSE jsonb_build_object('runId',b.run_id,'policies',b.policies) END;
END $$;

-- The live ledger attempts of a left-open run (opened or dispatched): the daily job abandons them so their keys are free again.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_recovery(p_run_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('operationId',r.id) ORDER BY r.created_at),'[]'::jsonb)
 FROM social_billed_reads r WHERE r.run_id=p_run_id AND r.state IN ('opened','dispatched')
$$;

-- Nothing is dropped except the three triggers (they can be rebuilt from 0307); the functions stay as empty shells so no function body
-- names an old object any more.
DROP TRIGGER IF EXISTS publish_monitor_review_admit_guard ON public.runtime_executions;
DROP TRIGGER IF EXISTS publish_monitor_review_result_guard ON public.runtime_executions;
DROP TRIGGER IF EXISTS publish_monitor_review_call_guard ON public.bill2_calls;
CREATE OR REPLACE FUNCTION public.publish_monitor_review_admit_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.publish_monitor_review_result_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION public.publish_monitor_review_call_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$ BEGIN RETURN NEW; END $$;
-- Reviews are told from runs by the turn now; this answers "is it a pre-turn run" as before but names no old object.
CREATE OR REPLACE FUNCTION public.publish_monitor_billed_legacy(p_run_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT NOT EXISTS(SELECT 1 FROM turns WHERE request_id=p_run_id AND kind='review')
$$;

DO $$ DECLARE f regprocedure; BEGIN
 FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('publish_monitor_post_window','publish_monitor_pack_visible',
   'publish_monitor_review_step','publish_monitor_reviews','publish_monitor_review_supplement','publish_monitor_billed_run',
   'publish_monitor_billed_recovery','publish_monitor_review_admit_guard','publish_monitor_review_result_guard','publish_monitor_review_call_guard','publish_monitor_billed_legacy') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
  EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
 END LOOP;
END $$;
COMMIT;
