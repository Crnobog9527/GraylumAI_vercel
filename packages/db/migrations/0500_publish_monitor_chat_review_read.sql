-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- PUBLISH-MONITOR block E (number 0500 assigned by the controller): a review asked for in a free
-- chat (Owner 2026-10-27, "用户主动要求复盘"). read_source reads one brand's coach review rows in the middle of a turn, and the host
-- builds the same review pack as the scheduled coach (publishMonitor/coach/pack.ts, cadence 'chat'). Nothing is fetched from a supplier.
-- publish_monitor_review_pack_rows cannot be that read: it is not a free read (ENGINEERING section 5, free-read rule of 2026-10-28,
-- widened 2026-11-01) since its owner argument is `a` and it checks the account through publish_monitor_actor_open, which reads
-- profiles. coach_pack_turn_read returns the same rows (same shape, same 52-week bound, same row limits), with the owner's key first,
-- every table filtered by it (artifact_versions only by the confirmed version's id), STABLE, no write, no lock, no system_settings or
-- profiles read. The membership tier and the switches are not model input: Node resolves them before turn_open and offers the read only
-- when they allow it. A session that is not the caller's own live one, or an account being erased, reads nothing.
-- p_business_id NULL: the caller's brands with an own connection (not erased, not archived); one brand is read at once, several are
-- listed for the model to choose from.
-- Compatibility: new and unused until the code that offers it ships; old code keeps working unchanged.
-- Repeatable: CREATE OR REPLACE. Recovery: DROP FUNCTION public.coach_pack_turn_read(uuid,uuid,uuid); no data changes.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.coach_pack_turn_read(p_actor_id uuid, p_session_id uuid, p_business_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE since timestamptz := clock_timestamp() - make_interval(weeks => 52); brands jsonb; biz uuid := p_business_id;
BEGIN
 IF p_actor_id IS NULL OR p_session_id IS NULL THEN RAISE EXCEPTION 'COACH_PACK_TURN_READ_INVALID' USING ERRCODE='22023'; END IF;
 IF NOT EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = p_session_id AND s.actor_id = p_actor_id
     AND s.content_deleted_at IS NULL AND s.erased_at IS NULL)
   OR EXISTS (SELECT 1 FROM account_erasure_requests r WHERE r.profile_id = p_actor_id) THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'source_deleted');
 END IF;
 -- The brands a review can cover: the scheduled coach's (an own connection, the brand neither erased nor archived).
 IF biz IS NULL THEN
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) ORDER BY x.id), '[]') INTO brands FROM (
   SELECT DISTINCT b.id, b.name FROM opc_businesses b JOIN social_connections c ON c.business_id = b.id AND c.actor_id = p_actor_id
    AND c.role = 'own' AND c.status IN ('connected', 'reauth_required', 'quarantined')
   WHERE b.actor_id = p_actor_id AND b.erased_at IS NULL AND b.archived_at IS NULL ORDER BY b.id LIMIT 20) x;
  IF jsonb_array_length(brands) = 0 THEN RETURN jsonb_build_object('kind', 'coach_review', 'status', 'no_brand'); END IF;
  IF jsonb_array_length(brands) > 1 THEN RETURN jsonb_build_object('kind', 'coach_brands', 'brands', brands); END IF;
  biz := (brands->0->>'id')::uuid;
 -- A named brand is checked on its own, so one beyond the listed twenty can still be read.
 ELSIF NOT EXISTS (SELECT 1 FROM opc_businesses b JOIN social_connections c ON c.business_id = b.id AND c.actor_id = p_actor_id
    AND c.role = 'own' AND c.status IN ('connected', 'reauth_required', 'quarantined')
   WHERE b.id = biz AND b.actor_id = p_actor_id AND b.erased_at IS NULL AND b.archived_at IS NULL) THEN
  RETURN jsonb_build_object('kind', 'unavailable', 'reason', 'brand_not_found');
 END IF;
 -- The rows of publish_monitor_review_pack_rows(actor, brand, 52), each table by the owner.
 RETURN jsonb_build_object('kind', 'coach_rows', 'businessId', biz, 'rows', jsonb_build_object(
  'profile', (SELECT jsonb_build_object('strategyVersionId', p.strategy_version_id, 'pillars', p.pillars,
    'pillarsSource', p.pillars_source, 'pillarMixTarget', p.pillar_mix_target, 'strategyCheckedAt', p.strategy_checked_at)
   FROM social_coach_profiles p WHERE p.actor_id = p_actor_id AND p.business_id = biz),
  'strategy', (SELECT jsonb_object_agg(k, d->k) FROM social_coach_profiles p JOIN artifact_versions v ON v.id = p.strategy_version_id
    CROSS JOIN LATERAL (SELECT opc_strategy_data(v.id)->'data' d) x
    CROSS JOIN unnest(ARRAY['summary','goal','positioning','audience','accountKit','content','roadmap','funnel']) k
   WHERE p.actor_id = p_actor_id AND p.business_id = biz AND x.d ? k),
  'accounts', coalesce((SELECT jsonb_agg(jsonb_build_object('projectId', o.project_id, 'platform', o.platform, 'stage', o.stage)
    ORDER BY o.platform) FROM opc_accounts o WHERE o.actor_id = p_actor_id AND o.business_id = biz AND o.erased_at IS NULL), '[]'),
  'followers', coalesce((SELECT jsonb_agg(jsonb_build_object('connectionId', c.id, 'platform', c.platform, 'source', c.source,
    'points', (SELECT coalesce(jsonb_agg(jsonb_build_object('date', s.captured_on, 'value', s.metrics->'followers') ORDER BY s.captured_on), '[]')
     FROM social_metric_snapshots s WHERE s.actor_id = p_actor_id AND s.connection_id = c.id AND s.post_id IS NULL
      AND s.metrics ? 'followers' AND NOT ('followers' = ANY(s.missing_fields)))) ORDER BY c.platform)
   FROM social_connections c WHERE c.actor_id = p_actor_id AND c.business_id = biz AND c.role = 'own'
    AND c.status IN ('connected', 'reauth_required', 'quarantined')), '[]'),
  'facts', coalesce((SELECT jsonb_agg(jsonb_build_object('postId', f.post_id, 'platform', f.platform, 'postedAt', f.posted_at,
    'title', sp.title_excerpt, 'url', sp.post_url, 'pillarKey', f.pillar_key, 'pillarSource', f.pillar_source, 'formatTags', f.format_tags,
    'basis', f.settled_basis, 'day7', f.day7, 'day7On', f.day7_on, 'day30', f.day30, 'day30On', f.day30_on,
    'importCumulative', f.import_cumulative, 'importOn', f.import_on, 'missing', f.missing_fields) ORDER BY f.posted_at DESC)
   FROM (SELECT * FROM social_post_facts q WHERE q.actor_id = p_actor_id AND q.business_id = biz AND q.posted_at >= since
    ORDER BY q.posted_at DESC LIMIT 1500) f JOIN social_posts sp ON sp.id = f.post_id AND sp.actor_id = p_actor_id), '[]'),
  'recent', coalesce((SELECT jsonb_agg(jsonb_build_object('postId', sp.id, 'platform', c.platform, 'postedAt', sp.posted_at,
    'title', sp.title_excerpt,
    'pillarKey', (SELECT f.pillar_key FROM social_post_facts f WHERE f.actor_id = p_actor_id AND f.post_id = sp.id))
    ORDER BY sp.posted_at DESC)
   FROM social_posts sp JOIN social_connections c ON c.id = sp.connection_id AND c.actor_id = p_actor_id AND c.role = 'own'
    AND c.business_id = biz
   -- pack_rows' LEFT JOIN, spelled as subselects (an outer join's ON does not hold the owner key for the free-read scan).
   WHERE sp.actor_id = p_actor_id AND sp.posted_at >= clock_timestamp() - interval '14 days'
    AND NOT EXISTS (SELECT 1 FROM social_post_facts f WHERE f.actor_id = p_actor_id AND f.post_id = sp.id
     AND (f.day7 IS NOT NULL OR f.import_cumulative IS NOT NULL))), '[]'),
  'experiments', coalesce((SELECT jsonb_agg(to_jsonb(e) - 'actor_id' - 'business_id' ORDER BY e.created_at DESC)
   FROM (SELECT * FROM social_review_experiments q WHERE q.actor_id = p_actor_id AND q.business_id = biz
    ORDER BY q.created_at DESC LIMIT 100) e), '[]'),
  'diagnostics', coalesce((SELECT jsonb_agg(jsonb_build_object('id', d.id, 'postId', d.post_id, 'platform', d.platform,
    'source', d.source, 'rates', d.rates, 'openingText', d.opening_text, 'videoSeconds', d.video_seconds, 'dropSecond', d.drop_second,
    'capturedOn', d.captured_on, 'reviewRunId', d.review_run_id) ORDER BY d.captured_on DESC)
   FROM (SELECT * FROM social_post_diagnostics q WHERE q.actor_id = p_actor_id AND q.business_id = biz
    AND q.captured_on >= (since AT TIME ZONE 'UTC')::date ORDER BY q.captured_on DESC LIMIT 30) d), '[]')));
END $function$;
REVOKE ALL ON FUNCTION public.coach_pack_turn_read(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.coach_pack_turn_read(uuid, uuid, uuid) TO service_role;
COMMIT;
