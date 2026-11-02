-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-12 batch R5: the turn functions and the workspace read stop looking at the old path's tables.
-- Each removed branch refused or counted something that exists only while a request id can also have run on the old path
-- (runtime_executions, report_fees); no turn-path request has such a row, so every removed condition is false for turn-path data.
-- Staging holds test rows of the old path only; production was built on the new path (V2-12 plan, 0458's header).
--   turn_open, turn_plan_context, topic_turn_source: "the same request id was admitted on the old path" refusals (V2-12 drops this).
--   turn_report_admit: the old path's report that blocks a new paid start; turn_stop: the old path's free stops in the 24-hour count.
--   workspace_turn_read: benchmark rows are read through their turn only (a row of an old execution is no longer shown).
-- Compatible: results and signatures are unchanged for turn-path data. Repeatable: whole-function CREATE OR REPLACE.
-- Recovery: re-apply the previous text of the functions from git history; nothing is written or removed.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.turn_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text, p_policy jsonb, p_resume_of bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  s runtime_sessions; t turns; prof profiles; existing turns;
  v_day date := (now() AT TIME ZONE 'UTC')::date; v_bucket smallint; total numeric; band numeric;
  u_turn numeric; g integer; h integer; available integer; hold uuid; frozen jsonb; history jsonb;
  carried integer := 0;
BEGIN
  IF p_kind NOT IN ('chat','mentor','report','plan','compare','jury','jury_adopt','review','voice') THEN
    RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(p_policy) <> 'object'
    OR jsonb_typeof(p_policy->'q') <> 'number' OR (p_policy->>'q')::numeric <= 0
    OR jsonb_typeof(p_policy->'uTurnUsd') <> 'number' OR (p_policy->>'uTurnUsd')::numeric < 0
    OR jsonb_typeof(p_policy->'gCredits') <> 'number' OR (p_policy->>'gCredits')::numeric <> floor((p_policy->>'gCredits')::numeric)
    OR (p_policy->>'gCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'minCredits') <> 'number' OR (p_policy->>'minCredits')::numeric < 0
    OR jsonb_typeof(p_policy->'historyItems') <> 'number' OR (p_policy->>'historyItems')::numeric NOT BETWEEN 0 AND 200
    OR jsonb_typeof(p_policy->'limits') <> 'object'
    OR coalesce((p_policy->'limits'->>'model')::numeric, 0) < 1
    OR coalesce((p_policy->'limits'->>'paidTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'freeTools')::numeric, -1) < 0
    OR coalesce((p_policy->'limits'->>'decisions')::numeric, 0) < 0
    OR jsonb_typeof(p_policy->'stopLoss') <> 'object'
    OR coalesce((p_policy->'stopLoss'->>'limitUsd')::numeric, 0) <= 0
    OR coalesce((p_policy->'stopLoss'->>'p')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'poolSize')::numeric, 0) < 1
    OR coalesce((p_policy->'stopLoss'->>'uFastUsd')::numeric, -1) < 0
    OR coalesce((p_policy->'stopLoss'->>'uBigUsd')::numeric, -1) < 0
    -- holdCredits: only a chat or mentor turn freezes less than G and tops up (turn_call_begin); a fixed-price kind keeps H = G.
    OR (p_policy ? 'holdCredits' AND (p_kind NOT IN ('chat','mentor') OR jsonb_typeof(p_policy->'holdCredits') <> 'number'
      OR (p_policy->>'holdCredits')::numeric <> floor((p_policy->>'holdCredits')::numeric)
      OR (p_policy->>'holdCredits')::numeric < 1 OR (p_policy->>'holdCredits')::numeric > (p_policy->>'gCredits')::numeric))
    -- holdUsd: the same for the stop-loss; only with holdCredits, never above U_turn.
    OR (p_policy ? 'holdUsd' AND (NOT p_policy ? 'holdCredits' OR jsonb_typeof(p_policy->'holdUsd') <> 'number'
      OR (p_policy->>'holdUsd')::numeric < 0 OR (p_policy->>'holdUsd')::numeric > (p_policy->>'uTurnUsd')::numeric))
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits','carriedCredits','topUps'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;

  -- 1. The account row first, then the session: one turn at a time per conversation (3a). The account comes first as in the
  -- erasure functions (they hold it before the session), so an open and a deletion of the same conversation never deadlock.
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
  -- A voice generation (V2-12 B7) belongs to the account, not to a conversation: it has no session, and one is refused.
  IF p_kind = 'voice' THEN
    IF p_session_id IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  ELSE
    SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
    IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  END IF;
  -- 2. The same request again: the turn it opened, unchanged.
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.session_id IS DISTINCT FROM p_session_id OR existing.kind <> p_kind
      OR existing.resume_of IS DISTINCT FROM p_resume_of THEN
      RAISE EXCEPTION 'TURN_REQUEST_CONFLICT' USING ERRCODE='22023';
    END IF;
    -- A replay reads the history too: a deleted conversation or an erasing account is refused here as for a new request,
    -- so the same old request can never read back deleted content (as runtime_session_context).
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    t := existing;
  ELSE
    IF s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'TURN_SESSION_ERASED' USING ERRCODE='42501'; END IF;
    IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    IF p_resume_of IS NULL THEN
      -- A jury (or its adoption) runs on the report's draft conversation without occupying it (V2-7b): the conversation stays
      -- usable while a review advances or waits, as before; one review per user is the review record's own rule.
      IF s.active_turn_id IS NOT NULL AND p_kind NOT IN ('jury','jury_adopt') THEN RAISE EXCEPTION 'TURN_SESSION_BUSY' USING ERRCODE='55P03'; END IF;
      -- V2-5c: the mentor's read before this turn is bound to it: a turn that closed since then makes that read stale (it could pay
      -- again for what that turn fetched, or use a grant it spent). Under this session's lock, so no close can slip in after it.
      IF p_kind = 'mentor' AND p_policy->'mentor'->>'preparedAt' IS NOT NULL AND EXISTS (SELECT 1 FROM turns x
          WHERE x.actor_id = p_actor_id AND x.session_id = p_session_id AND x.closed_at > (p_policy->'mentor'->>'preparedAt')::timestamptz) THEN
        RAISE EXCEPTION 'TURN_PREPARE_STALE' USING ERRCODE='55P03';
      END IF;
    ELSE
      -- Resume (V2-8): the paused turn is checked, locked and priced by turn_resume_carry.
      carried := public.turn_resume_carry(p_actor_id, p_session_id, s.active_turn_id, p_resume_of, p_kind, p_policy);
    END IF;
    -- The same account check as bill2_actor: active and not deleted.
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
    END IF;

    -- 3. Stop-loss (2.5.1): reserve the first reservation (U_turn, or one call's holdUsd where the turn tops up, Owner 11-01) on the
    -- own bucket row first, then read the day's sum, then check with the band B.
    -- On a resume the paused turn's reservation is still counted here (it is released by its close below): refusing earlier,
    -- never later.
    -- The band's proof needs U_fast to bound what one transaction adds, so a holdUsd above it is a configuration fault.
    IF (p_policy->'stopLoss'->>'p')::int < (p_policy->'stopLoss'->>'poolSize')::int
      OR coalesce((p_policy->>'holdUsd')::numeric, 0) > (p_policy->'stopLoss'->>'uFastUsd')::numeric THEN
      RAISE EXCEPTION 'TURN_STOP_LOSS_CONFIG' USING ERRCODE='22023';
    END IF;
    u_turn := coalesce((p_policy->>'holdUsd')::numeric, (p_policy->>'uTurnUsd')::numeric);
    v_bucket := CASE WHEN p_kind IN ('report','compare','jury','jury_adopt') THEN -1 ELSE abs(hashtext(p_actor_id::text)) % 16 END;
    INSERT INTO daily_spend AS d (day, bucket, reserved_usd) VALUES (v_day, v_bucket, u_turn)
      ON CONFLICT (day, bucket) DO UPDATE SET reserved_usd = d.reserved_usd + excluded.reserved_usd;
    SELECT sum(reserved_usd + spent_usd) INTO total FROM daily_spend WHERE daily_spend.day = v_day;
    band := ((p_policy->'stopLoss'->>'p')::numeric - 1) * (p_policy->'stopLoss'->>'uFastUsd')::numeric
      + (p_policy->'stopLoss'->>'uBigUsd')::numeric;
    IF total + band > (p_policy->'stopLoss'->>'limitUsd')::numeric THEN
      RAISE EXCEPTION 'STOP_LOSS_REACHED' USING ERRCODE='P0001';
    END IF;

    -- The paused turn closes before the new freeze is sized: its whole freeze comes back (refund_all; what it would have charged
    -- is carried above) and counts in the balance read below. Its receipts stay its own for the stop-loss. Not delivered, no
    -- messages: the turn that continues it saves the conversation.
    IF p_resume_of IS NOT NULL THEN
      PERFORM public.turn_resume_close(p_actor_id, p_resume_of, carried);
    END IF;

    -- 4. Credits: H = min(the first freeze, available), the first freeze being G_turn, or one call's bound where the turn tops up
    -- (Owner 11-01: "选 A 补冻"); below the start threshold the turn does not open. The balance is read under the
    -- account lock taken first: two sessions of one account in different stop-loss buckets never size H on the same balance.
    -- The account is checked again here (same lock) before anything is frozen.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    -- The freeze covers the carried credits too (the continuation settles them).
    IF p_kind = 'report' THEN PERFORM public.turn_report_admit(p_actor_id, p_session_id, p_policy); END IF;
    g := coalesce((p_policy->>'holdCredits')::int, (p_policy->>'gCredits')::int) + carried;
    available := greatest(public.credit_available(p_actor_id), 0);
    -- The balance, not the freeze, is held against the start threshold L (as bill2_payg_claim): a balance that covers one
    -- normal turn starts it, and the freeze H may be below L when one call's bound G is (Owner 10-28, restating 10-01).
    -- On a resume the carried credits are owed already: the balance left after them must still cover one normal turn.
    IF available - carried < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    h := least(g, available);
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h)
      || CASE WHEN carried > 0 THEN jsonb_build_object('carriedCredits', carried) ELSE '{}'::jsonb END;
    INSERT INTO turns (actor_id, session_id, request_id, kind, state, resume_of, policy, reserved_credits, reserved_usd, input_bytes)
      -- reserved_credits is the freeze this turn's calls may use (turn_call_begin pauses on it); the carried part is added back
      -- at the close (turn_close), and the hold itself is the whole H (policy.heldCredits).
      VALUES (p_actor_id, p_session_id, p_request_id, p_kind, 'running', p_resume_of, frozen, h - carried, u_turn,
        (p_policy->>'inputBytes')::int)
      RETURNING * INTO t;
    IF p_kind NOT IN ('jury','jury_adopt','voice') THEN UPDATE runtime_sessions SET active_turn_id = t.id WHERE id = s.id; END IF;
  END IF;

  -- 5. The visible history, newest N in order.
  SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'content', m.content, 'contentHash', m.content_hash)
    ORDER BY m.seq), '[]'::jsonb) INTO history
  FROM (SELECT seq, role, content, content_hash FROM session_messages
        WHERE session_id = p_session_id AND visible AND deleted_at IS NULL
        ORDER BY seq DESC LIMIT (t.policy->>'historyItems')::int) m;
  -- 6. What the turn's prompt needs from the account, read here instead of in more round trips: the reply language and, for a
  -- free chat, the positioning gate (confirmed positioning; refusals in 24 hours, counted on the turns refused for it).
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'replay', existing.id IS NOT NULL,
    'reservedCredits', t.reserved_credits, 'reservedUsd', t.reserved_usd, 'history', history, 'resumeOf', t.resume_of,
    'replyLanguage', prof.reply_language,
    'positioning', CASE WHEN p_kind = 'chat' THEN jsonb_build_object(
      'positioned', public.turn_positioned(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', CASE p_kind WHEN 'mentor' THEN public.turn_mentor_context(p_actor_id, p_session_id, p_policy->'mentor')
      WHEN 'plan' THEN public.turn_plan_context(p_actor_id, p_session_id, p_policy)
      WHEN 'voice' THEN public.turn_voice_context(p_actor_id, p_policy) END);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_plan_context(p_actor_id uuid, p_session_id uuid, p_policy jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE plan jsonb := p_policy->'plan'; d opc_drafts; p artifact_projects; r artifact_rounds; b opc_businesses; spec jsonb;
  v_step text; step_id text; st jsonb; steps jsonb := '{}';
BEGIN
  -- One model call, no tools, no fixed price: the old path's plan turn (maxCalls 1, BILL2 operation=plan).
  IF jsonb_typeof(plan) IS DISTINCT FROM 'object' OR jsonb_typeof(plan->'moduleId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(plan->'stepId') IS DISTINCT FROM 'string' OR jsonb_typeof(plan->'inputHash') IS DISTINCT FROM 'string'
    OR jsonb_typeof(plan->'requestId') IS DISTINCT FROM 'string'
    OR (p_policy->'limits'->>'model')::int <> 1 OR (p_policy->'limits'->>'paidTools')::int <> 0
    OR (p_policy->'limits'->>'freeTools')::int <> 0 OR coalesce((p_policy->'limits'->>'decisions')::int, 0) <> 0
    OR p_policy ? 'fixedCredits' THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  v_step := plan->>'stepId';
  SELECT * INTO d FROM opc_drafts WHERE actor_id = p_actor_id AND session_id = p_session_id;
  IF d.draft_id IS NULL OR NOT turn_mentor_draft_allowed(p_actor_id, d.draft_id) THEN
    RAISE EXCEPTION 'TURN_PLAN_DENIED' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM bill2_drafts WHERE actor_id = p_actor_id AND revoked
      AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(coalesce(plan->'sourceDrafts', '[]')))) THEN
    RAISE EXCEPTION 'TURN_PLAN_DENIED' USING ERRCODE='42501';
  END IF;
  -- An archived business is read-only (0324, as opc_step_material on the old path).
  SELECT x.* INTO b FROM opc_draft_businesses db JOIN opc_businesses x ON x.id = db.business_id AND x.actor_id = p_actor_id
   WHERE db.draft_id = d.draft_id;
  IF b.archived_at IS NOT NULL THEN RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED' USING ERRCODE='42501'; END IF;
  -- Node reads mentor_source_check before every plan turn (the whole source chain, without this transaction's locks).
  IF plan->'sourceChecked' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'TURN_SOURCE_CHECK_REQUIRED' USING ERRCODE='42501'; END IF;
  SELECT * INTO p FROM artifact_projects WHERE id = d.project_id AND actor_id = p_actor_id;
  SELECT * INTO r FROM artifact_rounds WHERE id = d.round_id AND project_id = p.id;
  IF p.id IS NULL OR r.id IS NULL OR p.erased_at IS NOT NULL OR p.content_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'TURN_PLAN_DENIED' USING ERRCODE='42501';
  END IF;
  -- The turn was quoted for this module's model: any other module is refused.
  IF p.module_id::text IS DISTINCT FROM plan->>'moduleId' THEN RAISE EXCEPTION 'TURN_PLAN_DENIED' USING ERRCODE='42501'; END IF;
  -- A plan is made from the published positioning only (as opc_step_material).
  SELECT x INTO spec FROM jsonb_array_elements(r.workflow->'steps') x WHERE x->>'id' = v_step;
  IF r.state <> 'published' OR spec IS NULL OR NOT (r.steps ? v_step) THEN
    RAISE EXCEPTION 'TURN_PLAN_STEP_DENIED' USING ERRCODE='42501';
  END IF;
  -- turn_open checks a repeated request's session and kind; what it asks for is checked here (as the old input hash).
  IF EXISTS (SELECT 1 FROM turns x WHERE x.actor_id = p_actor_id AND x.request_id = (plan->>'requestId')::uuid
      AND (x.kind <> 'plan' OR x.policy#>>'{plan,inputHash}' IS DISTINCT FROM plan->>'inputHash'
        OR x.policy#>>'{plan,stepId}' IS DISTINCT FROM v_step)) THEN
    RAISE EXCEPTION 'TURN_PLAN_REQUEST_CONFLICT' USING ERRCODE='22023';
  END IF;
  -- The work the model reads: the steps without their per-field bookkeeping, which only the mentor's writes use.
  FOR step_id, st IN SELECT key, value FROM jsonb_each(r.steps) LOOP
    steps := steps || jsonb_build_object(step_id, st - 'fieldMeta');
  END LOOP;
  RETURN jsonb_build_object('draftId', d.draft_id, 'projectId', p.id, 'roundId', r.id, 'moduleId', p.module_id, 'skillId', p.skill_id,
    'revisionId', r.revision_id, 'packageHash', r.package_hash,
    'resources', coalesce(r.workflow->'planResources', spec->'resources'),
    'work', jsonb_build_object('projectId', p.id, 'roundId', r.id, 'revisionId', r.revision_id, 'packageHash', r.package_hash,
      'steps', steps, 'source', NULL));
END $function$;

CREATE OR REPLACE FUNCTION public.turn_report_admit(p_actor_id uuid, p_session_id uuid, p_policy jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rep jsonb := p_policy->'report'; fixed integer; lvl text; draft uuid;
BEGIN
  -- The stop's frozen fields are written by turn_stop only.
  IF rep IS NULL OR jsonb_typeof(rep) <> 'object' OR p_policy ?| ARRAY['stoppedAt','stopChargeable','stopAt']
    OR rep->>'projectId' !~ '^[0-9a-f-]{36}$' OR rep->>'roundId' !~ '^[0-9a-f-]{36}$' OR rep->>'moduleId' !~ '^[0-9a-f-]{36}$' THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  IF (SELECT value::jsonb FROM system_settings WHERE key = 'runtime_report_generation') IS DISTINCT FROM '{"enabled":true}'::jsonb THEN
    RAISE EXCEPTION 'REPORT_DISABLED' USING ERRCODE='P0001';
  END IF;
  -- The price the button showed (acceptedCredits, checked by Node against fixedCredits) must be today's price.
  fixed := public.report_fixed_price();
  IF jsonb_typeof(p_policy->'fixedCredits') <> 'number' OR (p_policy->>'fixedCredits')::numeric <> fixed THEN
    RAISE EXCEPTION 'REPORT_PRICE_CHANGED' USING ERRCODE='P0001';
  END IF;
  -- One model call, no tools, no history; the whole price and the call's bound are frozen or nothing opens (0295 REPORT_CREDITS).
  IF (p_policy->'limits'->>'model')::int <> 1 OR (p_policy->'limits'->>'paidTools')::int <> 0
    OR (p_policy->'limits'->>'freeTools')::int <> 0 OR coalesce((p_policy->'limits'->>'decisions')::int, 0) <> 0
    OR (p_policy->>'historyItems')::int <> 0 OR (p_policy->>'gCredits')::int < fixed
    OR (p_policy->>'minCredits')::int <> (p_policy->>'gCredits')::int THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  -- Membership (Pro or Gold), from the account row turn_open holds: the same cached level as the jury's Gold gate (V2-7b).
  SELECT membership_level INTO lvl FROM profiles WHERE id = p_actor_id;
  IF lvl IS DISTINCT FROM 'pro' AND lvl IS DISTINCT FROM 'gold' THEN RAISE EXCEPTION 'REPORT_MEMBERSHIP_REQUIRED' USING ERRCODE='42501'; END IF;
  -- The round is this conversation's draft and of the module Node quoted (the model, so the call's bound, is the module's).
  -- Its confirmed facts and benchmarks were read by Node just before (report_source, research_benchmark_rows) and are not read
  -- again here (controller 10-30, B1): turn_open re-checks only what its locks must hold.
  SELECT d.draft_id INTO draft FROM opc_drafts d JOIN artifact_projects p ON p.id = d.project_id AND p.actor_id = p_actor_id
    WHERE d.actor_id = p_actor_id AND d.session_id = p_session_id AND d.project_id = (rep->>'projectId')::uuid
      AND d.round_id = (rep->>'roundId')::uuid AND p.module_id = (rep->>'moduleId')::uuid AND p.erased_at IS NULL;
  IF draft IS NULL THEN RAISE EXCEPTION 'REPORT_SOURCE_CONFLICT' USING ERRCODE='P0001'; END IF;
  -- An archived business is read-only (0324, as opc_assert_business_writable on the old path): no new paid report for its draft.
  IF EXISTS (SELECT 1 FROM opc_draft_businesses db JOIN opc_businesses b ON b.id = db.business_id AND b.actor_id = p_actor_id
      WHERE db.draft_id = draft AND b.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'OPC_BUSINESS_ARCHIVED' USING ERRCODE='42501';
  END IF;
  -- One paid report per round: one still going, or a complete one delivered, blocks a new start (a stopped, failed or cut-off
  -- one does not: a new start pays again, Owner 10-17).
  IF EXISTS (SELECT 1 FROM turns r WHERE r.session_id = p_session_id AND r.actor_id = p_actor_id AND r.kind = 'report'
      AND r.policy#>>'{report,roundId}' = rep->>'roundId'
      AND (r.state <> 'closed' OR (r.close_kind = 'completed' AND r.delivered))) THEN
    RAISE EXCEPTION 'REPORT_ALREADY_EXISTS' USING ERRCODE='P0001';
  END IF;
END $function$;

CREATE OR REPLACE FUNCTION public.turn_stop(p_actor_id uuid, p_turn_id bigint, p_confirmed boolean, p_stop_at integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; n integer;
BEGIN
  IF p_stop_at IS NOT NULL AND p_stop_at < 0 THEN RAISE EXCEPTION 'TURN_STOP_INVALID' USING ERRCODE='22023'; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  IF t.kind <> 'report' THEN RAISE EXCEPTION 'TURN_STOP_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  -- Lock order as turn_open, turn_close and the erasure functions: the account, the session, the turn. The account row also
  -- serializes this account's stops, so two stops at once never both count as free.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN PERFORM 1 FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  -- Pressed again, or the report ended first: what happened, unchanged.
  IF t.state IN ('stopping','closed') THEN
    RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
      'chargeable', coalesce((t.policy->>'stopChargeable')::boolean, false), 'replay', true);
  END IF;
  IF t.state <> 'running' THEN RAISE EXCEPTION 'TURN_NOT_RUNNING' USING ERRCODE='55000'; END IF;
  SELECT count(*) INTO n FROM turns r WHERE r.actor_id = p_actor_id AND r.kind = 'report' AND r.stopped_by_user AND r.id <> p_turn_id
    AND coalesce(r.closed_at, (r.policy->>'stoppedAt')::timestamptz) > now() - interval '24 hours';
  IF n >= 2 AND NOT coalesce(p_confirmed, false) THEN
    RETURN jsonb_build_object('turnId', t.id, 'state', 'confirmation_required', 'chargeable', true,
      'fixedCredits', (t.policy->>'fixedCredits')::int, 'replay', false);
  END IF;
  UPDATE turns SET state = 'stopping', stopped_by_user = true, updated_at = now(),
      policy = policy || jsonb_build_object('stoppedAt', now(), 'stopChargeable', n >= 2)
        || CASE WHEN p_stop_at IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('stopAt', p_stop_at) END
    WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN jsonb_build_object('turnId', t.id, 'state', 'stopping', 'closeKind', NULL, 'chargedCredits', NULL,
    'chargeable', n >= 2, 'replay', false);
END $function$;

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
   WHERE db.business_id = b.id AND rb.turn_id IS NOT NULL
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
      AND rb.turn_id IS NOT NULL
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

COMMIT;
