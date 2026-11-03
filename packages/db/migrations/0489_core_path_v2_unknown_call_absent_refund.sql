-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 round 12 defect 1 (Owner 2026-11-03, "同意自动退还"): a model call whose cost stayed unknown (turn_close marked it
-- unknown / cost_pending) is settled at zero when the provider answers for its provider id "no such generation" (HTTP 404 only;
-- a timeout, 5xx or network error is never evidence) AND the turn was opened at least 24 hours ago (the provider's records may lag).
-- turn_call_settle_absent records that one call as rejected with nominal 0 (cost_pending false, usage.source = 'lookup_absent' with
-- the provider id, status and a hash of the answer, so every settlement stays on record); the credits and the stop-loss share are then
-- freed by the existing turn_recover('settle') pass, never here. If the provider did charge, Graylum bears it. Idempotent and
-- race-free: the profile, session and turn are locked in turn_recover's order, a repeat returns the first outcome, and nothing but a
-- cost_pending unknown model call of a closed turn can be settled. turn_admin_absent_refunds lists these settlements (read-only).
-- Compatible: new functions and one partial index only; no existing function or table shape changes. Repeatable: CREATE OR REPLACE /
-- IF NOT EXISTS. Recovery: drop the two functions and the index (calls already settled keep their zero cost on record).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_call_settle_absent(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_provider_id text,
  p_http_status integer, p_payload_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; s runtime_sessions; at_time timestamptz;
BEGIN
  -- Only an explicit "not found" counts; the caller checks it too, this is the last line.
  IF p_http_status IS DISTINCT FROM 404 OR p_provider_id IS NULL OR p_payload_hash IS NULL OR p_payload_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order as turn_recover: the profile, the session, then the turn; the turn's row lock serializes every writer of its calls
  -- (turn_call_record and turn_close take it first), so the call is read under it and written by a conditional UPDATE.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  SELECT * INTO c FROM turn_calls WHERE actor_id = p_actor_id AND turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NULL THEN RAISE EXCEPTION 'TURN_CALL_DENIED' USING ERRCODE='42501'; END IF;
  -- The same settlement again (a repeat or a concurrent run that lost the lock): the first outcome, nothing written.
  IF c.status = 'rejected' AND c.usage->>'source' = 'lookup_absent' THEN
    RETURN jsonb_build_object('settled', true, 'replay', true, 'turnId', p_turn_id, 'seq', p_seq);
  END IF;
  IF t.state <> 'closed' THEN RETURN jsonb_build_object('settled', false, 'reason', 'turn_open'); END IF;
  IF c.call_kind <> 'model' OR c.status <> 'unknown' OR NOT c.cost_pending THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'not_pending');
  END IF;
  IF c.provider_id IS DISTINCT FROM p_provider_id THEN RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023'; END IF;
  -- The provider's records may lag: not before the turn is 24 hours old.
  IF now() < t.opened_at + interval '24 hours' THEN RETURN jsonb_build_object('settled', false, 'reason', 'too_early'); END IF;
  at_time := clock_timestamp();
  UPDATE turn_calls SET status = 'rejected', nominal_usd = 0, actual_usd = NULL, cost_pending = false, settled_at = at_time,
      payload_hash = p_payload_hash,
      usage = jsonb_build_object('source', 'lookup_absent', 'providerId', p_provider_id, 'httpStatus', p_http_status,
        'queriedAt', at_time, 'turnOpenedAt', t.opened_at)
    WHERE turn_id = p_turn_id AND seq = p_seq AND status = 'unknown' AND cost_pending;
  RETURN jsonb_build_object('settled', true, 'replay', false, 'turnId', p_turn_id, 'seq', p_seq);
END $function$;

CREATE INDEX IF NOT EXISTS turn_calls_lookup_absent ON public.turn_calls (settled_at DESC) WHERE usage->>'source' = 'lookup_absent';

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
  WHERE k.usage->>'source' = 'lookup_absent'
 ), page AS (
  SELECT * FROM absent ORDER BY settled_at DESC, turn_id LIMIT LEAST(GREATEST(coalesce(p_limit, 100), 1), 200)
 )
 SELECT jsonb_build_object(
  'total', (SELECT count(*) FROM absent),
  'calls', coalesce((SELECT jsonb_agg(jsonb_build_object('turnId', p.turn_id, 'seq', p.seq, 'actorId', p.actor_id, 'kind', p.kind,
    'providerId', p.provider_id, 'httpStatus', (p.usage->>'httpStatus')::integer, 'settledAt', p.settled_at, 'openedAt', p.opened_at,
    'reservedCredits', p.reserved_credits, 'chargedCredits', p.charged_credits, 'settlement', p.settlement, 'state', p.state)
    ORDER BY p.settled_at DESC, p.turn_id) FROM page p), '[]'::jsonb))
$function$;

REVOKE ALL ON FUNCTION public.turn_call_settle_absent(uuid,bigint,integer,text,integer,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.turn_call_settle_absent(uuid,bigint,integer,text,integer,text) TO service_role;
REVOKE ALL ON FUNCTION public.turn_admin_absent_refunds(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.turn_admin_absent_refunds(integer) TO service_role;

COMMIT;
