-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 RECONCILE (b): a turn whose model call has a provider id but whose status lookup keeps timing out, answering 5xx or
-- 429, or that has no platform key, keeps its credit freeze for ever: the daily reconciliation read only settled turns, the recovery
-- job does not count "still frozen" as a failure, and the old manual compensation functions went with BILL2 (#1609, #1623, 0505).
-- AGENTS 5: a user's money frozen for long is not covered by the 5 USD loss line.
--   turn_admin_stuck_turns(): read-only, turns that are not closed and have not been written for 24 hours (opened 24 hours ago or more;
--     the same idle rule as the recovery job's expiry, so a jury review between two seat groups is not counted), or closed with the
--     user's charge still undecided (charged_credits NULL: an unknown model cost holds it) and opened 24 hours ago or more, or closed with
--     the settlement still pending 48 hours after the close (user charged; the stop-loss share never released). The daily
--     billing-reconcile run counts them and alerts. Two index-backed branches (turns_live, turns_settlement_pending), no table scan.
--   turn_admin_refund_all(actor, turn, admin, request, reason): the admin action "按回合全额退回并关闭". Same eligibility as above (refuses a
--     younger turn and a turn already settled for the user), then settles the turn's unknown model calls at zero (usage.source
--     'admin_refund_all', as 0494 does for a call without an id; if the supplier did charge, Graylum bears it) and calls turn_close with
--     p_refund_all (an open turn) or settles the closed turn once more with closeRefundAll (turn_close's replay branch), so the freeze
--     returns through the existing turn_settle_holds. Same lock order as turn_close (profile, session, turn). Idempotent: a repeat or a
--     race finds the turn settled and changes nothing. Written to user_activity_logs by the same transaction (an account being erased
--     drops its audit row by the 0192 guard; the ledger rows stay). A closed REPORT keeps its own settlement rule (turn_report_settlement
--     ignores refund_all): its only call was the unknown one, now zero, so the charge is what that rule gives for zero usage; the
--     result returns the charged credits so nothing is promised that was not done.
--   AUTOMATIC PATH FOR TOOL CALLS (staging turns 6626 and 6639): 0494's 24-hour settlement and the recovery claim were hard-coded to
--     call_kind='model', so a tool call (web_fetch) left status 'unknown' / cost_pending with no provider id kept its closed turn in
--     settlement 'pending' for ever (the user was already charged and the freeze released at the close; what stayed was the turn's
--     stop-loss reservation and the pending status). turn_call_settle_no_identity now also settles such a tool call after 24 hours: it
--     stays status 'unknown' with actual_usd NULL (never presumed free for the platform, still counted as an unknown actual cost by the
--     admin report) but no longer holds the settlement; turn_recovery_claim claims and lists it, and the existing settle pass completes
--     the turn. No Node change: the recovery job already settles every claimed call with providerId null through this function.
-- Compatible: two new functions and two whole-function replacements (the old Node code reads the same claim shape: a tool call with
--   providerId null, model null). Repeatable: CREATE OR REPLACE.
-- Recovery: DROP the two new functions and restore the 0494 definitions of turn_call_settle_no_identity and turn_recovery_claim
--   (refunds and tool calls already settled keep their records).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_admin_stuck_turns()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT jsonb_build_object('total', count(*), 'oldestOpenedAt', min(x.opened_at))
 FROM (
  SELECT t.opened_at FROM turns t
  WHERE t.state IN ('running', 'paused', 'stopping') AND t.opened_at < now() - interval '24 hours' AND t.updated_at < now() - interval '24 hours'
  UNION ALL
  SELECT t.opened_at FROM turns t
  WHERE t.settlement = 'pending' AND t.state = 'closed' AND t.charged_credits IS NULL AND t.opened_at < now() - interval '24 hours'
  UNION ALL
  -- Closed, the user already charged, but the settlement (a late cost, the stop-loss reservation) still pending 48 hours after the close:
  -- recovery should have completed it within 24 hours; it holds no user credits but is never silent.
  SELECT t.opened_at FROM turns t
  WHERE t.settlement = 'pending' AND t.state = 'closed' AND t.charged_credits IS NOT NULL AND t.closed_at < now() - interval '48 hours'
    -- only a pending call the 24-hour settlement can complete (no provider id): an alert here means recovery itself is stuck
    AND EXISTS (SELECT 1 FROM turn_calls k WHERE k.turn_id = t.id AND k.cost_pending AND k.status = 'unknown' AND k.provider_id IS NULL
      AND k.call_kind IN ('model', 'tool', 'decision'))
 ) x
$function$;

CREATE OR REPLACE FUNCTION public.turn_admin_refund_all(p_actor_id uuid, p_turn_id bigint, p_admin_id uuid, p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; s runtime_sessions; at_time timestamptz; closed jsonb; settled integer; was_state text; was_close text; reserved integer;
BEGIN
  IF p_admin_id IS NULL OR p_request_id IS NULL OR NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_admin_id AND role = 'admin' AND status = 'active' AND is_deleted = 'false') THEN
    RAISE EXCEPTION 'TURN_ADMIN_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order as turn_close: the profile, the session, then the turn.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  -- Settled for the user already (an earlier refund, recovery, a normal close): the first outcome, nothing written.
  IF t.state = 'closed' AND t.charged_credits IS NOT NULL THEN
    RETURN jsonb_build_object('refunded', false, 'reason', 'already_settled', 'turnId', t.id, 'chargedCredits', t.charged_credits);
  END IF;
  -- A turn still open must also have been idle for 24 hours (a jury review between two seat groups keeps writing its turn).
  IF now() < t.opened_at + interval '24 hours' OR (t.state <> 'closed' AND now() < t.updated_at + interval '24 hours') THEN
    RETURN jsonb_build_object('refunded', false, 'reason', 'too_young', 'turnId', t.id);
  END IF;
  IF t.state = 'closed' AND t.settlement <> 'pending' THEN
    RETURN jsonb_build_object('refunded', false, 'reason', 'not_pending', 'turnId', t.id);
  END IF;
  was_state := t.state; was_close := t.close_kind; reserved := t.reserved_credits;
  -- Every model call without a final receipt is settled at zero (a call whose cost stays unknown for good would hold the user's
  -- credits for ever); tool and decision calls keep their own pending cost (the stop-loss share), never the user's.
  at_time := clock_timestamp();
  -- No provider id: nothing was observed from the supplier, settled at zero as 0494 does. A provider id: the supplier may have charged,
  -- so the call stays 'unknown' with no actual cost (the cost report keeps counting it) but no longer holds the user's credits.
  UPDATE turn_calls SET status = CASE WHEN provider_id IS NULL THEN 'rejected' ELSE 'unknown' END,
      nominal_usd = CASE WHEN provider_id IS NULL THEN 0 ELSE NULL END, actual_usd = NULL, cost_pending = false, settled_at = at_time,
      usage = jsonb_build_object('source', 'admin_refund_all', 'settledAt', at_time, 'turnOpenedAt', t.opened_at, 'adminId', p_admin_id)
    WHERE actor_id = p_actor_id AND turn_id = p_turn_id AND call_kind = 'model'
      AND ((status = 'unknown' AND cost_pending) OR status IN ('dispatched', 'identified'));
  IF t.state <> 'closed' THEN
    closed := public.turn_close(p_actor_id, p_turn_id, 'failed', '[]'::jsonb, false, true, 'admin_refund_all', NULL);
  ELSE
    UPDATE turns SET policy = policy || '{"closeRefundAll": true}'::jsonb WHERE actor_id = p_actor_id AND id = p_turn_id;
    closed := public.turn_close(p_actor_id, p_turn_id, t.close_kind, '[]'::jsonb, false, false, NULL, NULL);
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  -- The refund must be decided now: a user's charge still undecided means an unknown model cost still holds it. Nothing is kept.
  IF t.state <> 'closed' OR t.charged_credits IS NULL THEN RAISE EXCEPTION 'TURN_REFUND_INCOMPLETE' USING ERRCODE='55000'; END IF;
  INSERT INTO user_activity_logs(id, user_id, admin_id, action, action_type, details)
    VALUES (p_request_id, p_actor_id, p_admin_id, 'turn_admin_refund_all', 'admin', jsonb_build_object(
      'turnId', t.id, 'kind', t.kind, 'stateBefore', was_state, 'closeKindBefore', was_close, 'openedAt', t.opened_at,
      'reservedCredits', reserved, 'chargedCredits', t.charged_credits, 'closeKind', t.close_kind, 'reason', left(p_reason, 200)));
  RETURN jsonb_build_object('refunded', true, 'turnId', t.id, 'chargedCredits', t.charged_credits, 'reservedCredits', reserved,
    'closeKind', t.close_kind, 'settlement', t.settlement, 'stateBefore', was_state);
END $function$;

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
  IF (c.status = 'rejected' AND c.usage->>'source' = 'no_identity_24h')
    OR (c.call_kind IN ('tool', 'decision') AND NOT c.cost_pending AND c.usage->>'source' = 'tool_no_identity_24h') THEN
    RETURN jsonb_build_object('settled', true, 'replay', true, 'turnId', p_turn_id, 'seq', p_seq);
  END IF;
  IF t.state <> 'closed' THEN RETURN jsonb_build_object('settled', false, 'reason', 'turn_open'); END IF;
  IF c.call_kind NOT IN ('model', 'tool', 'decision') OR c.status <> 'unknown' OR NOT c.cost_pending THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'not_pending');
  END IF;
  -- A call that has an id belongs to the lookup path (turn_call_settle_absent / the receipt), never to this one.
  IF c.provider_id IS NOT NULL THEN RETURN jsonb_build_object('settled', false, 'reason', 'has_identity'); END IF;
  IF now() < t.opened_at + interval '24 hours' THEN RETURN jsonb_build_object('settled', false, 'reason', 'too_early'); END IF;
  at_time := clock_timestamp();
  -- A tool call with no provider id (a web fetch whose supplier never answered): the user pays nothing for it (Owner 10-13: a sub-call
  -- whose price is unknown is 0 to the user, already so at the close), and its supplier cost is NOT presumed zero for the platform: the
  -- call stays status 'unknown' with actual_usd NULL, which the admin cost report keeps counting as an unknown actual cost, but it no
  -- longer holds the turn's settlement, so the settle pass releases its stop-loss reservation and completes the turn.
  IF c.call_kind IN ('tool', 'decision') THEN
    UPDATE turn_calls SET cost_pending = false, settled_at = at_time,
        usage = jsonb_build_object('source', 'tool_no_identity_24h', 'settledAt', at_time, 'turnOpenedAt', t.opened_at)
      WHERE turn_id = p_turn_id AND seq = p_seq AND status = 'unknown' AND cost_pending AND provider_id IS NULL AND call_kind IN ('tool', 'decision');
    RETURN jsonb_build_object('settled', true, 'replay', false, 'turnId', p_turn_id, 'seq', p_seq);
  END IF;
  UPDATE turn_calls SET status = 'rejected', nominal_usd = 0, actual_usd = NULL, cost_pending = false, settled_at = at_time,
      usage = jsonb_build_object('source', 'no_identity_24h', 'settledAt', at_time, 'turnOpenedAt', t.opened_at)
    WHERE turn_id = p_turn_id AND seq = p_seq AND status = 'unknown' AND cost_pending AND provider_id IS NULL;
  RETURN jsonb_build_object('settled', true, 'replay', false, 'turnId', p_turn_id, 'seq', p_seq);
END $function$;

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
          OR (k.cost_pending AND k.provider_id IS NULL AND k.call_kind IN ('model', 'tool', 'decision') AND k.status = 'unknown'
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
      FROM turn_calls k JOIN turns t ON t.actor_id = l.actor_id AND t.id = k.turn_id WHERE k.turn_id = l.id AND k.cost_pending
        AND ((k.call_kind = 'model' AND (k.provider_id IS NOT NULL OR (k.status = 'unknown' AND t.opened_at <= now() - interval '24 hours')))
          OR (k.call_kind IN ('tool', 'decision') AND k.provider_id IS NULL AND k.status = 'unknown' AND t.opened_at <= now() - interval '24 hours'))))),
    '[]'::jsonb)
  INTO settle FROM leased l;
  RETURN live || lookup || settle;
END $function$;

REVOKE ALL ON FUNCTION public.turn_admin_stuck_turns() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.turn_admin_stuck_turns() TO service_role;
REVOKE ALL ON FUNCTION public.turn_admin_refund_all(uuid, bigint, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.turn_admin_refund_all(uuid, bigint, uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.turn_call_settle_no_identity(uuid, bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.turn_call_settle_no_identity(uuid, bigint, integer) TO service_role;
REVOKE ALL ON FUNCTION public.turn_recovery_claim(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.turn_recovery_claim(integer) TO service_role;

COMMIT;
