-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-10b A (provisional number 0445; the controller sets the final one before it is applied): kind=plan, the first-week
-- plan of a published positioning, on the turn core. Same product as the old path (opc.prepareStep purpose=plan, BILL2 operation=plan):
-- metered, no fixed price, no membership gate; a body that is not a usable plan is still charged by usage (controller 11-01).
-- The plan's logic is in its own functions; turn_open and turn_close only dispatch to them, rebuilt whole on their text as staging
-- has it after 0442.
--   turns_kind_check   adds 'plan'
--   turn_plan_context  turn_open's per-kind context, under its locks: one model call and no tools, the conversation's draft, its
--                      round published and holding the step, the quoted module, an archived business refused (0324), the same
--                      request never on the old path and never with other input; returns what the prompt needs
--   turn_plan_apply    turn_close's kind result: the plan text, hidden from history, with the round it was made from
--   plan_turn_read     a request's plan turn with its saved text (replaces opc_plan_request_state and opc_plan_result on this path)
-- Compatibility: nothing calls kind=plan until the page switches (after #1543); other kinds and the old plan path are unchanged, and
-- old code reads the wider CHECK as before, so this can be applied before or after the code deploys.
-- Repeatable: DROP CONSTRAINT IF EXISTS then ADD, CREATE OR REPLACE throughout.
-- Recovery: stop calling kind=plan; re-apply 0442's state of turn_open and turn_close (packages/db/functions at that commit), drop
-- the three functions, and restore the CHECK after closing or deleting any kind='plan' rows (staging test data only; no production
-- database has this yet). A kept plan lives in session_messages and needs no restoring.

BEGIN;

ALTER TABLE public.turns DROP CONSTRAINT IF EXISTS turns_kind_check;
ALTER TABLE public.turns ADD CONSTRAINT turns_kind_check
  CHECK (kind IN ('chat','mentor','report','plan','compare','jury','jury_adopt','review'));

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
  -- The same request paid for on the old path while both paths exist (a page switched mid-request): never a second charge.
  -- V2-12 drops this with the old table.
  IF EXISTS (SELECT 1 FROM runtime_executions e WHERE e.actor_id = p_actor_id AND e.request_id = (plan->>'requestId')::uuid) THEN
    RAISE EXCEPTION 'TURN_PLAN_REQUEST_CONFLICT' USING ERRCODE='22023';
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

CREATE OR REPLACE FUNCTION public.turn_plan_apply(t turns, p_kind text, p_result jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE next_seq integer; round_id uuid;
BEGIN
  -- {body, roundId}: the model's text as it came (a body that is no usable plan is kept too, and read as invalid) and the round
  -- turn_open read. The round must be a published round of this conversation's draft.
  IF jsonb_typeof(p_result) <> 'object' OR jsonb_typeof(p_result->'body') <> 'string' OR jsonb_typeof(p_result->'roundId') <> 'string'
    OR (SELECT count(*) FROM jsonb_object_keys(p_result)) <> 2 THEN
    RAISE EXCEPTION 'TURN_KIND_RESULT_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT r.id INTO round_id FROM opc_drafts d JOIN artifact_rounds r ON r.project_id = d.project_id
    WHERE d.actor_id = t.actor_id AND d.session_id = t.session_id AND r.id = (p_result->>'roundId')::uuid AND r.state = 'published';
  IF round_id IS NULL THEN RAISE EXCEPTION 'TURN_KIND_RESULT_INVALID' USING ERRCODE='22023'; END IF;
  IF p_kind <> 'completed' OR t.session_id IS NULL THEN RETURN; END IF;
  SELECT coalesce(max(seq), 0) + 1 INTO next_seq FROM session_messages WHERE session_id = t.session_id;
  INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash, visible)
    VALUES (t.session_id, next_seq, 'assistant', t.id, p_result->>'body',
      encode(sha256(convert_to(p_result->>'body', 'UTF8')), 'hex'), false);
  -- turn_close's last update keeps the policy column as it is now, so this stays with the closed turn.
  UPDATE turns SET policy = policy || jsonb_build_object('planRoundId', round_id) WHERE actor_id = t.actor_id AND id = t.id;
END $function$;

CREATE OR REPLACE FUNCTION public.plan_turn_read(p_actor_id uuid, p_session_id uuid, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; tomb jsonb; body text; source_version uuid; draft uuid;
BEGIN
  SELECT d.draft_id INTO draft FROM runtime_sessions s JOIN opc_drafts d ON d.session_id = s.id AND d.actor_id = p_actor_id
    WHERE s.id = p_session_id AND s.actor_id = p_actor_id;
  IF draft IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  -- A revoked draft reads nothing, as opc_plan_request_state and opc_plan_result on the old path.
  IF NOT coalesce(bill2_scope_allowed(p_actor_id, jsonb_build_object('kind', 'positioning_draft', 'draftId', draft)), false) THEN
    RAISE EXCEPTION 'TURN_PLAN_DENIED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO t FROM turns r WHERE r.actor_id = p_actor_id AND r.request_id = p_request_id AND r.session_id = p_session_id AND r.kind = 'plan';
  IF t.id IS NULL THEN RETURN NULL; END IF;
  tomb := turn_tombstones(p_actor_id, p_session_id, '{}'::jsonb);
  IF NOT (tomb->>'sessionTombstoned')::boolean AND NOT (tomb->>'accountErasing')::boolean THEN
    SELECT m.content INTO body FROM session_messages m
     WHERE m.session_id = p_session_id AND m.turn_id = t.id AND m.role = 'assistant' AND m.deleted_at IS NULL
     ORDER BY m.seq DESC LIMIT 1;
  END IF;
  SELECT v.id INTO source_version FROM artifact_versions v WHERE v.round_id = (t.policy->>'planRoundId')::uuid;
  -- The positioning it was made from must still be a usable source (opc_plan_result's rule): no version, or a revoked one, reads nothing.
  IF t.policy ? 'planRoundId' AND (source_version IS NULL OR NOT opc_source_allowed(p_actor_id, source_version)) THEN
    RAISE EXCEPTION 'TURN_PLAN_DENIED' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object('turnId', t.id, 'state', t.state, 'closeKind', t.close_kind, 'delivered', t.delivered,
    'chargedCredits', t.charged_credits, 'settlement', t.settlement, 'body', body,
    'sourceRoundId', t.policy->>'planRoundId', 'sourceVersionId', source_version);
END $function$;

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
  IF p_kind NOT IN ('chat','mentor','report','plan','compare','jury','jury_adopt','review') THEN
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
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits','carriedCredits'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;

  -- 1. The account row first, then the session: one turn at a time per conversation (3a). The account comes first as in the
  -- erasure functions (they hold it before the session), so an open and a deletion of the same conversation never deadlock.
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
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

    -- 3. Stop-loss (2.5.1): reserve U_turn on the own bucket row first, then read the day's sum, then check with the band B.
    -- On a resume the paused turn's reservation is still counted here (it is released by its close below): refusing earlier,
    -- never later.
    IF (p_policy->'stopLoss'->>'p')::int < (p_policy->'stopLoss'->>'poolSize')::int THEN
      RAISE EXCEPTION 'TURN_STOP_LOSS_CONFIG' USING ERRCODE='22023';
    END IF;
    u_turn := (p_policy->>'uTurnUsd')::numeric;
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

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The balance is read under the
    -- account lock taken first: two sessions of one account in different stop-loss buckets never size H on the same balance.
    -- The account is checked again here (same lock) before anything is frozen.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    -- The freeze covers the carried credits too (the continuation settles them).
    IF p_kind = 'report' THEN PERFORM public.turn_report_admit(p_actor_id, p_session_id, p_policy); END IF;
    g := (p_policy->>'gCredits')::int + carried;
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
    IF p_kind NOT IN ('jury','jury_adopt') THEN UPDATE runtime_sessions SET active_turn_id = t.id WHERE id = s.id; END IF;
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
      WHEN 'plan' THEN public.turn_plan_context(p_actor_id, p_session_id, p_policy) END);
END $function$;

CREATE OR REPLACE FUNCTION public.turn_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_messages jsonb DEFAULT '[]'::jsonb, p_delivered boolean DEFAULT false, p_refund_all boolean DEFAULT false, p_failure_code text DEFAULT NULL::text, p_kind_result jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t turns; s runtime_sessions; q numeric; n_total numeric; pending_upper numeric; credits integer; charge integer; h integer;
  v_kind text := p_close_kind; tomb jsonb; next_seq integer; msg jsonb; pending boolean; user_pending boolean;
  marker timestamptz; kind_result jsonb;
BEGIN
  IF p_close_kind NOT IN ('completed','stopped','failed','interrupted','expired','erased') THEN
    RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  -- Lock order: the profile, the session, the turn, then the stop-loss bucket (as turn_open and the erasure functions). The
  -- profile also serializes the actor's closes (the free-stop count) before the settlement locks it again.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  IF t.session_id IS NOT NULL THEN SELECT * INTO s FROM runtime_sessions WHERE id = t.session_id FOR UPDATE; END IF;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.state = 'closed' THEN
    -- Closed with a provider cost still unknown: calling turn_close again settles what has become known since (recovery, a late
    -- receipt). The close itself (kind, messages) is kept; each receipt is counted once, by settled_at after the last pass
    -- (both stamped with clock_timestamp under this turn's row lock, so a receipt and a pass never miss each other).
    IF t.settlement = 'pending' THEN
      marker := clock_timestamp();
      SELECT coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
             coalesce(sum(upper_usd), 0)
        INTO n_total, pending_upper
      FROM turn_calls WHERE turn_id = p_turn_id AND NOT cost_pending AND settled_at > t.updated_at;
      UPDATE daily_spend SET spent_usd = spent_usd + n_total, reserved_usd = greatest(reserved_usd - pending_upper, 0)
        WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;
      q := (t.policy->>'q')::numeric;
      -- The user's base is what it was at the close plus the late model receipts: a tool whose result was unknown at the close
      -- stays 0 to the user (2.5.2) however late its receipt comes; only its cost goes to the stop-loss above.
      SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'
               AND NOT (call_kind = 'tool' AND settled_at > t.closed_at)), 0))::integer,
             coalesce(bool_or(cost_pending), false), coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
        INTO credits, pending, user_pending
      FROM turn_calls WHERE turn_id = p_turn_id;
      credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
      IF t.charged_credits IS NULL AND NOT user_pending THEN
        charge := CASE WHEN t.kind = 'report' THEN (public.turn_report_settlement(t, t.close_kind, t.delivered, credits,
            t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0), t.closed_at)).charge
          ELSE public.turn_user_charge(p_actor_id, p_turn_id, t.close_kind, t.delivered,
          coalesce((t.policy->>'closeRefundAll')::boolean, false), credits,
          t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0), (t.policy->>'fixedCredits')::int, t.closed_at) END;
        IF t.policy->>'holdId' IS NOT NULL THEN
          PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
        END IF;
        t.charged_credits := charge; t.absorbed_credits := greatest(credits - charge, 0);
      END IF;
      UPDATE turns SET charged_credits = t.charged_credits, absorbed_credits = t.absorbed_credits,
          settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END, updated_at = marker
        WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
    END IF;
    RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
      'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', true);
  END IF;
  -- Only a report can be stopped by its user (Owner 10-28).
  IF v_kind = 'stopped' AND t.kind <> 'report' THEN RAISE EXCEPTION 'TURN_STOP_NOT_ALLOWED' USING ERRCODE='42501'; END IF;
  IF p_refund_all AND v_kind NOT IN ('failed','expired','erased') THEN RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023'; END IF;
  -- A tombstone wins: nothing is saved and the turn closes as erased.
  IF t.kind = 'report' THEN v_kind := public.turn_report_close_kind(t, v_kind); END IF;
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  IF v_kind IN ('completed','stopped') AND ((tomb->>'sessionTombstoned')::boolean OR (tomb->>'accountErasing')::boolean
    OR (tomb->>'voiceSourceRevoked')::boolean) THEN v_kind := 'erased'; END IF;
  -- The per-kind hook: what a kind keeps from its result (a draft, a report, a verdict) is written in the same transaction as the
  -- close, by that kind's own function (e.g. turn_mentor_apply(t, v_kind, p_kind_result)), one branch per kind:
  --   IF t.kind = '<kind>' THEN PERFORM public.turn_<kind>_apply(...); ELSE ... END IF;
  -- A kind without a branch has its result refused rather than dropped.
  IF p_kind_result IS NOT NULL THEN
    IF t.kind = 'mentor' THEN
      -- V2-5c: what this turn's research made, on any close that saves anything (paid lookups stay paid when the reply failed).
      IF v_kind <> 'erased' AND p_kind_result ? 'research' THEN PERFORM public.research_turn_apply(p_actor_id, t, p_kind_result->'research'); END IF;
      -- V2-5: the organizer's checklist patches; only a delivered completed turn applies them (an erased one saves nothing).
      IF v_kind = 'completed' AND p_delivered AND p_kind_result ? 'organizerInput' THEN kind_result := public.turn_mentor_apply(p_actor_id, p_turn_id, p_kind_result); END IF;
    ELSIF t.kind = 'report' THEN
      PERFORM public.turn_report_apply(t, v_kind, p_kind_result);
    ELSIF t.kind = 'plan' THEN
      PERFORM public.turn_plan_apply(t, v_kind, p_kind_result);
    ELSE
      RAISE EXCEPTION 'TURN_KIND_RESULT_UNSUPPORTED' USING ERRCODE='22023';
    END IF;
  END IF;

  -- Calls without a final receipt: their cost is unknown; it is never presumed zero and never retried (2.5.2).
  UPDATE turn_calls SET status = 'unknown', cost_pending = true
   WHERE turn_id = p_turn_id AND status IN ('dispatched','identified');
  q := (t.policy->>'q')::numeric;
  -- N = ceil(q x sum(n_i x m_i)) over the known receipts the user pays for (never the positioning check); n_total is the provider
  -- cost of every receipt, the positioning check and the platform-paid unusable results included, which the stop-loss counts; a
  -- tool receipt counts its whole known supplier cost (turn_call_spent_usd), the subcalls the user does not pay for included.
  SELECT ceil(q * coalesce(sum(nominal_usd * multiplier) FILTER (WHERE status = 'ok' AND call_kind <> 'decision'), 0))::integer,
         coalesce(sum(turn_call_spent_usd(call_kind, nominal_usd, actual_usd)) FILTER (WHERE status = 'ok'), 0) + coalesce(sum(actual_usd) FILTER (WHERE status = 'unusable'), 0),
         coalesce(sum(upper_usd) FILTER (WHERE cost_pending), 0),
         coalesce(bool_or(cost_pending), false),
         -- Only an unknown model call holds the user's settlement: a third-party tool whose result is unknown is 0 to the user
         -- (Owner 10-13, plan 2.5.2) and the positioning check is never theirs; both keep only the provider cost pending.
         coalesce(bool_or(cost_pending AND call_kind = 'model'), false)
    INTO credits, n_total, pending_upper, pending, user_pending
  FROM turn_calls WHERE turn_id = p_turn_id;
  -- Credits a resumed turn carried from the turn it continues (V2-8): settled here, once, under this turn's rule.
  credits := credits + coalesce((t.policy->>'carriedCredits')::int, 0);
  -- H: the whole hold, the carried credits included (reserved_credits leaves them out for the calls' own checks).
  h := t.reserved_credits + coalesce((t.policy->>'carriedCredits')::int, 0);

  -- Stop-loss: what is known is spent; the reservation of calls with an unknown cost stays until recovery settles them.
  UPDATE daily_spend SET spent_usd = spent_usd + n_total,
      reserved_usd = greatest(reserved_usd - (t.reserved_usd - pending_upper), 0)
    WHERE day = (t.policy->>'day')::date AND bucket = (t.policy->>'bucket')::smallint;

  -- What the user pays (turn_user_charge: D = min(N, H), the stop and fixed-price rules).
  -- One instant for this close, taken under the account lock: the stop count, closed_at and the settlement pass all use it, so a
  -- concurrent close of the same actor that committed first is always before it, and a later settlement counts the same.
  marker := clock_timestamp();
  IF t.kind = 'report' THEN
    SELECT r.charge, user_pending AND NOT r.settle_now INTO charge, user_pending FROM public.turn_report_settlement(t, v_kind, p_delivered, credits, h, marker) r;
  ELSE
    charge := public.turn_user_charge(p_actor_id, p_turn_id, v_kind, p_delivered, p_refund_all, credits, h,
      (t.policy->>'fixedCredits')::int, marker);
  END IF;

  -- Credits: settled once; with an unknown model cost the whole freeze waits for recovery (one freeze is settled exactly once).
  -- settlement stays 'pending' while any provider cost is unknown, so recovery still settles the stop-loss; a repeated credit
  -- settlement of the same freeze returns the first one.
  IF NOT user_pending AND t.policy->>'holdId' IS NOT NULL THEN
    PERFORM public.turn_settle_credits(p_actor_id, (t.policy->>'holdId')::uuid, charge, p_turn_id);
  END IF;

  -- What a paused turn kept for its resume ends with it (the 24-hour expiry closes here).
  IF t.state = 'paused' THEN DELETE FROM session_messages WHERE session_id = t.session_id AND turn_id = p_turn_id AND NOT visible; END IF;

  -- The messages of a delivered turn, appended in order.
  IF v_kind IN ('completed','stopped') AND t.session_id IS NOT NULL AND jsonb_typeof(p_messages) = 'array' THEN
    SELECT coalesce(max(seq), 0) INTO next_seq FROM session_messages WHERE session_id = t.session_id;
    FOR msg IN SELECT value FROM jsonb_array_elements(p_messages) LOOP
      next_seq := next_seq + 1;
      INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash)
        VALUES (t.session_id, next_seq, msg->>'role', p_turn_id, msg->>'content', encode(sha256(convert_to(msg->>'content', 'UTF8')), 'hex'));
    END LOOP;
  END IF;

  -- updated_at marks this settlement pass (see the closed branch above); a full refund still owed is kept with the turn.
  UPDATE turns SET state = 'closed', pause_reason = NULL, close_kind = v_kind, closed_at = marker, updated_at = marker,
      policy = CASE WHEN user_pending AND p_refund_all THEN policy || '{"closeRefundAll": true}'::jsonb ELSE policy END,
      charged_credits = CASE WHEN user_pending THEN NULL ELSE charge END,
      absorbed_credits = CASE WHEN user_pending THEN NULL ELSE greatest(credits - charge, 0) END,
      settlement = CASE WHEN pending THEN 'pending' ELSE 'done' END,
      stopped_by_user = (v_kind = 'stopped'), delivered = p_delivered AND v_kind IN ('completed','stopped'),
      failure_code = p_failure_code
    WHERE actor_id = p_actor_id AND id = p_turn_id RETURNING * INTO t;
  IF s.id IS NOT NULL AND s.active_turn_id = p_turn_id THEN UPDATE runtime_sessions SET active_turn_id = NULL WHERE id = s.id; END IF;
  RETURN jsonb_build_object('turnId', t.id, 'closeKind', t.close_kind, 'chargedCredits', t.charged_credits,
    'absorbedCredits', t.absorbed_credits, 'settlement', t.settlement, 'replay', false, 'kindResult', kind_result) || tomb;
END $function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['turn_plan_context(uuid,uuid,jsonb)','turn_plan_apply(turns,text,jsonb)','plan_turn_read(uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
  END LOOP;
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.plan_turn_read(uuid,uuid,uuid) TO service_role';
END $$;

COMMIT;
