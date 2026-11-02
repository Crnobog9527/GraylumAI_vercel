-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 B10: the admin AI cost monitor (today / month cost, trend, model split, top users) read only token_stats, which a
-- core-path turn never writes, so every call made through turns was missing from it. turn_admin_cost_rows(p_from, p_to) returns the
-- core-path side in the same row shape as token_stats (user_id, model_used, total_credits, total_cost_usd, created_at): one row per
-- model or decision call whose cost is known and spent (status ok: turn_call_spent_usd; unusable: its actual cost, as turn_close
-- counts them). A turn's charged credits sit on its first row, so sums by day, user or window are right (a per-model credit split of a
-- multi-call turn is approximate). Token counts are not recorded per call, so they stay NULL (unknown). Read-only, content-free.
-- Compatible: new function only. Repeatable: CREATE OR REPLACE. Recovery: drop the function (only the admin cost page calls it).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_admin_cost_rows(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(call_key text, user_id uuid, model_used text, total_credits integer, total_cost_usd text,
  cached_tokens integer, input_tokens integer, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
 IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to OR p_to - p_from > interval '92 days' THEN
  RAISE EXCEPTION 'TURN_REPORT_WINDOW_INVALID' USING ERRCODE='22023';
 END IF;
 RETURN QUERY
 SELECT k.turn_id::text || ':' || k.seq::text,
  k.actor_id,
  -- A decision call is attributed to the model its receipt names, never to the turn's main model.
  (CASE WHEN k.call_kind='decision' THEN coalesce(nullif(k.usage->>'model',''), 'decision (model not recorded)')
    ELSE coalesce(t.policy->'models'->>(k.model_id::text), t.policy->>'model', 'unknown') END)::text,
  (CASE WHEN row_number() OVER (PARTITION BY k.turn_id ORDER BY k.seq)=1 THEN coalesce(t.charged_credits,0) ELSE 0 END)::integer,
  (CASE WHEN k.status='ok' THEN turn_call_spent_usd(k.call_kind,k.nominal_usd,k.actual_usd) ELSE coalesce(k.actual_usd,0) END)::text,
  NULL::integer, NULL::integer, k.dispatched_at
 FROM turn_calls k JOIN turns t ON t.actor_id=k.actor_id AND t.id=k.turn_id
 WHERE k.call_kind IN ('model','decision') AND k.status IN ('ok','unusable')
  AND k.dispatched_at>=p_from AND k.dispatched_at<p_to;
END $function$;

REVOKE ALL ON FUNCTION public.turn_admin_cost_rows(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.turn_admin_cost_rows(timestamptz,timestamptz) TO service_role;

COMMIT;
