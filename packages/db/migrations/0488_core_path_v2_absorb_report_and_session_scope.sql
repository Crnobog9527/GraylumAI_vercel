-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12: two new functions the old path's deletion needs (batch F drops the functions they replace).
--   turn_platform_absorb_report(p_from, p_to): the platform-absorbed cost alert (bill2PlatformAlerts) read BILL2 calls. This returns the
--     same row shape from turns: a turn's absorbed_credits (what its nominal cost N exceeded the freeze H by, so the platform bears it),
--     split over the models of its spent calls by their nominal cost x multiplier, grouped by model and UTC day of the close.
--     credits_per_usd is the turn's frozen q, call_multiplier is 1 (the multiplier is already inside N), platform_bound_credits is 0
--     (a turn has one absorbed amount, not a cap part and a bound part). Amounts are whole credits (rounded per group).
--   runtime_session_scope(p_actor_id, p_session_id): the narrowed runtime.view reads a session's scope only. Returns sessionId, scope and
--     legacy (no turn in the session and created more than an hour before this database's first turn: an old-path conversation of
--     staging test data; always false on a database built on the new path). Refusals are runtime_view's: CONTENT_ERASED (42501) and
--     RUNTIME_SCOPE_DENIED.
-- Compatible: new functions only. Repeatable: CREATE OR REPLACE. Recovery: drop the two functions (nothing calls them before the Node switch).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_platform_absorb_report(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS TABLE(model text, utc_date text, credits_per_usd text, call_multiplier text, platform_cap_credits text, platform_bound_credits text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH t AS (
    SELECT x.actor_id, x.id, x.absorbed_credits, (x.policy->>'q')::numeric q, x.closed_at
    FROM turns x
    WHERE x.state = 'closed' AND coalesce(x.absorbed_credits, 0) > 0 AND x.closed_at >= p_from AND x.closed_at < p_to
      AND (x.policy->>'q') ~ '^[0-9]+(\.[0-9]+)?$' AND (x.policy->>'q')::numeric > 0),
  w AS (
    SELECT t.actor_id, t.id, t.absorbed_credits, t.q, t.closed_at, coalesce(m.model_id, c.model_id::text) model, c.nominal_usd * c.multiplier wgt
    FROM t JOIN turn_calls c ON c.actor_id = t.actor_id AND c.turn_id = t.id AND c.call_kind = 'model' AND c.status = 'ok'
    LEFT JOIN ai_models m ON m.id = c.model_id),
  s AS (SELECT actor_id, id, sum(wgt) total FROM w GROUP BY actor_id, id)
  SELECT w.model, to_char(w.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), w.q::text, '1',
    round(sum(w.absorbed_credits * CASE WHEN s.total > 0 THEN w.wgt / s.total ELSE 0 END))::bigint::text, '0'
  FROM w JOIN s ON s.actor_id = w.actor_id AND s.id = w.id
  GROUP BY w.model, to_char(w.closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD'), w.q
$function$;

CREATE OR REPLACE FUNCTION public.runtime_session_scope(p_actor_id uuid, p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE s runtime_sessions;
BEGIN
 -- D7 read boundary
 IF EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id AND (erased_at IS NOT NULL OR content_deleted_at IS NOT NULL)) THEN
  RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501';
 END IF;
 PERFORM bill2_actor(p_actor_id);
 SELECT * INTO s FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id;
 IF s.id IS NULL OR NOT coalesce(bill2_scope_allowed(p_actor_id,s.scope),false) THEN RAISE EXCEPTION 'RUNTIME_SCOPE_DENIED'; END IF;
 RETURN jsonb_build_object('sessionId',s.id,'scope',s.scope,
  'legacy',NOT EXISTS(SELECT 1 FROM turns t WHERE t.actor_id=p_actor_id AND t.session_id=s.id)
    AND s.created_at < coalesce((SELECT min(opened_at) FROM turns),s.created_at) - interval '1 hour');
END $function$;

REVOKE ALL ON FUNCTION public.turn_platform_absorb_report(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.turn_platform_absorb_report(timestamptz,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.runtime_session_scope(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.runtime_session_scope(uuid,uuid) TO service_role;

COMMIT;
