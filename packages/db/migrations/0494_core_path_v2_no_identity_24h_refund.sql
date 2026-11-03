-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 (Owner 2026-11-03, "同意满24小时退还"; supplements 0489 "查无就退"): a model call that never got a provider id (the
-- supplier sent no response headers before the deadline, so turn_close marked it unknown / cost_pending with provider_id NULL) can never
-- be looked up. Once its turn was opened 24 hours ago, turn_call_settle_no_identity records it as rejected with nominal 0 (cost_pending
-- false, usage.source = 'no_identity_24h' with the turn's open time), and the existing turn_recover('settle') pass frees the credits and
-- the stop-loss share, never here. If the supplier did charge, Graylum bears it. Same lock order as 0489 (profile, session, turn), a
-- conditional UPDATE (no row lock on turn_calls), idempotent; nothing before 24 hours; calls with a provider id keep the 0489 path.
-- turn_recovery_claim now also claims such calls (providerId null) of turns 24 hours old; turn_admin_absent_refunds lists both kinds.
-- Compatible: one new function and two whole-function replacements. DEPLOY ORDER: the Node code of this release first (it accepts a null
-- providerId in the claim and the extra list fields); the old Node code would reject a claim holding such a call. Applying the Node
-- code before the migration changes nothing by itself.
-- Repeatable: CREATE OR REPLACE. Recovery: restore the 0489/0424 definitions of the two replaced functions and drop the new one
-- (calls already settled keep their zero cost on record).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_call_settle_no_identity(p_actor_id uuid, p_turn_id bigint, p_seq integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; s runtime_sessions; at_time timestamptz;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order as turn_recover: the profile, the session, then the turn; the turn's row lock serializes every writer of its calls.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  SELECT * INTO c FROM turn_calls WHERE actor_id = p_actor_id AND turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NULL THEN RAISE EXCEPTION 'TURN_CALL_DENIED' USING ERRCODE='42501'; END IF;
  -- The same settlement again: the first outcome, nothing written.
  IF c.status = 'rejected' AND c.usage->>'source' = 'no_identity_24h' THEN
    RETURN jsonb_build_object('settled', true, 'replay', true, 'turnId', p_turn_id, 'seq', p_seq);
  END IF;
  IF t.state <> 'closed' THEN RETURN jsonb_build_object('settled', false, 'reason', 'turn_open'); END IF;
  IF c.call_kind <> 'model' OR c.status <> 'unknown' OR NOT c.cost_pending THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'not_pending');
  END IF;
  -- A call that has an id belongs to the lookup path (turn_call_settle_absent / the receipt), never to this one.
  IF c.provider_id IS NOT NULL THEN RETURN jsonb_build_object('settled', false, 'reason', 'has_identity'); END IF;
  IF now() < t.opened_at + interval '24 hours' THEN RETURN jsonb_build_object('settled', false, 'reason', 'too_early'); END IF;
  at_time := clock_timestamp();
  UPDATE turn_calls SET status = 'rejected', nominal_usd = 0, actual_usd = NULL, cost_pending = false, settled_at = at_time,
      usage = jsonb_build_object('source', 'no_identity_24h', 'settledAt', at_time, 'turnOpenedAt', t.opened_at)
    WHERE turn_id = p_turn_id AND seq = p_seq AND status = 'unknown' AND cost_pending AND provider_id IS NULL;
  RETURN jsonb_build_object('settled', true, 'replay', false, 'turnId', p_turn_id, 'seq', p_seq);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_admin_absent_refunds(p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 WITH absent AS (
  SELECT k.turn_id, k.seq, k.provider_id, k.settled_at, k.usage, t.kind, t.actor_id, t.opened_at, t.reserved_credits, t.charged_credits,
    t.settlement, t.state
  FROM turn_calls k JOIN turns t ON t.actor_id = k.actor_id AND t.id = k.turn_id
  WHERE k.usage->>'source' IN ('lookup_absent', 'no_identity_24h')
 ), page AS (
  SELECT * FROM absent ORDER BY settled_at DESC, turn_id LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 200)
 )
 SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM absent),
  'calls', coalesce((SELECT jsonb_agg(jsonb_build_object('turnId', p.turn_id, 'seq', p.seq, 'actorId', p.actor_id, 'kind', p.kind,
    'source', p.usage->>'source', 'providerId', p.provider_id, 'httpStatus', (p.usage->>'httpStatus')::integer,
    'settledAt', p.settled_at, 'openedAt', p.opened_at,
    'reservedCredits', p.reserved_credits, 'chargedCredits', p.charged_credits, 'settlement', p.settlement, 'state', p.state)
    ORDER BY p.settled_at DESC, p.turn_id) FROM page p), '[]'::jsonb))
$function$;

CREATE OR REPLACE FUNCTION public.turn_recovery_claim(p_limit integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE live jsonb; lookup jsonb; settle jsonb; n integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50 THEN RAISE EXCEPTION 'TURN_RECOVERY_INVALID' USING ERRCODE='22023'; END IF;
  -- 1. Live turns nobody has written for a while (partial index turns_live). The lease is short: a dead instance's claim comes
  -- back after two minutes.
  WITH due AS (
    SELECT actor_id, id, state FROM turns
    WHERE ((state IN ('running','stopping') AND updated_at < now() - interval '15 minutes')
        OR (state = 'paused' AND updated_at < now() - interval '24 hours'))
      AND (recovery_lease_until IS NULL OR recovery_lease_until <= now())
    ORDER BY updated_at LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  ), leased AS (
    UPDATE turns t SET recovery_lease_until = now() + interval '2 minutes' FROM due
    WHERE t.actor_id = due.actor_id AND t.id = due.id
    RETURNING t.actor_id, t.id, due.state
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('actorId', actor_id, 'turnId', id,
    'action', CASE WHEN state = 'paused' THEN 'expire' ELSE 'interrupt' END, 'calls', '[]'::jsonb)), '[]'::jsonb)
  INTO live FROM leased;
  n := p_limit - jsonb_array_length(live);
  IF n = 0 THEN RETURN live; END IF;
  -- 2. Turns paused for credits with a model call whose answer was used but whose cost is not final: its cost is looked up
  -- (the job records the receipt), so a resume after a top-up is not held until the 24-hour expiry. Every two minutes.
  WITH due AS (
    SELECT t.actor_id, t.id FROM turns t
    WHERE t.state = 'paused' AND t.updated_at >= now() - interval '24 hours'
      AND (t.recovery_lease_until IS NULL OR t.recovery_lease_until <= now())
      AND EXISTS (SELECT 1 FROM turn_calls k WHERE k.turn_id = t.id AND k.call_kind = 'model'
        AND k.status IN ('dispatched','identified') AND k.provider_id IS NOT NULL)
    ORDER BY t.recovery_lease_until NULLS FIRST, t.updated_at LIMIT n
    FOR UPDATE OF t SKIP LOCKED
  ), leased AS (
    UPDATE turns t SET recovery_lease_until = now() + interval '2 minutes'
    FROM due WHERE t.actor_id = due.actor_id AND t.id = due.id
    RETURNING t.actor_id, t.id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('actorId', l.actor_id, 'turnId', l.id, 'action', 'lookup',
    'calls', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', k.seq, 'providerId', k.provider_id,
        'model', coalesce(t.policy->'models'->>(k.model_id::text), t.policy->>'model'),
        'pricing', coalesce(t.policy->'pricings'->(k.model_id::text), t.policy->'pricing'),
        'upperUsd', k.upper_usd::text) ORDER BY k.seq), '[]'::jsonb)
      FROM turn_calls k JOIN turns t ON t.actor_id = l.actor_id AND t.id = k.turn_id
      WHERE k.turn_id = l.id AND k.call_kind = 'model' AND k.status IN ('dispatched','identified') AND k.provider_id IS NOT NULL))),
    '[]'::jsonb)
  INTO lookup FROM leased l;
  n := n - jsonb_array_length(lookup);
  IF n = 0 THEN RETURN live || lookup; END IF;
  -- 3. (0494) A call that never got a provider id (the supplier sent nothing before the deadline) cannot be looked up; once its turn is
  -- 24 hours old it is claimed with providerId null and the job settles it at zero through turn_call_settle_no_identity.
  -- Closed turns still settling (partial index turns_settlement_pending), least recently tried first: a final receipt that
  -- arrived after the last pass, or an unknown model cost whose provider id can be looked up. The lease is the lookup interval.
  WITH due AS (
    SELECT t.actor_id, t.id, t.closed_at FROM turns t
    WHERE t.settlement = 'pending' AND t.state = 'closed'
      AND (t.recovery_lease_until IS NULL OR t.recovery_lease_until <= now())
      AND EXISTS (SELECT 1 FROM turn_calls k WHERE k.turn_id = t.id
        AND ((k.cost_pending AND k.provider_id IS NOT NULL AND k.call_kind = 'model')
          OR (k.cost_pending AND k.provider_id IS NULL AND k.call_kind = 'model' AND k.status = 'unknown'
            AND t.opened_at <= now() - interval '24 hours')
          OR (NOT k.cost_pending AND k.settled_at > t.updated_at)))
    ORDER BY t.recovery_lease_until NULLS FIRST, t.updated_at LIMIT n
    FOR UPDATE OF t SKIP LOCKED
  ), leased AS (
    UPDATE turns t SET recovery_lease_until = now()
      + CASE WHEN due.closed_at > now() - interval '24 hours' THEN interval '10 minutes' ELSE interval '6 hours' END
    FROM due WHERE t.actor_id = due.actor_id AND t.id = due.id
    RETURNING t.actor_id, t.id
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('actorId', l.actor_id, 'turnId', l.id, 'action', 'settle',
    'calls', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', k.seq, 'providerId', k.provider_id,
        -- The model and price table frozen at open (a multi-model kind freezes them per model id), never the catalog's current
        -- values: an edited model slug or price must not change how an old call is matched or priced.
        'model', coalesce(t.policy->'models'->>(k.model_id::text), t.policy->>'model'),
        'pricing', coalesce(t.policy->'pricings'->(k.model_id::text), t.policy->'pricing'),
        'upperUsd', k.upper_usd::text) ORDER BY k.seq), '[]'::jsonb)
      FROM turn_calls k JOIN turns t ON t.actor_id = l.actor_id AND t.id = k.turn_id WHERE k.turn_id = l.id AND k.cost_pending AND k.call_kind = 'model'
        AND (k.provider_id IS NOT NULL OR (k.status = 'unknown' AND t.opened_at <= now() - interval '24 hours'))))),
    '[]'::jsonb)
  INTO settle FROM leased l;
  RETURN live || lookup || settle;
END $function$;


REVOKE ALL ON FUNCTION public.turn_call_settle_no_identity(uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.turn_call_settle_no_identity(uuid,bigint,integer) TO service_role;

COMMIT;
