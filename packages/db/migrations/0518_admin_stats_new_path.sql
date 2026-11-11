-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CODE-HEALTH: the admin home, finance and performance pages on the per-turn core.
--   These pages counted rows of `conversations`, `messages`, `token_stats` and `ai_usage_logs`, which only the retired chat path
--   wrote: on a database built from files (production) conversations, messages, requests, cost per model and the credits users
--   spent would all read 0 for ever (only the cost page had been moved, 0478). The home page also summed whole tables in Node from
--   unpaged reads (every profile, every ticket, every ledger row), which PostgREST cuts at 1000 rows, and counted spend by the
--   ledger type name 'deduction', which the per-turn core does not write (it writes 'consumption' with ledger_type 'spend').
--   The core tables are not readable by any API role (0420), so the numbers are aggregated here and returned small.
--   turn_admin_usage_days(from, to, daily_from): model and decision calls that were spent (status ok or unusable, the same rows as
--     turn_admin_cost_rows), grouped by model and UTC day. Days before `daily_from` are folded into one row per model (day NULL), so
--     an all-time read stays a few rows. Credits are the turn's charged credits, on the turn's first spent call only (as in 0478),
--     so sums by model, day or window never count a turn twice. A token sum is NULL when any call of the group did not record that
--     count: unknown is not zero. `from` NULL means from the beginning.
--   turn_admin_activity(from, to, calls_from): conversations (sessions by their first chat, mentor or compare turn: the all-time
--     total and count per model, and per UTC day and model inside [from, to)), visible undeleted messages by side (all-time and per
--     day inside the window), and the finished model calls of [calls_from, to) with their failures and duration (dispatch to
--     record; avg and p95 over successful calls). The page's chart window and its "requests" window differ, hence two starts.
--   admin_dashboard_stats(today, week, month): users (total, new since each boundary, credits held), tickets by status, the ledger
--     by type and ledger type, credits actually spent, and granted and spent credits per UTC day since `week`.
-- All three are STABLE, read-only, take no lock and are granted to service_role only (the admin router checks the admin role).
-- Compatible: three new functions; deployed code does not call them. Repeatable: CREATE OR REPLACE and idempotent grants.
-- Recovery: DROP FUNCTION public.turn_admin_usage_days(timestamptz, timestamptz, timestamptz),
--   public.turn_admin_activity(timestamptz, timestamptz, timestamptz), public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz);
--   no data is written.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_admin_usage_days(p_from timestamp with time zone, p_to timestamp with time zone,
  p_daily_from timestamp with time zone)
 RETURNS TABLE(model_used text, day date, requests bigint, total_credits bigint, total_cost_usd text, input_tokens bigint,
  output_tokens bigint, cached_tokens bigint, cache_creation_tokens bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_to IS NULL OR p_daily_from IS NULL OR (p_from IS NOT NULL AND p_from >= p_to) THEN
  RAISE EXCEPTION 'TURN_REPORT_WINDOW_INVALID' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 -- The credit-carrying call is chosen among the turn's whole set of spent calls BEFORE the window is applied (0478): the same call
 -- carries the credits whatever window is asked for.
 WITH ranked AS (
  SELECT k.*, row_number() OVER (PARTITION BY k.turn_id ORDER BY k.seq) first_rank
  FROM turn_calls k WHERE k.call_kind IN ('model','decision') AND k.status IN ('ok','unusable')
   AND (p_from IS NULL OR k.turn_id IN (SELECT w.turn_id FROM turn_calls w WHERE w.dispatched_at>=p_from AND w.dispatched_at<p_to))
 ), calls AS (
  SELECT
   -- A decision call is attributed to the model its receipt names, never to the turn's main model.
   (CASE WHEN k.call_kind='decision' THEN coalesce(nullif(k.usage->>'model',''), 'decision (model not recorded)')
     ELSE coalesce(t.policy->'models'->>(k.model_id::text), t.policy->>'model', 'unknown') END)::text model,
   CASE WHEN k.dispatched_at>=p_daily_from THEN (k.dispatched_at AT TIME ZONE 'UTC')::date END d,
   CASE WHEN k.first_rank=1 THEN coalesce(t.charged_credits,0) ELSE 0 END credits,
   CASE WHEN k.status='ok' THEN turn_call_spent_usd(k.call_kind,k.nominal_usd,k.actual_usd) ELSE coalesce(k.actual_usd,0) END cost,
   k.usage
  FROM ranked k JOIN turns t ON t.actor_id=k.actor_id AND t.id=k.turn_id
  WHERE (p_from IS NULL OR k.dispatched_at>=p_from) AND k.dispatched_at<p_to
 )
 SELECT c.model, c.d, count(*), sum(c.credits)::bigint, coalesce(sum(c.cost),0)::text,
  CASE WHEN bool_and(jsonb_typeof(c.usage->'inputTokens')='number') THEN sum((c.usage->>'inputTokens')::numeric)::bigint END,
  CASE WHEN bool_and(jsonb_typeof(c.usage->'outputTokens')='number') THEN sum((c.usage->>'outputTokens')::numeric)::bigint END,
  CASE WHEN bool_and(jsonb_typeof(c.usage->'cachedTokens')='number') THEN sum((c.usage->>'cachedTokens')::numeric)::bigint END,
  CASE WHEN bool_and(jsonb_typeof(c.usage->'cacheCreationTokens')='number') THEN sum((c.usage->>'cacheCreationTokens')::numeric)::bigint END
 FROM calls c GROUP BY c.model, c.d;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_admin_activity(p_from timestamp with time zone, p_to timestamp with time zone,
  p_calls_from timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_from IS NULL OR p_to IS NULL OR p_calls_from IS NULL OR p_from >= p_to OR p_calls_from >= p_to THEN
  RAISE EXCEPTION 'TURN_REPORT_WINDOW_INVALID' USING ERRCODE='22023';
 END IF;
 WITH firsts AS MATERIALIZED (
  -- One row per conversation: its first chat, mentor or compare turn (a report, a jury review or a voice profile runs inside or
  -- beside a conversation and is not one; a scheduled review is not started by a user).
  SELECT DISTINCT ON (t.session_id) t.session_id, t.opened_at, coalesce(t.policy->>'model','unknown') model
  FROM turns t WHERE t.kind IN ('chat','mentor','compare') AND t.session_id IS NOT NULL
  ORDER BY t.session_id, t.opened_at, t.id
 ), msgs AS MATERIALIZED (
  SELECT m.role, m.created_at FROM session_messages m WHERE m.visible AND m.deleted_at IS NULL
 ), calls AS MATERIALIZED (
  -- Finished model and decision calls. In flight (dispatched, identified) and undecided (unknown) calls are neither a success
  -- nor a failure yet.
  SELECT k.status, CASE WHEN k.status='ok' THEN extract(epoch FROM k.settled_at-k.dispatched_at)*1000 END ms
  FROM turn_calls k WHERE k.call_kind IN ('model','decision') AND k.dispatched_at>=p_calls_from AND k.dispatched_at<p_to
   AND k.status IN ('ok','unusable','rejected','no_charge_402','not_sent')
 )
 SELECT jsonb_build_object(
  'conversations', jsonb_build_object(
   'total', (SELECT count(*) FROM firsts),
   'byModel', coalesce((SELECT jsonb_agg(jsonb_build_object('model',g.model,'count',g.n) ORDER BY g.n DESC, g.model)
    FROM (SELECT f.model, count(*) n FROM firsts f GROUP BY f.model) g),'[]'::jsonb),
   'days', coalesce((SELECT jsonb_agg(jsonb_build_object('date',to_char(g.d,'YYYY-MM-DD'),'model',g.model,'count',g.n) ORDER BY g.d, g.model)
    FROM (SELECT (f.opened_at AT TIME ZONE 'UTC')::date d, f.model, count(*) n FROM firsts f
     WHERE f.opened_at>=p_from AND f.opened_at<p_to GROUP BY 1, 2) g),'[]'::jsonb)),
  'messages', jsonb_build_object(
   'user', (SELECT count(*) FROM msgs WHERE role='user'),
   'assistant', (SELECT count(*) FROM msgs WHERE role='assistant'),
   'days', coalesce((SELECT jsonb_agg(jsonb_build_object('date',to_char(g.d,'YYYY-MM-DD'),'user',g.u,'assistant',g.a) ORDER BY g.d)
    FROM (SELECT (m.created_at AT TIME ZONE 'UTC')::date d, count(*) FILTER (WHERE m.role='user') u,
      count(*) FILTER (WHERE m.role='assistant') a
     FROM msgs m WHERE m.created_at>=p_from AND m.created_at<p_to GROUP BY 1) g),'[]'::jsonb)),
  'calls', jsonb_build_object(
   'finished', (SELECT count(*) FROM calls),
   'failed', (SELECT count(*) FROM calls WHERE status<>'ok'),
   'avgMs', (SELECT round(avg(ms)) FROM calls WHERE ms IS NOT NULL),
   'p95Ms', (SELECT round(percentile_disc(0.95) WITHIN GROUP (ORDER BY ms)) FROM calls WHERE ms IS NOT NULL))
 ) INTO result;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.admin_dashboard_stats(p_today timestamp with time zone, p_week timestamp with time zone,
  p_month timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_today IS NULL OR p_week IS NULL OR p_month IS NULL THEN
  RAISE EXCEPTION 'ADMIN_STATS_WINDOW_INVALID' USING ERRCODE='22023';
 END IF;
 SELECT jsonb_build_object(
  'users', (SELECT jsonb_build_object('total', count(*), 'today', count(*) FILTER (WHERE p.created_at>=p_today),
     'week', count(*) FILTER (WHERE p.created_at>=p_week), 'month', count(*) FILTER (WHERE p.created_at>=p_month),
     'credits', coalesce(sum(p.credits),0))
    FROM profiles p WHERE p.is_deleted='false'),
  'tickets', (SELECT jsonb_build_object('total', count(*), 'open', count(*) FILTER (WHERE k.status='open'),
     'inProgress', count(*) FILTER (WHERE k.status='in_progress'), 'closed', count(*) FILTER (WHERE k.status='closed'))
    FROM tickets k WHERE k.is_deleted='false'),
  'ledger', jsonb_build_object(
   'byType', coalesce((SELECT jsonb_object_agg(g.type, jsonb_build_object('count', g.n, 'amount', g.total))
     FROM (SELECT c.type, count(*) n, sum(c.amount) total FROM credit_transactions c GROUP BY c.type) g), '{}'::jsonb),
   -- Credits actually charged: reservations and their release are adjustments, a refund clawback is its own ledger type.
   'spent', (SELECT coalesce(sum(abs(c.amount)),0) FROM credit_transactions c WHERE c.counts_as_spend),
   'days', coalesce((SELECT jsonb_agg(jsonb_build_object('date', to_char(g.d,'YYYY-MM-DD'), 'granted', g.granted, 'spent', g.spent) ORDER BY g.d)
     FROM (SELECT (c.created_at AT TIME ZONE 'UTC')::date d,
       coalesce(sum(c.amount) FILTER (WHERE c.ledger_type='grant' AND c.amount>0),0) granted,
       coalesce(sum(abs(c.amount)) FILTER (WHERE c.counts_as_spend),0) spent
      FROM credit_transactions c WHERE c.created_at>=p_week GROUP BY 1) g), '[]'::jsonb))
 ) INTO result;
 RETURN result;
END $function$;

REVOKE ALL ON FUNCTION public.turn_admin_usage_days(timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.turn_admin_usage_days(timestamptz, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.turn_admin_activity(timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.turn_admin_activity(timestamptz, timestamptz, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_stats(timestamptz, timestamptz, timestamptz) TO service_role;
COMMIT;
