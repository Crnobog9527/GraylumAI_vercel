-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- ERASURE-ABANDONED (deep review 2026-11-11, items 1 and 12). Placeholder number 9999: the controller assigns the real one.
--   1. A buyer who left a checkout could never finish account erasure. Release (pay_waffo_close_card_checkout,
--      pay_waffo_abort_before_dispatch, pay_waffo_observe_qualification, pay_waffo_close_uncreated) sets
--      qualification_state='released' and purchase_closed_at but keeps status 'pending' with no close reason, and
--      erasure_payment_terminal (0191, written for the old path) only accepted failed/expired orders with a stripe_* reason.
--      account_erasure_financial_proof counted the order as money in flight forever, so the auth identity was never
--      deleted. erasure_payment_terminal now also accepts a released, closed, unpaid, unfulfilled order;
--      account_erasure_preview's "payments still processing" count uses the same test.
--   12. A turn paused for credits held erasure for 24 hours (the recovery expiry). turn_recovery_claim and turn_recover now
--      expire a paused turn at once when its account is being erased (profiles.is_deleted, set by account_erasure_confirm).
--      The expiry itself is unchanged: refunded in full (expired, not delivered).
--   13. Owner 2026-11-11 ("都按推荐", MASTER_PLAN 2.1): while a refund request is being handled the account cannot start
--      erasure (the cleanup would delete the ticket the refund approval needs). New account_erasure_refund_open: an open
--      billing ticket (账单/退款, not resolved or closed, not deleted) or a refund approval still in progress.
--      account_erasure_preview reports it (refundRequestOpen) for the confirmation page; account_erasure_confirm refuses
--      with ACCOUNT_ERASURE_REFUND_PENDING. A request already confirmed is returned as before (idempotent replay).
-- Whole definitions copied from packages/db/functions/ (other, erasure, turn) and changed only as described; no text patch.
-- Compatibility: same signatures. The preview gains one key (refundRequestOpen); the deployed parser (zod object, not
--   strict) ignores it, and the new code treats a missing key as false. Old code shows the new refusal as the generic
--   "注销暂时无法完成", so deploy the code with this migration. Old and new code can run against either version.
-- Repeatable: CREATE OR REPLACE only; running it twice changes nothing.
-- Recovery: re-apply the five changed whole definitions (and DROP FUNCTION account_erasure_refund_open(uuid)) from packages/db/functions/ at the staging commit before this migration.
--   No data is written, so nothing needs restoring; an erasure that finished in between stays finished (its orders were final).
BEGIN;
SET LOCAL lock_timeout='5s';

-- 13. A refund request still being handled: an open billing ticket or a refund approval in progress.
CREATE OR REPLACE FUNCTION public.account_erasure_refund_open(p_profile_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT EXISTS(SELECT 1 FROM tickets t WHERE t.user_id=p_profile_id AND t.category='billing'
   AND t.status NOT IN ('resolved','closed') AND t.is_deleted::text='false')
  OR EXISTS(SELECT 1 FROM payment_orders o WHERE o.user_id=p_profile_id AND o.refund_approval IS NOT NULL
   AND coalesce(o.refund_approval->>'status','') NOT IN ('rejected','succeeded','failed'));
$function$;
REVOKE ALL ON FUNCTION public.account_erasure_refund_open(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.account_erasure_refund_open(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.erasure_payment_terminal(j jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
 SELECT coalesce((j->>'status' IN ('completed','refunded','partially_refunded')
  AND j->>'payment_status' IN ('paid','refunded','partially_refunded') AND j->>'fulfilled_at' IS NOT NULL
  AND j->>'amount_total' IS NOT NULL)
 OR (j->>'status' IN ('failed','expired') AND j->>'purchase_closed_at' IS NOT NULL
  AND j->>'purchase_close_reason' IN ('stripe_checkout_expired','stripe_checkout_never_created',
   'stripe_checkout_not_prepared','stripe_upgrade_rejected','stripe_upgrade_not_applied'))
 -- ERASURE-ABANDONED (9999): a new-path checkout the buyer left. Release keeps status 'pending' and writes no close reason;
 -- the provider has confirmed nothing can be paid (closed or expired session, never sent, verified absent), so it is final.
 -- A late payment still lands on the order as cash evidence for review, as for any released order.
 OR (j->>'qualification_state'='released' AND j->>'purchase_closed_at' IS NOT NULL AND j->>'payment_status'='unpaid'
  AND j->>'fulfilled_at' IS NULL),false);
$function$;

CREATE OR REPLACE FUNCTION public.account_erasure_preview(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'credits', coalesce((SELECT p.credits FROM public.profiles p WHERE p.id = p_profile_id), 0),
    'subscriptionRenewing', public.account_erasure_renewing(p_profile_id),
    'renewalChannels', public.account_erasure_renewal_channels(p_profile_id),
    'subscriptionActiveUntil', (
      SELECT max(s.current_period_end) FROM public.user_subscriptions s
      WHERE s.user_id = p_profile_id
        AND lower(s.status) IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused')),
    -- A released checkout (9999) still reads status 'pending' but is final: the same test as the financial proof.
    'pendingPayments', (SELECT count(*) FROM public.payment_orders o
      WHERE o.user_id = p_profile_id AND o.status = 'pending' AND NOT public.erasure_payment_terminal(to_jsonb(o))),
    -- CORE-PATH-V2 V2-12 F: the core-path turns still open or settling are the only money in flight.
    'runsInFlight', (SELECT count(*) FROM public.turns t WHERE t.actor_id = p_profile_id AND (t.state <> 'closed' OR t.settlement = 'pending')),
    'closed', EXISTS (SELECT 1 FROM public.account_erasure_requests e WHERE e.profile_id = p_profile_id),
    -- 9999 (item 13): erasure cannot start while a refund request is being handled.
    'refundRequestOpen', public.account_erasure_refund_open(p_profile_id)
  );
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
        OR (state = 'paused' AND (updated_at < now() - interval '24 hours'
          -- 9999: an account being erased will never top up; its paused turn expires now, not after 24 hours.
          OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = turns.actor_id AND p.is_deleted = 'true'))))
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

CREATE OR REPLACE FUNCTION public.turn_recover(p_actor_id uuid, p_turn_id bigint, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; s runtime_sessions; result jsonb; ending text;
BEGIN
  IF p_action IS NULL OR p_action NOT IN ('interrupt','expire','settle') THEN
    RAISE EXCEPTION 'TURN_RECOVERY_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order as turn_close: the profile, the session, then the turn.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  -- Re-checked under the locks; turn_close is the only state change.
  IF p_action = 'interrupt' AND t.state IN ('running','stopping') AND t.updated_at < now() - interval '15 minutes' THEN
    -- A report its user was stopping closes as stopped (the 24-hour stop rule applies); anything else as interrupted: the known
    -- receipts settle, an unknown cost keeps its share of the freeze for the settlement pass.
    ending := CASE WHEN t.state = 'stopping' THEN 'stopped' ELSE 'interrupted' END;
  ELSIF p_action = 'expire' AND t.state = 'paused' AND (t.updated_at < now() - interval '24 hours'
    -- 9999: as in turn_recovery_claim, the paused turn of an account being erased expires at once.
    OR EXISTS (SELECT 1 FROM profiles p WHERE p.id = p_actor_id AND p.is_deleted = 'true')) THEN
    -- Owner 10-25/10-27: a paused turn that delivered nothing for 24 hours is refunded in full (expired, not delivered: D = 0);
    -- refund_all stays false so a jury is charged by its own rule in turn_user_charge (V2-7b).
    ending := 'expired';
  ELSIF p_action = 'settle' AND t.state = 'closed' AND t.settlement = 'pending' THEN
    -- The settlement pass of a closed turn (#1512): what became known since the last pass, counted once. The lease stays: the
    -- next lookup of what is still unknown waits for it.
    RETURN public.turn_close(p_actor_id, p_turn_id, t.close_kind) || jsonb_build_object('action', p_action);
  ELSE
    UPDATE turns SET recovery_lease_until = NULL WHERE actor_id = p_actor_id AND id = p_turn_id;
    RETURN jsonb_build_object('turnId', t.id, 'action', p_action, 'skipped', true, 'state', t.state, 'settlement', t.settlement);
  END IF;
  -- A jury closes with its review, or by the end another path is committing on it: the charge must not read that review stale.
  IF t.kind = 'jury' THEN
    result := public.turn_fusion_close(p_actor_id, p_turn_id, ending, false, false,
      CASE WHEN ending = 'expired' THEN 'recovery_expired' ELSE 'recovery_interrupted' END,
      jsonb_build_object('state', 'interrupted', 'outcome', jsonb_build_object('kind', ending)));
  ELSE
    result := public.turn_close(p_actor_id, p_turn_id, ending, '[]'::jsonb, false, false,
      CASE WHEN ending = 'expired' THEN 'recovery_expired' ELSE 'recovery_interrupted' END);
  END IF;
  -- Closed now: a cost still unknown is claimed again for the settlement pass without waiting for this lease.
  UPDATE turns SET recovery_lease_until = NULL WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN result || jsonb_build_object('action', p_action);
END $function$;

CREATE OR REPLACE FUNCTION public.account_erasure_confirm(p_profile_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  p public.profiles;
  r public.account_erasure_requests;
BEGIN
  IF p_profile_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id = p_profile_id FOR UPDATE;
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_PROFILE_MISSING' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO r FROM public.account_erasure_requests WHERE profile_id = p_profile_id;
  IF r.profile_id IS NOT NULL THEN
    RETURN jsonb_build_object('requestId', r.request_id, 'stage', r.stage,
      'confirmedAt', r.confirmed_at, 'created', false);
  END IF;
  IF p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false' THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_STATUS_DENIED' USING ERRCODE = '42501';
  END IF;
  -- An admin must be demoted first so the platform is never left without its operator by accident.
  IF p.role = 'admin' THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_ADMIN_DENIED' USING ERRCODE = '42501';
  END IF;
  IF public.account_erasure_renewing(p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_SUBSCRIPTION_RENEWING' USING ERRCODE = 'P0001';
  END IF;
  -- 9999 (Owner 2026-11-11): a refund request being handled keeps the account open; its ticket must survive.
  IF public.account_erasure_refund_open(p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_REFUND_PENDING' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.profiles SET status = 'deleted', is_deleted = 'true', deleted_at = clock_timestamp()
  WHERE id = p_profile_id;
  INSERT INTO public.account_erasure_requests(profile_id, request_id)
  VALUES (p_profile_id, p_request_id) RETURNING * INTO r;
  RETURN jsonb_build_object('requestId', r.request_id, 'stage', r.stage,
    'confirmedAt', r.confirmed_at, 'created', true);
END $function$;

COMMIT;
