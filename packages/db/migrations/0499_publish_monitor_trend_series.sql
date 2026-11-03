-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR block A (0499): the rows behind the weekly trend charts on
-- the "数据复盘" page (Owner 2026-10-27: followers, per-post views median, engagement rate and posting frequency by week). One read-only
-- function, per own connection: when it was connected, its account-level follower points and its posts with their day-7 numbers,
-- all inside the plan's window. Weeks, medians and rates are computed by the host (same rules as the review pack), never here.
-- Compatibility: a new function only; nothing existing changes, old code never calls it.
-- Repeatable: CREATE OR REPLACE plus REVOKE/GRANT. Recovery: DROP FUNCTION public.publish_monitor_trend_series(uuid,integer).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_trend_series(a uuid, p_window_days integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE since timestamptz;
BEGIN
 IF p_window_days IS NULL OR p_window_days NOT BETWEEN 1 AND 365 THEN
  RAISE EXCEPTION 'PUBLISH_MONITOR_INPUT_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT publish_monitor_actor_open(a) THEN RAISE EXCEPTION 'PUBLISH_MONITOR_ACCOUNT_CLOSED' USING ERRCODE='42501'; END IF;
 since:=clock_timestamp()-make_interval(days=>p_window_days);
 RETURN jsonb_build_object('windowDays',p_window_days,
  'connections',coalesce((SELECT jsonb_agg(jsonb_build_object('id',c.id,'platform',c.platform,'source',c.source,
    'businessId',c.business_id,'businessName',b.name,'connectedAt',c.created_at,
    -- Account-level follower snapshots (TikHub profiles and imports); Post for Me accounts have none.
    'followers',(SELECT coalesce(jsonb_agg(jsonb_build_object('date',s.captured_on,'value',s.metrics->'followers')
      ORDER BY s.captured_on),'[]') FROM social_metric_snapshots s
     WHERE s.connection_id=c.id AND s.actor_id=a AND s.post_id IS NULL AND s.metrics ? 'followers'
      AND NOT ('followers'=ANY(s.missing_fields)) AND s.captured_on>=(since AT TIME ZONE 'UTC')::date),
    -- Posts with a known publish time; day7 is the settled day-7 numbers (null until settled, or when day 7 was missed).
    'posts',(SELECT coalesce(jsonb_agg(jsonb_build_object('postedAt',x.posted_at,'day7',x.day7) ORDER BY x.posted_at),'[]')
     FROM (SELECT sp.posted_at,f.day7 FROM social_posts sp LEFT JOIN social_post_facts f ON f.post_id=sp.id AND f.actor_id=a
      WHERE sp.connection_id=c.id AND sp.actor_id=a AND sp.posted_at IS NOT NULL AND sp.posted_at>=since
      ORDER BY sp.posted_at DESC LIMIT 1000) x)) ORDER BY c.created_at,c.id)
   FROM social_connections c LEFT JOIN opc_businesses b ON b.id=c.business_id AND b.actor_id=a
   WHERE c.actor_id=a AND c.role='own' AND c.status NOT IN ('deleting','pending_selection')),'[]'::jsonb));
END $function$;

REVOKE ALL ON FUNCTION public.publish_monitor_trend_series(uuid,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.publish_monitor_trend_series(uuid,integer) TO service_role;
COMMIT;
