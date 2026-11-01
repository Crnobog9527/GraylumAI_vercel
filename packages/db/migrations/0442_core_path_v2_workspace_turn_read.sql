-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-6 part B (number 0442 assigned by the controller): the read_source tool of a free chat also reads the user's own
-- workspace (confirmed positioning, strategy, topics, benchmarks, strategy report) and own post data, as the old path did.
-- The old readers cannot run in the middle of a turn: runtime_workspace_source writes memo settings and calls functions that lock
-- profiles. Three new functions split the work (ENGINEERING section 5, free-read rule of 2026-10-28, widened 2026-11-01):
--   opc_workspace_sources(actor)  before turn_open only, never a free read: the source versions the old check still allows
--                                 (opc_source_allowed, the deep tombstone chain, unchanged); Node hands the list to the turn's reads
--   workspace_turn_read           free read: the workspace index and one entry, only over the versions in that list
--   posts_turn_read               free read: the user's saved post data for a window Node took from the tier before turn_open
-- Both free reads are STABLE, take the owner's key first, write nothing, lock nothing, filter every table by the owner (or by
-- the two 2026-11-01 lists) and do not read system_settings or profiles. A session that is not the caller's own live one, or an
-- account being erased, reads nothing. The window and the review flags are not model input: read_source only ever passes
-- what Node resolved from the membership tier.
-- The own-data tier is read from membership_plans before turn_open through the catalog cache (ENGINEERING section 5: site-wide
-- admin-written catalogs), so a change to that table now bumps the 'settings' catalog version like system_settings does, with the
-- same three triggers 0419 installs (they write nothing but the version row; membership_plans is changed only by admins).
-- Compatibility: the functions are new and unused until the code that offers them ships; old code keeps working unchanged.
-- Repeatable: CREATE OR REPLACE. Recovery: DROP FUNCTION public.posts_turn_read(uuid,uuid,integer,boolean,boolean);
-- DROP FUNCTION public.workspace_turn_read(uuid,uuid,text,uuid[]); DROP FUNCTION public.opc_workspace_sources(uuid);
-- DROP TRIGGER catalog_versions_insert_delete / _change / _truncate ON public.membership_plans; no data changes.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.opc_workspace_sources(p_actor_id uuid)
 RETURNS uuid[]
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce(array_agg(x.version_id), '{}') FROM (
  SELECT DISTINCT y.version_id FROM (
   SELECT b.current_source_version_id version_id FROM opc_businesses b
    WHERE b.actor_id=p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id IS NOT NULL
   UNION ALL
   SELECT ac.source_version_id FROM opc_accounts ac WHERE ac.actor_id=p_actor_id
   UNION ALL
   SELECT i.source_version_id FROM opc_items i JOIN opc_accounts ac ON ac.project_id=i.account_project_id
    WHERE ac.actor_id=p_actor_id) y
  WHERE opc_source_allowed(p_actor_id, y.version_id) LIMIT 200) x
$function$;
REVOKE ALL ON FUNCTION public.opc_workspace_sources(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.opc_workspace_sources(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.workspace_turn_read(p_actor_id uuid, p_session_id uuid, p_query text, p_allowed uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE q text := coalesce(p_query, ''); entries jsonb; entry jsonb; body text; version_id uuid; item_id uuid; bench_session uuid;
  cap integer := 4000; produced jsonb; strategy jsonb; fit jsonb; profile jsonb;
BEGIN
 IF p_actor_id IS NULL OR p_session_id IS NULL OR octet_length(q) > 400 OR p_allowed IS NULL OR cardinality(p_allowed) > 200 THEN
  RAISE EXCEPTION 'WORKSPACE_TURN_READ_INVALID' USING ERRCODE='22023';
 END IF;
 -- Only the caller's own live conversation, and never while the account is being erased (the same checks as library_turn_read).
 IF NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = p_session_id AND s.actor_id = p_actor_id
     AND s.content_deleted_at IS NULL AND s.erased_at IS NULL)
   OR EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id = p_actor_id) THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_deleted');
 END IF;

 -- A revoked draft or an erased version is dropped at every read, not only at turn start: the list from turn_open can be minutes old.
 -- (The deeper chain, evidence and result-link tombstones, is the check before turn_open; the next turn sees any change there.)
 SELECT coalesce(array_agg(v.id), '{}') INTO p_allowed FROM artifact_versions v
  WHERE v.id = ANY(p_allowed) AND v.erased_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM opc_drafts d JOIN bill2_drafts bd ON bd.id = d.draft_id AND bd.actor_id = p_actor_id
    WHERE d.actor_id = p_actor_id AND d.project_id = v.project_id AND bd.revoked);
 -- The same directory as runtime_workspace_source, over the versions the check before turn_open allowed.
 SELECT coalesce(jsonb_agg(x.entry ORDER BY x.rank, x.id), '[]') INTO entries FROM (
  SELECT 0 rank, b.id::text id, jsonb_build_object('id', b.id, 'kind', 'positioning', 'name', b.name, 'confirmedAt', v.created_at,
     'sourceVersionId', b.current_source_version_id)
   || CASE WHEN opc_strategy_data(b.current_source_version_id) IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('strategyReport',
    jsonb_build_object('id', 'strategy_report:' || b.id, 'use', 'Finalized report strategy data with these confirmed fields: next steps, '
     || 'this week, 30-day plan and metrics, monetization, audience, benchmarks, assumptions.')) END entry
  FROM opc_businesses b JOIN artifact_versions v ON v.id = b.current_source_version_id
  WHERE b.actor_id = p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id = ANY(p_allowed)
  UNION ALL
  SELECT 1, s.session_id::text, jsonb_build_object('id', s.session_id, 'kind', 'benchmarks', 'name', b.name, 'sessionId', s.session_id,
    'accounts', s.accounts, 'qualified', s.qualified, 'fetchedAt', s.fetched_at, 'sourceVersionId', b.current_source_version_id,
    'use', 'Real public data of benchmark accounts fetched during positioning research; numbers come only from this table.')
  FROM opc_businesses b CROSS JOIN LATERAL (
   SELECT d.session_id, count(*)::int accounts, (count(*) FILTER (WHERE rb.qualified))::int qualified, max(rb.fetched_at) fetched_at
   FROM opc_draft_businesses db JOIN opc_drafts d ON d.draft_id = db.draft_id AND d.actor_id = p_actor_id
    AND d.project_id = (SELECT cv.project_id FROM artifact_versions cv WHERE cv.id = b.current_source_version_id)
   JOIN runtime_sessions rs ON rs.id = d.session_id AND rs.actor_id = p_actor_id AND rs.content_deleted_at IS NULL AND rs.erased_at IS NULL
   JOIN research_benchmarks rb ON rb.session_id = d.session_id AND rb.actor_id = p_actor_id
   WHERE db.business_id = b.id AND (rb.turn_id IS NOT NULL OR EXISTS (SELECT 1 FROM runtime_executions x WHERE x.id = rb.execution_id
     AND x.actor_id = p_actor_id AND x.session_id = d.session_id AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
   GROUP BY d.session_id ORDER BY max(rb.fetched_at) DESC, d.session_id LIMIT 1) s
  WHERE b.actor_id = p_actor_id AND b.erased_at IS NULL AND b.current_source_version_id = ANY(p_allowed)
  UNION ALL
  SELECT 2, ac.project_id::text, jsonb_build_object('id', ac.project_id, 'kind', 'strategy', 'platform', ac.platform,
    'account', coalesce((SELECT u.display_name FROM opc_account_ui u WHERE u.actor_id = p_actor_id AND u.account_project_id = ac.project_id),
     ac.account_key), 'sourceVersionId', ac.source_version_id)
  FROM opc_accounts ac WHERE ac.actor_id = p_actor_id AND ac.source_version_id = ANY(p_allowed)
  UNION ALL
  SELECT 2, i.work_item_id::text, jsonb_build_object('id', i.work_item_id, 'kind', 'topic', 'platform', ac.platform,
    'account', coalesce((SELECT u.display_name FROM opc_account_ui u WHERE u.actor_id = p_actor_id AND u.account_project_id = ac.project_id),
     ac.account_key), 'title', coalesce((SELECT e.title FROM opc_item_edits e WHERE e.work_item_id = i.work_item_id), p.work_title),
    'sourceVersionId', i.source_version_id)
  FROM opc_items i JOIN opc_accounts ac ON ac.project_id = i.account_project_id
  JOIN artifact_projects p ON p.id = i.work_item_id AND p.actor_id = p_actor_id
  WHERE ac.actor_id = p_actor_id AND i.source_version_id = ANY(p_allowed)
  ORDER BY rank, id LIMIT 40
 ) x;
 IF q = '' THEN RETURN jsonb_build_object('kind', 'workspace_index', 'entries', entries); END IF;

 -- One read gives the confirmed fields and both strategy groups; over 48000 bytes whole strategy fields are dropped in the fixed order.
 IF q LIKE 'strategy\_report:%' THEN
  SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'kind' = 'positioning' AND x->'strategyReport'->>'id' = q;
  IF entry IS NULL THEN RETURN jsonb_build_object('kind', 'unavailable'); END IF;
  version_id := (entry->>'sourceVersionId')::uuid; strategy := opc_strategy_data(version_id);
  IF strategy IS NULL THEN RETURN jsonb_build_object('kind', 'unavailable'); END IF;
  profile := opc_profile(version_id);
  fit := report_strategy_fit(strategy->'data', report_strategy_fields(), greatest(0, 48000 - octet_length(coalesce(profile, 'null'::jsonb)::text)));
  RETURN jsonb_build_object('kind', 'workspace_source',
   'identity', (entry - 'strategyReport') || jsonb_build_object('id', q, 'kind', 'strategy_report', 'positioningId', entry->'id'),
   'body', jsonb_build_object('profile', profile, 'strategy', fit->'strategy', 'strategyTextEdited', strategy->'textEdited',
    'strategyDropped', fit->'dropped', 'use', opc_strategy_use()),
   'truncated', jsonb_array_length(fit->'dropped') > 0);
 END IF;

 SELECT x INTO entry FROM jsonb_array_elements(entries) x WHERE x->>'id' = q;
 IF entry IS NULL THEN RETURN jsonb_build_object('kind', 'unavailable'); END IF;
 version_id := (entry->>'sourceVersionId')::uuid;
 IF entry->>'kind' IN ('strategy', 'positioning') THEN body := opc_profile(version_id)::text;
 ELSIF entry->>'kind' = 'benchmarks' THEN
  bench_session := (entry->>'sessionId')::uuid;
  SELECT coalesce(jsonb_agg(jsonb_build_object('platform', b.platform, 'account', b.account, 'followers', b.followers,
    'medianViews', b.median_views, 'engagementRate', b.engagement_rate, 'postsPerWeek', b.posts_per_week,
    'lastPublishedAt', b.last_published_at, 'postsAnalyzed', b.posts_analyzed, 'category', b.category, 'qualified', b.qualified,
    'excluded', b.excluded, 'missing', to_jsonb(b.missing), 'fetchedAt', b.fetched_at)
    ORDER BY b.qualified DESC, b.followers DESC NULLS LAST, b.platform, b.account), '[]'::jsonb)::text INTO body
  FROM (SELECT rb.* FROM research_benchmarks rb
    WHERE rb.actor_id = p_actor_id AND rb.session_id = bench_session
      AND (rb.turn_id IS NOT NULL OR EXISTS (SELECT 1 FROM runtime_executions x WHERE x.id = rb.execution_id
       AND x.actor_id = p_actor_id AND x.session_id = rb.session_id AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
    ORDER BY rb.qualified DESC, rb.followers DESC NULLS LAST, rb.platform, rb.account LIMIT 30) b;
  cap := 8000;
  entry := entry - 'accounts' - 'qualified' - 'fetchedAt';
 ELSE
  item_id := (entry->>'id')::uuid;
  SELECT coalesce((SELECT e.brief FROM opc_item_edits e WHERE e.work_item_id = i.work_item_id), i.brief) INTO body
   FROM opc_items i JOIN opc_accounts ac ON ac.project_id = i.account_project_id
   WHERE i.work_item_id = item_id AND ac.actor_id = p_actor_id;
 END IF;
 RETURN jsonb_build_object('kind', 'workspace_source', 'identity', entry, 'body', left(body, cap), 'truncated', length(body) > cap);
END $function$;
REVOKE ALL ON FUNCTION public.workspace_turn_read(uuid, uuid, text, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.workspace_turn_read(uuid, uuid, text, uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.posts_turn_read(p_actor_id uuid, p_session_id uuid, p_window_days integer, p_review boolean, p_benchmarks boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE since timestamptz; since_day date; today date := (clock_timestamp() AT TIME ZONE 'UTC')::date; data jsonb; review jsonb;
BEGIN
 IF p_actor_id IS NULL OR p_session_id IS NULL OR p_window_days IS NULL OR p_window_days NOT BETWEEN 1 AND 90
   OR p_review IS NULL OR p_benchmarks IS NULL THEN
  RAISE EXCEPTION 'POSTS_TURN_READ_INVALID' USING ERRCODE='22023';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = p_session_id AND s.actor_id = p_actor_id
     AND s.content_deleted_at IS NULL AND s.erased_at IS NULL)
   OR EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id = p_actor_id) THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_deleted');
 END IF;
 since := clock_timestamp() - make_interval(days => p_window_days);
 since_day := (since AT TIME ZONE 'UTC')::date;
 -- The shape of publish_monitor_data, every table by the owner.
 SELECT jsonb_build_object('windowDays', p_window_days,
  'connections', coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'platform', c.platform, 'status', c.status,
    'lastSuccessAt', c.last_success_at, 'refreshDay', c.refresh_day, 'refreshState', c.refresh_state,
    'refreshError', c.refresh_error, 'autoTrack', c.consent_auto_track,
    'delayed', c.status = 'connected' AND c.consent_auto_track AND (c.last_success_at IS NULL
     OR c.last_success_at < clock_timestamp() - interval '2 days') AND (c.refresh_day IS NULL OR c.refresh_day < today - 1),
    'manualRefreshAt', c.manual_refresh_at) ORDER BY c.created_at, c.id)
   FROM social_connections c WHERE c.actor_id = p_actor_id AND c.role = 'own' AND c.status NOT IN ('deleting', 'pending_selection')), '[]'::jsonb),
  'posts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id, 'connectionId', p.connection_id, 'source', p.source,
    'url', p.post_url, 'postedAt', p.posted_at, 'postedAtSource', p.posted_at_source, 'firstSeenAt', p.created_at,
    'titleExcerpt', p.title_excerpt, 'workItemId', p.work_item_id,
    'latest', (SELECT jsonb_build_object('capturedOn', s.captured_on, 'metrics', s.metrics, 'missingFields', to_jsonb(s.missing_fields),
      'breakdowns', s.breakdowns)
     FROM social_metric_snapshots s WHERE s.actor_id = p_actor_id AND s.post_id = p.id AND s.captured_on >= since_day
     ORDER BY s.captured_on DESC LIMIT 1)) ORDER BY coalesce(p.posted_at, p.created_at) DESC, p.id)
   FROM (SELECT q.* FROM social_posts q JOIN social_connections c ON c.id = q.connection_id AND c.actor_id = p_actor_id
    WHERE q.actor_id = p_actor_id AND c.role = 'own' AND c.status NOT IN ('deleting', 'pending_selection')
     AND coalesce(q.posted_at, q.created_at) >= since
    ORDER BY coalesce(q.posted_at, q.created_at) DESC, q.id LIMIT 500) p), '[]'::jsonb)) INTO data;
 IF NOT p_review THEN RETURN jsonb_build_object('kind', 'posts', 'data', data); END IF;
 -- The review's history in this one read: the 30 newest own posts, and the benchmark supplement of a plan that has it.
 WITH accounts AS (SELECT c.id, c.platform FROM social_connections c WHERE c.actor_id = p_actor_id AND c.role = 'benchmark'
   AND c.status = 'connected' AND c.consent_read AND p_benchmarks),
 own AS (SELECT q.id FROM social_posts q JOIN social_connections c ON c.id = q.connection_id AND c.actor_id = p_actor_id
   WHERE q.actor_id = p_actor_id AND c.role = 'own' AND c.status NOT IN ('deleting', 'pending_selection')
    AND q.posted_at >= since AND q.posted_at <= clock_timestamp() ORDER BY q.posted_at DESC, q.id LIMIT 30),
 benchmark AS (SELECT q.* FROM social_posts q JOIN accounts c ON c.id = q.connection_id
   WHERE q.actor_id = p_actor_id AND q.posted_at >= since AND q.posted_at <= clock_timestamp() ORDER BY q.posted_at DESC, q.id LIMIT 30)
 SELECT jsonb_build_object(
  'histories', coalesce((SELECT jsonb_agg(jsonb_build_object('postId', o.id, 'snapshots', coalesce((SELECT jsonb_agg(
    jsonb_build_object('capturedOn', s.captured_on, 'metrics', s.metrics, 'missingFields', to_jsonb(s.missing_fields), 'source', s.source)
    ORDER BY s.captured_on) FROM social_metric_snapshots s WHERE s.actor_id = p_actor_id AND s.post_id = o.id AND s.captured_on >= since_day), '[]')))
    FROM own o), '[]'),
  'connections', coalesce((SELECT jsonb_agg(jsonb_build_object('id', a.id, 'platform', a.platform)) FROM accounts a), '[]'),
  'posts', coalesce((SELECT jsonb_agg(jsonb_build_object('id', b.id, 'connectionId', b.connection_id, 'postedAt', b.posted_at,
    'source', b.source, 'titleExcerpt', b.title_excerpt)) FROM benchmark b), '[]'),
  'benchmarkHistories', coalesce((SELECT jsonb_agg(jsonb_build_object('postId', b.id, 'snapshots', coalesce((SELECT jsonb_agg(
    jsonb_build_object('capturedOn', s.captured_on, 'metrics', s.metrics, 'missingFields', to_jsonb(s.missing_fields), 'source', s.source)
    ORDER BY s.captured_on) FROM social_metric_snapshots s WHERE s.actor_id = p_actor_id AND s.post_id = b.id AND s.captured_on >= since_day), '[]')))
    FROM benchmark b), '[]'),
  'followers', coalesce((SELECT jsonb_agg(jsonb_build_object('connectionId', c.id, 'platform', c.platform, 'source', c.source,
    'current', (SELECT jsonb_build_object('date', s.captured_on, 'value', s.metrics->'followers') FROM social_metric_snapshots s
     WHERE s.actor_id = p_actor_id AND s.connection_id = c.id AND s.post_id IS NULL AND s.metrics ? 'followers'
      AND NOT ('followers' = ANY(s.missing_fields)) ORDER BY s.captured_on DESC LIMIT 1),
    'previous', (SELECT jsonb_build_object('date', s.captured_on, 'value', s.metrics->'followers') FROM social_metric_snapshots s
     WHERE s.actor_id = p_actor_id AND s.connection_id = c.id AND s.post_id IS NULL AND s.metrics ? 'followers'
      AND NOT ('followers' = ANY(s.missing_fields)) AND s.captured_on = today - 7 LIMIT 1),
    'note', CASE WHEN c.source = 'postforme' THEN '平台不提供' ELSE '未取到时不比较' END))
   FROM social_connections c WHERE c.actor_id = p_actor_id AND c.role = 'own' AND c.status = 'connected'), '[]')) INTO review;
 RETURN jsonb_build_object('kind', 'posts', 'data', data, 'review', review);
END $function$;
REVOKE ALL ON FUNCTION public.posts_turn_read(uuid, uuid, integer, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.posts_turn_read(uuid, uuid, integer, boolean, boolean) TO service_role;

DROP TRIGGER IF EXISTS catalog_versions_insert_delete ON public.membership_plans;
DROP TRIGGER IF EXISTS catalog_versions_change ON public.membership_plans;
DROP TRIGGER IF EXISTS catalog_versions_truncate ON public.membership_plans;
CREATE TRIGGER catalog_versions_insert_delete AFTER INSERT OR DELETE ON public.membership_plans
 FOR EACH ROW EXECUTE FUNCTION public.catalog_versions_bump('settings');
CREATE TRIGGER catalog_versions_change AFTER UPDATE ON public.membership_plans
 FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION public.catalog_versions_bump('settings');
CREATE TRIGGER catalog_versions_truncate AFTER TRUNCATE ON public.membership_plans
 FOR EACH STATEMENT EXECUTE FUNCTION public.catalog_versions_bump('settings');

COMMIT;
