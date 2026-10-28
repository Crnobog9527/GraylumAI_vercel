-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-7b (number to be assigned by the controller): compare, jury and jury adoption on the per-turn core
-- (docs/launch/tasks/CORE-PATH-V2.md sections 2.2, 2.5.3, 2.7, 4.4; Owner rules 10-13, 10-17, 10-20, 10-27).
--   turn_fusion_open     Gold gate, the kind's rules (compare: >= 2 models, bounds <= 500 credits, one at a time; jury: the
--                        3-unfinished version rule, the fixed price in the freeze; jury_adopt: once per adopted review, no fee),
--                        the product record (fusion_compares row / fusion_reviews.turn_id), then turn_open: one round trip
--   turn_fusion_begin    turn_call_begin; a jury waiting between groups runs again
--   turn_fusion_record   turn_call_record plus the saved answer (fusion_turn_outputs); a jury with nothing left in flight waits
--                        between groups (paused, awaiting_user)
--   turn_fusion_close    turn_close with the review's end state or the compare's finished state in the same transaction
--   fusion_review_turn_step   the review record's claim/advance for a jury on the turn path
--   fusion_compare_turn_adopt the chosen compare answer into the conversation history
--   turn_fusion_recovery the fusion-recovery cron's step on turns: 24-hour end, deleted review refund, product sync
-- Changed (whole CREATE OR REPLACE from packages/db/functions):
--   turn_open            a jury (or adoption) does not occupy its draft conversation (active_turn_id), as before V2
--   turn_call_begin      a jury's freeze check counts the fixed price plus the calls in flight (the group's temporary bound)
--   turn_user_charge     jury: deliverable revision -> fixed price; interrupted / 24-hour end -> min(fixed, known usage);
--                        otherwise 0. compare: each column rounded on its own
--   fusion_review_view, fusion_call_output_read: a review on the turn path reads its calls and answers from the turn
-- Compatibility: new columns are nullable, the new table and functions are used only by the V2 path (core_path_v2.enabled);
-- old reviews and compares keep turn_id NULL and every old branch unchanged; the changed turn_* branches apply to jury and compare
-- turns only, which nothing opens before this migration. Repeatable: IF NOT EXISTS / CREATE OR REPLACE throughout.
-- Recovery: drop the seven new functions and fusion_turn_outputs, drop the two turn_id columns, and restore the five changed
-- functions from the previous migration's files (0421 for turn_*, the generated files for the two fusion functions).
BEGIN;
SET LOCAL lock_timeout='5s';

-- The product records point at their turn; the reviews and compares of the old path keep turn_id NULL and their old functions.
ALTER TABLE public.fusion_reviews ADD COLUMN IF NOT EXISTS turn_id bigint;
ALTER TABLE public.fusion_compares ADD COLUMN IF NOT EXISTS turn_id bigint;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fusion_reviews_turn_ref') THEN
    ALTER TABLE public.fusion_reviews ADD CONSTRAINT fusion_reviews_turn_ref FOREIGN KEY (actor_id, turn_id) REFERENCES public.turns(actor_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fusion_compares_turn_ref') THEN
    ALTER TABLE public.fusion_compares ADD CONSTRAINT fusion_compares_turn_ref FOREIGN KEY (actor_id, turn_id) REFERENCES public.turns(actor_id, id);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS fusion_reviews_turn_idx ON public.fusion_reviews(turn_id) WHERE turn_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS fusion_compares_turn_idx ON public.fusion_compares(turn_id) WHERE turn_id IS NOT NULL;

-- The saved answer of one review seat, summary or compare column, written in the same statement as its receipt
-- (turn_fusion_record). Content, not billing: it goes with its review (draft deletion, account erasure) or its compare
-- (conversation deletion, account erasure) through the cascade, exactly as the review and compare rows already do. call_id is
-- the stable id the existing review read model and output reader use for a call (fusion_review_view, fusion_call_output_read).
-- Constraint names avoid the generic *_fkey suffix, which the secret scan reads as a key in the fingerprint.
CREATE TABLE IF NOT EXISTS public.fusion_turn_outputs (
  actor_id uuid NOT NULL,
  turn_id bigint NOT NULL,
  seq integer NOT NULL,
  call_id uuid GENERATED ALWAYS AS (md5(turn_id::text || ':' || seq::text)::uuid) STORED,
  review_id uuid CONSTRAINT fusion_turn_outputs_review_ref REFERENCES public.fusion_reviews(id) ON DELETE CASCADE,
  compare_id uuid CONSTRAINT fusion_turn_outputs_compare_ref REFERENCES public.fusion_compares(id) ON DELETE CASCADE,
  phase text NOT NULL CHECK (phase IN ('fusion_review','fusion_summary','fusion_compare')),
  body text NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 262144),
  body_hash text NOT NULL CHECK (body_hash ~ '^[a-f0-9]{64}$'),
  verdict text NOT NULL CHECK (verdict IN ('usable','format_invalid','revision_invalid')),
  saved_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fusion_turn_outputs_pk PRIMARY KEY (turn_id, seq),
  CONSTRAINT fusion_turn_outputs_call_ref FOREIGN KEY (turn_id, seq) REFERENCES public.turn_calls(turn_id, seq),
  CHECK ((review_id IS NULL) <> (compare_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS fusion_turn_outputs_call_idx ON public.fusion_turn_outputs(call_id);
CREATE INDEX IF NOT EXISTS fusion_turn_outputs_review_idx ON public.fusion_turn_outputs(review_id) WHERE review_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fusion_turn_outputs_compare_idx ON public.fusion_turn_outputs(compare_id) WHERE compare_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fusion_turn_outputs_actor_idx ON public.fusion_turn_outputs(actor_id);
ALTER TABLE public.fusion_turn_outputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fusion_turn_outputs FROM PUBLIC, anon, authenticated, service_role;

-- Open a compare, jury or jury adoption turn: the Gold gate and the kind's own rules, the product record, then turn_open in the
-- same transaction (one round trip). A repeated request answers like turn_open, without the live gates (its freeze exists).
-- Lock order as everywhere on this path: product row (NO KEY UPDATE, so a receipt's output insert never waits on it), then
-- turn_open's session -> stop-loss bucket -> profile.
CREATE OR REPLACE FUNCTION public.turn_fusion_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text,
  p_policy jsonb, p_product jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rv fusion_reviews; cmp fusion_compares; existing turns; opened jsonb; pol jsonb; lvl text; product jsonb;
BEGIN
  IF p_kind NOT IN ('compare','jury','jury_adopt') OR jsonb_typeof(p_product) <> 'object' OR jsonb_typeof(p_policy) <> 'object'
    OR p_policy ?| ARRAY['reviewId','versionId','compareId'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  -- The row the kind serializes on first (a compare's conversation, a jury's review), then the request: two concurrent opens of
  -- one request make one turn, the second answering as a replay.
  IF p_kind = 'compare' THEN
    PERFORM 1 FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  ELSE
    PERFORM 1 FROM fusion_reviews WHERE id = (p_product->>'reviewId')::uuid AND actor_id = p_actor_id FOR NO KEY UPDATE;
  END IF;
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.kind <> p_kind THEN RAISE EXCEPTION 'TURN_REQUEST_CONFLICT' USING ERRCODE='22023'; END IF;
    opened := turn_open(p_actor_id, p_session_id, p_request_id, p_kind, p_policy, NULL);
    RETURN opened || jsonb_build_object('reviewId', existing.policy->'reviewId', 'compareId', existing.policy->'compareId');
  END IF;

  -- Review and compare are Gold only (record D, 10-20): the cached membership level and the plan's own switch.
  SELECT membership_level INTO lvl FROM profiles WHERE id = p_actor_id;
  IF lvl IS DISTINCT FROM 'gold' OR NOT EXISTS (SELECT 1 FROM membership_plans mp WHERE mp.level = lvl
      AND CASE WHEN p_kind = 'compare' THEN mp.allow_fusion_compare ELSE mp.allow_fusion_review END) THEN
    RAISE EXCEPTION 'TURN_MEMBERSHIP_REQUIRED' USING ERRCODE='42501';
  END IF;

  IF p_kind = 'compare' THEN
    -- 2.7: the columns' bounds together are at most 500 credits, or the compare does not open; at least two models.
    IF coalesce((p_policy->>'gCredits')::numeric, 501) > 500 THEN RAISE EXCEPTION 'TURN_COMPARE_LIMIT' USING ERRCODE='P0001'; END IF;
    IF coalesce((p_policy->'limits'->>'model')::int, 0) < 2 OR coalesce((p_policy->'limits'->>'paidTools')::int, 1) <> 0
      OR coalesce((p_policy->'limits'->>'freeTools')::int, 1) <> 0 THEN
      RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
    END IF;
    -- One compare at a time per user, as before (the session lock in turn_open covers one conversation only).
    IF EXISTS (SELECT 1 FROM turns WHERE actor_id = p_actor_id AND kind = 'compare' AND state IN ('running','paused','stopping')) THEN
      RAISE EXCEPTION 'TURN_COMPARE_ACTIVE' USING ERRCODE='55P03';
    END IF;
    INSERT INTO fusion_compares (actor_id, request_id, session_id, history_revision, question, question_hash, request_hash,
        snapshot_hash, config, gate_verdict, state)
      VALUES (p_actor_id, p_request_id, p_session_id,
        (SELECT coalesce(max(seq), 0) FROM session_messages WHERE session_id = p_session_id),
        p_product->>'question', p_product->>'questionHash', p_product->>'requestHash', p_product->>'snapshotHash',
        coalesce(p_product->'config', '{}'::jsonb), nullif(p_product->>'gateVerdict', ''), 'running')
      RETURNING * INTO cmp;
    pol := p_policy || jsonb_build_object('compareId', cmp.id);
    opened := turn_open(p_actor_id, p_session_id, p_request_id, p_kind, pol, NULL);
    UPDATE fusion_compares SET turn_id = (opened->>'turnId')::bigint WHERE id = cmp.id;
    RETURN opened || jsonb_build_object('compareId', cmp.id);
  END IF;

  SELECT * INTO rv FROM fusion_reviews WHERE id = (p_product->>'reviewId')::uuid AND actor_id = p_actor_id FOR NO KEY UPDATE;
  IF rv.id IS NULL THEN RAISE EXCEPTION 'TURN_PRODUCT_DENIED' USING ERRCODE='42501'; END IF;
  IF rv.source_session_id <> p_session_id THEN RAISE EXCEPTION 'TURN_PRODUCT_CONFLICT' USING ERRCODE='22023'; END IF;
  IF p_kind = 'jury' THEN
    IF rv.state NOT IN ('running','paused') OR rv.turn_id IS NOT NULL THEN RAISE EXCEPTION 'TURN_PRODUCT_CONFLICT' USING ERRCODE='22023'; END IF;
    IF coalesce((p_policy->>'fixedCredits')::int, 0) < 1 OR (p_policy->>'minCredits')::numeric < (p_policy->>'fixedCredits')::numeric THEN
      RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
    END IF;
    -- "三次未完成暂停该版本" (10-20): the rule fusion_review_start applies, over this version's earlier reviews.
    IF (SELECT count(*) FROM (SELECT state FROM fusion_reviews WHERE source_version_id = rv.source_version_id AND id <> rv.id
          AND breaker_cleared_at IS NULL ORDER BY created_at DESC LIMIT 3) last3 WHERE state IN ('incomplete','revision_failed')) = 3 THEN
      RAISE EXCEPTION 'TURN_JURY_VERSION_BLOCKED' USING ERRCODE='P0001';
    END IF;
  ELSE
    -- jury_adopt: re-finalizing an adopted revision, without a fee (10-20), once per review.
    IF rv.state <> 'completed' OR rv.outcome->>'kind' IS DISTINCT FROM 'revised' OR rv.adoption->>'state' IS DISTINCT FROM 'recorded'
      OR rv.adoption->>'versionId' IS NULL THEN
      RAISE EXCEPTION 'TURN_PRODUCT_CONFLICT' USING ERRCODE='22023';
    END IF;
    IF coalesce((p_policy->>'gCredits')::numeric, 1) <> 0 OR coalesce((p_policy->>'fixedCredits')::numeric, 1) <> 0 THEN
      RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
    END IF;
    IF EXISTS (SELECT 1 FROM turns WHERE actor_id = p_actor_id AND kind = 'jury_adopt' AND policy->>'reviewId' = rv.id::text
        AND (state <> 'closed' OR delivered)) THEN
      RAISE EXCEPTION 'TURN_JURY_ADOPT_USED' USING ERRCODE='P0001';
    END IF;
  END IF;
  pol := p_policy || jsonb_build_object('reviewId', rv.id, 'versionId', rv.source_version_id);
  opened := turn_open(p_actor_id, p_session_id, p_request_id, p_kind, pol, NULL);
  IF p_kind = 'jury' THEN UPDATE fusion_reviews SET turn_id = (opened->>'turnId')::bigint, updated_at = clock_timestamp() WHERE id = rv.id; END IF;
  RETURN opened || jsonb_build_object('reviewId', rv.id);
END $function$;

-- turn_call_begin for these kinds: a jury waiting between two groups (paused, awaiting_user) runs again when its next group
-- begins (2.2); everything else is turn_call_begin's.
CREATE OR REPLACE FUNCTION public.turn_fusion_begin(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_call_kind text, p_model_id uuid,
  p_tool_name text, p_paid boolean, p_request_hash text, p_upper_usd numeric, p_multiplier numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  IF t.kind NOT IN ('compare','jury','jury_adopt') THEN RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023'; END IF;
  IF t.state = 'paused' AND t.pause_reason = 'awaiting_user'
    AND NOT EXISTS (SELECT 1 FROM turn_calls WHERE turn_id = p_turn_id AND seq = p_seq) THEN
    UPDATE turns SET state = 'running', pause_reason = NULL, updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  END IF;
  RETURN turn_call_begin(p_actor_id, p_turn_id, p_seq, p_call_kind, p_model_id, p_tool_name, p_paid, p_request_hash, p_upper_usd,
    p_multiplier);
END $function$;

-- turn_call_record plus the saved answer, in one statement: the receipt and the text the user sees are never apart. The text is
-- not stored once the conversation or account is tombstoned or the review/compare is gone (productGone tells Node to stop).
-- A jury whose last call in flight has its receipt waits for its next group (paused, awaiting_user): the 15-minute crash sweep
-- skips it, and the 24-hour end applies (2.2).
CREATE OR REPLACE FUNCTION public.turn_fusion_record(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_status text,
  p_nominal_usd numeric, p_actual_usd numeric, p_usage jsonb, p_provider_id text, p_payload_hash text, p_raw text, p_output jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; r jsonb; o fusion_turn_outputs; gone boolean := false; v_review uuid; v_compare uuid; v_hash text;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  IF t.kind NOT IN ('compare','jury','jury_adopt') THEN RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023'; END IF;
  r := turn_call_record(p_actor_id, p_turn_id, p_seq, p_status, p_nominal_usd, p_actual_usd, p_usage, p_provider_id, p_payload_hash, p_raw);
  v_review := (t.policy->>'reviewId')::uuid; v_compare := (t.policy->>'compareId')::uuid;
  gone := CASE WHEN v_review IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM fusion_reviews WHERE id = v_review)
               ELSE NOT EXISTS (SELECT 1 FROM fusion_compares WHERE id = v_compare) END;
  IF jsonb_typeof(p_output) = 'object' AND NOT gone AND NOT (r->>'sessionTombstoned')::boolean AND NOT (r->>'accountErasing')::boolean THEN
    IF p_status NOT IN ('ok','unusable') THEN RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023'; END IF;
    v_hash := encode(sha256(convert_to(p_output->>'body', 'UTF8')), 'hex');
    SELECT * INTO o FROM fusion_turn_outputs WHERE turn_id = p_turn_id AND seq = p_seq;
    IF o.turn_id IS NOT NULL THEN
      IF o.body_hash <> v_hash OR o.verdict <> p_output->>'verdict' THEN RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023'; END IF;
    ELSE
      INSERT INTO fusion_turn_outputs (actor_id, turn_id, seq, review_id, compare_id, phase, body, body_hash, verdict)
        VALUES (p_actor_id, p_turn_id, p_seq, v_review, CASE WHEN v_review IS NULL THEN v_compare END, p_output->>'phase',
          p_output->>'body', v_hash, p_output->>'verdict');
    END IF;
  END IF;
  IF t.kind = 'jury' AND t.state = 'running'
    AND NOT EXISTS (SELECT 1 FROM turn_calls WHERE turn_id = p_turn_id AND status IN ('dispatched','identified')) THEN
    UPDATE turns SET state = 'paused', pause_reason = 'awaiting_user', updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  END IF;
  RETURN r || jsonb_build_object('productGone', gone);
END $function$;

-- turn_close for these kinds, with the product record ended in the same transaction: the review's end state and outcome (the
-- review read model and the 3-unfinished rule read them) or the compare's finished state. A jury writes no conversation
-- messages; a compare's answers reach the conversation only when the user adopts one (fusion_compare_turn_adopt).
CREATE OR REPLACE FUNCTION public.turn_fusion_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_delivered boolean,
  p_refund_all boolean, p_failure_code text, p_product jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; target text := p_product->>'state';
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  IF t.kind NOT IN ('compare','jury','jury_adopt') THEN RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023'; END IF;
  IF t.kind = 'jury' AND target IS NOT NULL THEN
    IF target NOT IN ('completed','incomplete','revision_failed','interrupted') THEN RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM fusion_reviews WHERE id = (t.policy->>'reviewId')::uuid FOR NO KEY UPDATE;
    UPDATE fusion_reviews SET state = target, outcome = p_product->'outcome', updated_at = clock_timestamp(), ended_at = clock_timestamp()
      WHERE id = (t.policy->>'reviewId')::uuid AND actor_id = p_actor_id AND state IN ('running','paused');
  ELSIF t.kind = 'compare' THEN
    UPDATE fusion_compares SET state = 'finished', updated_at = clock_timestamp()
      WHERE id = (t.policy->>'compareId')::uuid AND actor_id = p_actor_id AND state = 'running';
  END IF;
  RETURN turn_close(p_actor_id, p_turn_id, p_close_kind, '[]'::jsonb, p_delivered, p_refund_all, p_failure_code);
END $function$;

-- The review record of a jury turn: claim the step at the current position (with the first call sequence of its group, so the
-- read model can group the turn's calls by step) or move to the next position. Compare-and-set on the position, as
-- fusion_review_advance; idempotent by step key. Ending a review is turn_fusion_close's.
CREATE OR REPLACE FUNCTION public.fusion_review_turn_step(p_actor_id uuid, p_review_id uuid, p_from jsonb, p_to jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rv fusion_reviews; key text;
BEGIN
  SELECT * INTO rv FROM fusion_reviews WHERE id = p_review_id AND actor_id = p_actor_id FOR NO KEY UPDATE;
  IF rv.id IS NULL OR rv.turn_id IS NULL THEN RAISE EXCEPTION 'FUSION_REVIEW_DENIED'; END IF;
  key := format('review:%s:%s:%s', p_from->>'round', p_from->>'phase', p_from->>'attempt');
  IF p_to->>'state' = 'claim' AND EXISTS (SELECT 1 FROM jsonb_array_elements(rv.steps) x WHERE x->>'stepKey' = key) THEN
    RETURN fusion_review_view(rv);
  END IF;
  IF rv.state NOT IN ('running','paused') THEN RAISE EXCEPTION 'FUSION_REVIEW_ENDED'; END IF;
  IF rv.round::text IS DISTINCT FROM p_from->>'round' OR rv.phase IS DISTINCT FROM p_from->>'phase'
    OR rv.attempt::text IS DISTINCT FROM p_from->>'attempt' THEN RAISE EXCEPTION 'FUSION_REVIEW_STEP_CONFLICT'; END IF;
  IF p_to->>'state' = 'claim' THEN
    IF coalesce(p_to->>'fromSeq', '') !~ '^[1-9][0-9]{0,3}$' THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
    UPDATE fusion_reviews SET state = 'running', updated_at = clock_timestamp(),
        steps = steps || jsonb_build_array(jsonb_build_object('round', rv.round, 'phase', rv.phase, 'attempt', rv.attempt,
          'groupId', md5(rv.turn_id::text || ':' || key)::uuid, 'stepKey', key, 'claimedAt', clock_timestamp(),
          'fromSeq', (p_to->>'fromSeq')::int))
      WHERE id = rv.id RETURNING * INTO rv;
  ELSIF p_to->>'state' = 'running' THEN
    IF coalesce(p_to->>'round','') !~ '^[1-9][0-9]?$' OR p_to->>'phase' NOT IN ('review','summary')
      OR coalesce(p_to->>'attempt','') !~ '^[1-9][0-9]?$' OR (p_to->>'round')::int > coalesce((rv.config->>'maxRounds')::int, 1) THEN
      RAISE EXCEPTION 'FUSION_REVIEW_INVALID';
    END IF;
    UPDATE fusion_reviews SET state = 'running', round = (p_to->>'round')::int, phase = p_to->>'phase', attempt = (p_to->>'attempt')::int,
        updated_at = clock_timestamp() WHERE id = rv.id RETURNING * INTO rv;
  ELSE RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  RETURN fusion_review_view(rv);
END $function$;

-- Adopting one compare column into the conversation (FUSION-COMPARE): the question and the chosen answer become the next two
-- history messages, once, only while the conversation has not moved on since the compare opened; otherwise the answer is
-- returned as a quote and nothing is recorded (as fusion_compare_adopt).
CREATE OR REPLACE FUNCTION public.fusion_compare_turn_adopt(p_actor_id uuid, p_compare_id uuid, p_seq integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE cmp fusion_compares; s runtime_sessions; o fusion_turn_outputs; head integer;
BEGIN
  SELECT * INTO cmp FROM fusion_compares WHERE id = p_compare_id AND actor_id = p_actor_id;
  IF cmp.id IS NULL OR cmp.turn_id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  SELECT * INTO s FROM runtime_sessions WHERE id = cmp.session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  SELECT * INTO cmp FROM fusion_compares WHERE id = p_compare_id FOR NO KEY UPDATE;
  IF cmp.adoption IS NOT NULL THEN
    IF (cmp.adoption->>'seq')::int = p_seq THEN RETURN cmp.adoption || jsonb_build_object('replay', true); END IF;
    RAISE EXCEPTION 'FUSION_COMPARE_ADOPTED';
  END IF;
  IF cmp.state <> 'finished' THEN RAISE EXCEPTION 'FUSION_COMPARE_ACTIVE'; END IF;
  SELECT * INTO o FROM fusion_turn_outputs WHERE turn_id = cmp.turn_id AND seq = p_seq AND compare_id = cmp.id AND verdict = 'usable';
  IF o.turn_id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_INVALID'; END IF;
  SELECT coalesce(max(seq), 0) INTO head FROM session_messages WHERE session_id = s.id;
  IF head <> cmp.history_revision OR s.active_turn_id IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'quoted', 'body', o.body);
  END IF;
  INSERT INTO session_messages (session_id, seq, role, turn_id, content, content_hash) VALUES
    (s.id, head + 1, 'user', cmp.turn_id, cmp.question, encode(sha256(convert_to(cmp.question, 'UTF8')), 'hex')),
    (s.id, head + 2, 'assistant', cmp.turn_id, o.body, o.body_hash);
  UPDATE fusion_compares SET adoption = jsonb_build_object('state', 'adopted', 'seq', p_seq, 'fromRevision', head, 'toRevision', head + 2),
      updated_at = clock_timestamp() WHERE id = cmp.id RETURNING * INTO cmp;
  RETURN cmp.adoption || jsonb_build_object('replay', false);
END $function$;

-- fusion-recovery on the turns (V2-7b): a jury waiting 24 hours between groups ends (expired: the known usage, at most the fixed
-- price; 10-27); a jury whose review was deleted (its draft deleted) is refunded in full (as the old fee); a review or compare
-- whose turn another path closed (the 15-minute crash sweep, the 24-hour sweep of runtime-recovery) ends too. In batches of at
-- most p_limit per step; one failing item is counted and left for the next run. Idempotent: turn_close returns a closed turn.
CREATE OR REPLACE FUNCTION public.turn_fusion_recovery(p_limit integer DEFAULT 50)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE item record; expired integer := 0; orphaned integer := 0; synced integer := 0; failed integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023'; END IF;
  FOR item IN SELECT actor_id, id FROM turns WHERE state = 'paused' AND updated_at < now() - interval '24 hours'
      AND kind = 'jury' AND pause_reason = 'awaiting_user' ORDER BY updated_at LIMIT p_limit LOOP
    BEGIN
      PERFORM turn_fusion_close(item.actor_id, item.id, 'expired', false, false, 'jury_expired',
        jsonb_build_object('state', 'interrupted', 'outcome', jsonb_build_object('kind', 'expired')));
      expired := expired + 1;
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1;
      RAISE WARNING 'turn_fusion_recovery expire failed: turn % sqlstate %', item.id, SQLSTATE;
    END;
  END LOOP;
  FOR item IN SELECT t.actor_id, t.id FROM turns t WHERE t.state IN ('running','paused') AND t.kind IN ('jury','jury_adopt')
      AND NOT EXISTS (SELECT 1 FROM fusion_reviews r WHERE r.id = (t.policy->>'reviewId')::uuid) ORDER BY t.updated_at LIMIT p_limit LOOP
    BEGIN
      PERFORM turn_close(item.actor_id, item.id, 'failed', '[]'::jsonb, false, true, 'review_deleted');
      orphaned := orphaned + 1;
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1;
      RAISE WARNING 'turn_fusion_recovery orphan failed: turn % sqlstate %', item.id, SQLSTATE;
    END;
  END LOOP;
  FOR item IN SELECT r.id, t.close_kind FROM fusion_reviews r JOIN turns t ON t.actor_id = r.actor_id AND t.id = r.turn_id
      WHERE r.state IN ('running','paused') AND r.turn_id IS NOT NULL AND t.state = 'closed' LIMIT p_limit LOOP
    UPDATE fusion_reviews SET state = CASE WHEN item.close_kind IN ('interrupted','expired') THEN 'interrupted' ELSE 'incomplete' END,
        outcome = coalesce(outcome, jsonb_build_object('kind', item.close_kind)), updated_at = clock_timestamp(), ended_at = clock_timestamp()
      WHERE id = item.id AND state IN ('running','paused');
    synced := synced + 1;
  END LOOP;
  FOR item IN SELECT c.id FROM fusion_compares c JOIN turns t ON t.actor_id = c.actor_id AND t.id = c.turn_id
      WHERE c.state = 'running' AND c.turn_id IS NOT NULL AND t.state = 'closed' LIMIT p_limit LOOP
    UPDATE fusion_compares SET state = 'finished', updated_at = clock_timestamp() WHERE id = item.id AND state = 'running';
    synced := synced + 1;
  END LOOP;
  RETURN jsonb_build_object('expired', expired, 'orphaned', orphaned, 'synced', synced, 'failed', failed);
END $function$;
-- turn_open(uuid,uuid,uuid,text,jsonb,bigint)
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
BEGIN
  IF p_kind NOT IN ('chat','mentor','report','compare','jury','jury_adopt','review') THEN
    RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023';
  END IF;
  IF p_resume_of IS NOT NULL THEN RAISE EXCEPTION 'TURN_RESUME_NOT_SUPPORTED' USING ERRCODE='0A000'; END IF;
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
    OR p_policy ?| ARRAY['day','bucket','holdId','heldCredits'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;

  -- 1. The session, locked: one turn at a time per conversation (3a).
  SELECT * INTO s FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  IF s.id IS NULL THEN RAISE EXCEPTION 'TURN_SESSION_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO prof FROM profiles WHERE id = p_actor_id;
  -- 2. The same request again: the turn it opened, unchanged.
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.session_id IS DISTINCT FROM p_session_id OR existing.kind <> p_kind THEN
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
    -- A jury (or its adoption) runs on the report's draft conversation without occupying it (V2-7b): the conversation stays
    -- usable while a review advances or waits, as before; one review per user is the review record's own rule.
    IF s.active_turn_id IS NOT NULL AND p_kind NOT IN ('jury','jury_adopt') THEN
      RAISE EXCEPTION 'TURN_SESSION_BUSY' USING ERRCODE='55P03';
    END IF;
    -- The same account check as bill2_actor: active and not deleted.
    IF prof.id IS NULL OR prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false' THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_DENIED' USING ERRCODE='42501';
    END IF;

    -- 3. Stop-loss (2.5.1): reserve U_turn on the own bucket row first, then read the day's sum, then check with the band B.
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

    -- 4. Credits: H = min(G_turn, available); below the start threshold the turn does not open. The account row is locked before
    -- the balance is read: two sessions of one account in different stop-loss buckets would otherwise both size H on the same
    -- balance, and the second would be refused instead of freezing what is left. Order: session, bucket, account (as turn_close).
    -- Re-checked under the lock: an erasure that held it (account_erasure_confirm) may have committed while this waited.
    SELECT * INTO prof FROM profiles WHERE id = p_actor_id FOR UPDATE;
    IF prof.status IS DISTINCT FROM 'active' OR prof.is_deleted::text IS DISTINCT FROM 'false'
      OR EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_actor_id) THEN
      RAISE EXCEPTION 'TURN_ACCOUNT_ERASING' USING ERRCODE='42501';
    END IF;
    g := (p_policy->>'gCredits')::int;
    available := greatest(public.credit_available(p_actor_id), 0);
    h := least(g, available);
    IF h < (p_policy->>'minCredits')::int THEN RAISE EXCEPTION 'TURN_INSUFFICIENT_CREDITS' USING ERRCODE='P0001'; END IF;
    IF h > 0 THEN
      SELECT pre_deduct_id INTO hold FROM public.atomic_pre_deduct(p_actor_id, h, 'AI turn freeze', p_request_id);
    END IF;

    frozen := p_policy || jsonb_build_object('day', v_day, 'bucket', v_bucket, 'holdId', hold, 'heldCredits', h);
    INSERT INTO turns (actor_id, session_id, request_id, kind, state, policy, reserved_credits, reserved_usd, input_bytes)
      VALUES (p_actor_id, p_session_id, p_request_id, p_kind, 'running', frozen, h, u_turn,
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
    'reservedCredits', t.reserved_credits, 'reservedUsd', t.reserved_usd, 'history', history,
    'replyLanguage', prof.reply_language,
    'positioning', CASE WHEN p_kind = 'chat' THEN jsonb_build_object(
      'positioned', public.opc_has_confirmed_positioning(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END);
END $function$;

-- turn_call_begin(uuid,bigint,integer,text,uuid,text,boolean,text,numeric,numeric)
CREATE OR REPLACE FUNCTION public.turn_call_begin(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_call_kind text, p_model_id uuid, p_tool_name text, p_paid boolean, p_request_hash text, p_upper_usd numeric, p_multiplier numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; q numeric; used integer; need integer; n_model integer; n_paid integer; n_free integer;
  n_decision integer;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO c FROM turn_calls WHERE turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NOT NULL THEN
    IF c.request_hash <> p_request_hash THEN RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023'; END IF;
    RETURN jsonb_build_object('state', t.state, 'status', c.status, 'replay', true) || turn_tombstones(p_actor_id, t.session_id, t.policy);
  END IF;
  IF t.state <> 'running' THEN RAISE EXCEPTION 'TURN_NOT_RUNNING' USING ERRCODE='55000'; END IF;
  IF p_seq <> coalesce((SELECT max(seq) FROM turn_calls WHERE turn_id = p_turn_id), 0) + 1 THEN
    RAISE EXCEPTION 'TURN_CALL_SEQUENCE' USING ERRCODE='22023';
  END IF;
  IF (p_call_kind = 'tool') IS DISTINCT FROM (p_paid IS NOT NULL) THEN RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023'; END IF;
  -- Frozen limits (2.5.3): attempts that certainly cost nothing (not_sent, rejected, 402) do not count against them. M counts
  -- the model calls the user pays for; the positioning check (decision) is its own limit outside M (Fable 10-28).
  SELECT count(*) FILTER (WHERE call_kind = 'model'),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd > 0),
         count(*) FILTER (WHERE call_kind = 'tool' AND upper_usd = 0),
         count(*) FILTER (WHERE call_kind = 'decision')
    INTO n_model, n_paid, n_free, n_decision
  FROM turn_calls WHERE turn_id = p_turn_id AND status NOT IN ('not_sent','rejected','no_charge_402');
  IF (p_call_kind = 'model' AND n_model >= (t.policy->'limits'->>'model')::int)
    OR (p_call_kind = 'decision' AND n_decision >= coalesce((t.policy->'limits'->>'decisions')::int, 0))
    OR (p_call_kind = 'tool' AND p_paid AND n_paid >= (t.policy->'limits'->>'paidTools')::int)
    OR (p_call_kind = 'tool' AND NOT p_paid AND n_free >= (t.policy->'limits'->>'freeTools')::int)
    OR (p_call_kind = 'tool' AND NOT p_paid AND p_upper_usd <> 0) OR (p_paid AND p_upper_usd <= 0) THEN
    RAISE EXCEPTION 'TURN_CALL_LIMIT' USING ERRCODE='22023';
  END IF;
  -- The remaining freeze must cover this call's bound G_i = ceil(q x U_i x m_i); otherwise the turn waits for credits. The
  -- positioning check is never charged to the user (Owner 10-12): it needs no freeze; its upper bound counts in U_turn and the
  -- stop-loss reservation only.
  q := (t.policy->>'q')::numeric;
  IF t.kind = 'jury' THEN
    -- A jury pays its fixed price whatever its calls cost (Owner 10-17); the freeze above it is the temporary bound of the group
    -- in flight (10-13): only calls still in flight count against it, a finished group's bound is free again (V2-7b).
    SELECT coalesce((t.policy->>'fixedCredits')::int, 0) + coalesce(sum(ceil(q * upper_usd * multiplier)), 0) INTO used
    FROM turn_calls WHERE turn_id = p_turn_id AND call_kind <> 'decision' AND status IN ('dispatched','identified');
  ELSE
    SELECT coalesce(sum(CASE WHEN status = 'ok' THEN ceil(q * nominal_usd * multiplier)
                             WHEN status IN ('dispatched','identified','unknown') THEN ceil(q * upper_usd * multiplier)
                             ELSE 0 END), 0) INTO used
    FROM turn_calls WHERE turn_id = p_turn_id AND call_kind <> 'decision';
  END IF;
  -- A jury adoption is free to the user (10-20): nothing is frozen and nothing needs to be.
  need := CASE WHEN p_call_kind = 'decision' OR t.kind = 'jury_adopt' THEN 0 ELSE ceil(q * p_upper_usd * p_multiplier) END;
  IF t.reserved_credits - used < need THEN
    UPDATE turns SET state = 'paused', pause_reason = 'waiting_credits', updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
    RETURN jsonb_build_object('state', 'paused', 'paused', true) || turn_tombstones(p_actor_id, t.session_id, t.policy);
  END IF;
  INSERT INTO turn_calls (actor_id, turn_id, seq, call_kind, model_id, tool_name, request_hash, upper_usd, multiplier)
    VALUES (p_actor_id, p_turn_id, p_seq, p_call_kind, p_model_id, p_tool_name, p_request_hash, p_upper_usd, p_multiplier);
  UPDATE turns SET updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  RETURN jsonb_build_object('state', 'running', 'status', 'dispatched', 'replay', false) || turn_tombstones(p_actor_id, t.session_id, t.policy);
END $function$;

-- turn_user_charge(uuid,bigint,text,boolean,boolean,integer,integer,integer,timestamp with time zone)
CREATE OR REPLACE FUNCTION public.turn_user_charge(p_actor_id uuid, p_turn_id bigint, p_kind text, p_delivered boolean, p_refund_all boolean, p_credits integer, p_held integer, p_fixed integer, p_at timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE stops integer; t turns;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF p_refund_all THEN RETURN 0; END IF;
  IF t.kind = 'jury' THEN
    -- The jury's fixed price (Owner 10-17/10-27, V2-7b), as fusion_review_fee_settle_internal: a deliverable revision (a usable
    -- summary that changes a section) pays the price however the turn ended; an interruption or the 24-hour end pays the known
    -- usage, at most the price; no change, a failed revision, an incomplete review or an erasure pays nothing.
    IF EXISTS (SELECT 1 FROM turn_calls c WHERE c.turn_id = p_turn_id AND c.status = 'ok' AND c.usage->>'deliverable' = 'true') THEN
      RETURN least(coalesce(p_fixed, p_held), p_held);
    END IF;
    IF p_kind IN ('interrupted','expired') THEN RETURN least(p_credits, coalesce(p_fixed, p_held), p_held); END IF;
    RETURN 0;
  END IF;
  IF t.kind = 'compare' THEN
    -- Each column is rounded on its own (2.7 "各模型各自取整"), as the old per-run settlement did.
    SELECT coalesce(sum(ceil((t.policy->>'q')::numeric * c.nominal_usd * c.multiplier)), 0)::integer INTO p_credits
    FROM turn_calls c WHERE c.turn_id = p_turn_id AND c.status = 'ok' AND c.call_kind <> 'decision';
  END IF;
  IF p_kind = 'expired' AND NOT p_delivered THEN RETURN 0; END IF;
  IF p_kind = 'stopped' THEN
    -- 10-27: the first two stops within 24 hours are free; from the third, what was generated, at most the fixed price.
    SELECT count(*) INTO stops FROM turns r WHERE r.actor_id = p_actor_id AND r.kind = 'report' AND r.stopped_by_user
      AND r.id <> p_turn_id AND r.closed_at > p_at - interval '24 hours' AND r.closed_at <= p_at;
    RETURN CASE WHEN stops < 2 THEN 0 ELSE least(p_credits, p_held, coalesce(p_fixed, p_held)) END;
  END IF;
  IF p_kind = 'completed' AND p_fixed IS NOT NULL THEN RETURN CASE WHEN p_delivered THEN least(p_fixed, p_held) ELSE 0 END; END IF;
  RETURN least(p_credits, p_held);
END $function$;

-- fusion_review_view(fusion_reviews)
CREATE OR REPLACE FUNCTION public.fusion_review_view(rv fusion_reviews)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object('reviewId',rv.id,'state',rv.state,'round',rv.round,'phase',rv.phase,'attempt',rv.attempt,
    'draftId',rv.draft_id,'sourceVersionId',rv.source_version_id,'sourceSessionId',rv.source_session_id,
    'versionHash',rv.version_hash,'materials',rv.materials,'materialsHash',rv.materials_hash,'config',rv.config,
    'steps',rv.steps,'outcome',rv.outcome,'revisionId',rv.revision_id,'endedAt',rv.ended_at,'adoption',rv.adoption,
    'turnId',rv.turn_id,
    -- A review on the turn path (V2-7b): its fixed price is the turn's freeze and settlement.
    'fee',CASE WHEN rv.turn_id IS NULL THEN fusion_review_fee_view(rv.id) ELSE (SELECT jsonb_build_object(
      'credits',(t.policy->>'fixedCredits')::int,
      'state',CASE WHEN t.charged_credits IS NULL THEN 'held' WHEN t.charged_credits>0 THEN 'charged' ELSE 'refunded' END,
      'chargedCredits',t.charged_credits,'reason',t.close_kind,'settledAt',CASE WHEN t.charged_credits IS NOT NULL THEN t.closed_at END)
      FROM turns t WHERE t.actor_id=rv.actor_id AND t.id=rv.turn_id) END,
    -- Per call: its run, verdict and whether it settled, for continueReview. On the turn path a call is one turn_calls row of the
    -- review's turn, in the step whose first sequence is the nearest at or below it; its id is the one fusion_turn_outputs keys.
    'calls',CASE WHEN rv.turn_id IS NULL THEN coalesce((SELECT jsonb_agg(jsonb_build_object('groupId',br.fusion_group_id,'runId',br.id,'callId',c.id,'modelId',br.payload->>'modelId',
      'phase',c.payload->>'phase','dispatched',c.dispatched_at IS NOT NULL,'verdict',c.fusion_verdict,
      'settled',c.settled_at IS NOT NULL,'state',c.state,'dispatchedAt',c.dispatched_at,'settledAt',c.settled_at) ORDER BY c.created_at,c.id)
      FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id
      WHERE br.actor_id=rv.actor_id AND br.fusion_group_id IN (SELECT (x->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) x)),'[]')
    ELSE coalesce((SELECT jsonb_agg(jsonb_build_object('groupId',st.x->>'groupId','runId',md5(c.turn_id::text||':'||c.seq::text)::uuid,
      'callId',md5(c.turn_id::text||':'||c.seq::text)::uuid,'modelId',c.model_id,
      'phase',CASE WHEN st.x->>'phase'='summary' THEN 'fusion_summary' ELSE 'fusion_review' END,
      'dispatched',c.status<>'not_sent',
      'verdict',coalesce(o.verdict,CASE WHEN c.status IN ('not_sent','rejected','no_charge_402') THEN 'no_delivery' END),
      'settled',c.settled_at IS NOT NULL,'state',c.status,'dispatchedAt',c.dispatched_at,'settledAt',c.settled_at) ORDER BY c.seq)
      FROM turn_calls c
      CROSS JOIN LATERAL (SELECT x FROM jsonb_array_elements(rv.steps) x WHERE (x->>'fromSeq')::int<=c.seq
        ORDER BY (x->>'fromSeq')::int DESC LIMIT 1) st
      LEFT JOIN fusion_turn_outputs o ON o.turn_id=c.turn_id AND o.seq=c.seq
      WHERE c.turn_id=rv.turn_id AND c.call_kind='model'),'[]') END);
$function$;

-- fusion_call_output_read(uuid,uuid)
CREATE OR REPLACE FUNCTION public.fusion_call_output_read(p_actor_id uuid, p_call_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE o fusion_call_outputs; s runtime_sessions; v fusion_turn_outputs;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  -- An answer saved on the turn path (V2-7b): readable while its turn's conversation exists, as below.
  SELECT * INTO v FROM fusion_turn_outputs WHERE call_id=p_call_id AND actor_id=p_actor_id;
  IF v.turn_id IS NOT NULL THEN
    SELECT s2.* INTO s FROM runtime_sessions s2 JOIN turns t ON t.session_id=s2.id
      WHERE t.actor_id=p_actor_id AND t.id=v.turn_id FOR SHARE OF s2;
    IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RETURN NULL; END IF;
    RETURN jsonb_build_object('callId',v.call_id,'body',v.body,'bodyHash',v.body_hash,'savedAt',v.saved_at);
  END IF;
  SELECT s2.* INTO s FROM runtime_sessions s2 JOIN fusion_billing_groups g ON g.source_session_id=s2.id
    JOIN bill2_runs r ON r.fusion_group_id=g.id JOIN bill2_calls c ON c.run_id=r.id
    WHERE c.id=p_call_id AND g.actor_id=p_actor_id FOR SHARE OF s2;
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RETURN NULL; END IF;
  SELECT * INTO o FROM fusion_call_outputs WHERE call_id=p_call_id AND actor_id=p_actor_id;
  IF o.call_id IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('callId',o.call_id,'body',o.body,'bodyHash',o.body_hash,'savedAt',o.saved_at);
END $function$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'turn_fusion_open(uuid,uuid,uuid,text,jsonb,jsonb)',
    'turn_fusion_begin(uuid,bigint,integer,text,uuid,text,boolean,text,numeric,numeric)',
    'turn_fusion_record(uuid,bigint,integer,text,numeric,numeric,jsonb,text,text,text,jsonb)',
    'turn_fusion_close(uuid,bigint,text,boolean,boolean,text,jsonb)',
    'fusion_review_turn_step(uuid,uuid,jsonb,jsonb)',
    'fusion_compare_turn_adopt(uuid,uuid,integer)',
    'turn_fusion_recovery(integer)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
