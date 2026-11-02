-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 B10: two read-only admin functions on the core-path tables, replacing the BILL2 finance views that are deleted with
-- the old path. turn_admin_model_report(p_from, p_to): model calls grouped by model and by UTC day with the nominal and actual USD
-- the calls recorded, the calls whose cost is still unknown, the frozen multipliers, and the window's turns with the credits they
-- charged and absorbed and how many are still open or settling. turn_admin_unsettled_turns(p_limit): the turns still open or
-- settling (state<>'closed' or settlement='pending'), content-free (ids, kinds, states, counts, times), oldest first, so post-launch
-- reconciliation can see what recovery has not closed. Neither writes, neither reads message text or provider bodies.
-- Compatible: new functions only. Repeatable: CREATE OR REPLACE. Recovery: drop the two functions (nothing calls them but the admin page).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_admin_model_report(p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE result jsonb;
BEGIN
 IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to OR p_to - p_from > interval '92 days' THEN
  RAISE EXCEPTION 'TURN_REPORT_WINDOW_INVALID' USING ERRCODE='22023';
 END IF;
 WITH calls AS MATERIALIZED (
  SELECT k.turn_id, k.status, k.nominal_usd, k.actual_usd, k.multiplier, k.dispatched_at,
   coalesce(t.policy->'models'->>(k.model_id::text), t.policy->>'model', 'unknown') model
  FROM turn_calls k JOIN turns t ON t.actor_id=k.actor_id AND t.id=k.turn_id
  WHERE k.call_kind='model' AND k.dispatched_at>=p_from AND k.dispatched_at<p_to
 ), turns_in AS MATERIALIZED (
  SELECT charged_credits, absorbed_credits, state, settlement FROM turns WHERE opened_at>=p_from AND opened_at<p_to
 )
 SELECT jsonb_build_object(
  'models',coalesce((SELECT jsonb_agg(jsonb_build_object('model',model,'calls',calls,'unknownCostCalls',unknown,
    'nominalUsd',nominal::text,'actualUsd',actual::text,'minMultiplier',min_m::text,'maxMultiplier',max_m::text) ORDER BY calls DESC,model)
   FROM (SELECT model,count(*) calls,count(*) FILTER (WHERE nominal_usd IS NULL) unknown,
     coalesce(sum(nominal_usd),0) nominal,coalesce(sum(actual_usd),0) actual,min(multiplier) min_m,max(multiplier) max_m
    FROM calls GROUP BY model) m),'[]'::jsonb),
  'byDate',coalesce((SELECT jsonb_agg(jsonb_build_object('date',day,'calls',calls,'unknownCostCalls',unknown,'nominalUsd',nominal::text) ORDER BY day)
   FROM (SELECT to_char(dispatched_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,count(*) calls,
     count(*) FILTER (WHERE nominal_usd IS NULL) unknown,coalesce(sum(nominal_usd),0) nominal
    FROM calls GROUP BY 1) d),'[]'::jsonb),
  'totals',jsonb_build_object(
   'calls',(SELECT count(*) FROM calls),
   'unknownCostCalls',(SELECT count(*) FROM calls WHERE nominal_usd IS NULL),
   'nominalUsd',(SELECT coalesce(sum(nominal_usd),0)::text FROM calls),
   'actualUsd',(SELECT coalesce(sum(actual_usd),0)::text FROM calls),
   'turns',(SELECT count(*) FROM turns_in),
   'chargedCredits',(SELECT coalesce(sum(charged_credits),0) FROM turns_in),
   'absorbedCredits',(SELECT coalesce(sum(absorbed_credits),0) FROM turns_in),
   'unsettledTurns',(SELECT count(*) FROM turns_in WHERE state<>'closed' OR settlement='pending'))
 ) INTO result;
 RETURN result;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_admin_unsettled_turns(p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH open AS (
  SELECT t.* FROM turns t WHERE t.state<>'closed' OR t.settlement='pending'
 ), page AS (
  SELECT * FROM open ORDER BY updated_at,id LIMIT LEAST(GREATEST(coalesce(p_limit,100),1),200)
 )
 SELECT jsonb_build_object(
  'total',(SELECT count(*) FROM open),
  'turns',coalesce((SELECT jsonb_agg(jsonb_build_object('turnId',p.id,'actorId',p.actor_id,'kind',p.kind,'state',p.state,
    'settlement',p.settlement,'closeKind',p.close_kind,'openedAt',p.opened_at,'updatedAt',p.updated_at,
    'reservedCredits',p.reserved_credits,'chargedCredits',p.charged_credits,'failureCode',p.failure_code,
    'inFlightCalls',(SELECT count(*) FROM turn_calls k WHERE k.turn_id=p.id AND k.status IN ('dispatched','identified')),
    'costPendingCalls',(SELECT count(*) FROM turn_calls k WHERE k.turn_id=p.id AND k.cost_pending))
    ORDER BY p.updated_at,p.id) FROM page p),'[]'::jsonb))
$function$;

REVOKE ALL ON FUNCTION public.turn_admin_model_report(timestamptz,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.turn_admin_model_report(timestamptz,timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.turn_admin_unsettled_turns(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.turn_admin_unsettled_turns(integer) TO service_role;

COMMIT;
