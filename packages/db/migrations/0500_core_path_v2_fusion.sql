-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-7b (placeholder 0500; the number is assigned by the controller before it is applied): compare, jury and jury adoption on the per-turn core
-- (docs/launch/tasks/CORE-PATH-V2.md sections 2.2, 2.5.3, 2.7, 4.4; Owner rules 10-13, 10-17, 10-20, 10-27).
--   turn_fusion_open     Gold gate, the kind's rules (compare: >= 2 models, bounds <= 500 credits, one at a time; jury: the
--                        3-unfinished version rule, the fixed price in the freeze; jury_adopt: once per adopted review, no fee),
--                        the product record (fusion_compares row / fusion_reviews.turn_id), then turn_open: one round trip
--   turn_fusion_begin    turn_call_begin; a jury waiting between groups runs again
--   turn_fusion_record   turn_call_record plus the saved answer (fusion_turn_outputs); a jury with nothing left in flight waits
--                        between groups (paused, awaiting_user)
--   turn_fusion_output   the answer of a call whose cost is not final yet, saved without settling the call
--   turn_fusion_close    turn_close with the review's end state or the compare's finished state in the same transaction
--   fusion_review_turn_step   the review record's claim/advance for a jury on the turn path
--   fusion_compare_turn_adopt the chosen compare answer into the conversation history
--   fusion_compare_turn_admit / fusion_review_turn_source  read before a compare / a jury start opens (read connection,
--                        owner keys): the old permission chain, kept out of turn_fusion_open (read-only)
--   turn_fusion_recovery the fusion-recovery cron's step on turns: 24-hour end, deleted review refund, product sync
--   turn_fusion_ended_review closes a jury turn whose review another path ended (archived business) by that end
--   fusion_turn_raw_scrub (trigger on fusion_reviews / fusion_compares) a deleted review or compare deletes its turn's raw
--                        provider responses
-- Changed (whole CREATE OR REPLACE from packages/db/functions):
--   turn_open            a jury (or adoption) does not occupy its draft conversation (active_turn_id), as before V2
--   turn_call_begin      a jury's freeze check counts the fixed price plus the calls in flight (the group's temporary bound)
--   turn_user_charge     jury: deliverable revision -> fixed price; interrupted / 24-hour end -> min(fixed, known usage);
--                        otherwise 0. compare: each column rounded on its own
--   fusion_review_view, fusion_call_output_read: a review on the turn path reads its calls and answers from the turn
--   fusion_review_start  a turn-path review (config.path = 'turn') holds no fee (its jury turn freezes the price); no review
--                        while a compare turn runs
--   fusion_review_claim, fusion_review_close: refuse turn-path reviews (no BILL2 group; no stop or end button, Owner 10-28)
--   fusion_review_pause_idle, fusion_review_end_paused: skip turn-path reviews (their turn waits and ends instead)
--   account_erasure_scrub_turns: also deletes the account's saved answers (fusion_turn_outputs)
--   fusion_review_breaker_usage: the 7-day platform cost breaker also counts compare and jury turns
-- Compatibility: new columns are nullable, the new table and functions are used only by the V2 path (core_path_v2.enabled);
-- old reviews and compares keep turn_id NULL and every old branch unchanged; the changed turn_* branches apply to jury and compare
-- turns only, which nothing opens before this migration. Repeatable: IF NOT EXISTS / CREATE OR REPLACE throughout.
-- Recovery: drop the two triggers, the twelve new functions and fusion_turn_outputs, drop the two turn_id columns, and restore the twelve changed
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
  -- A summary that passed the host check and changes a section: the jury's fixed price is due (turn_user_charge), also when
  -- the call's cost was not final when the answer was saved (turn_fusion_output).
  deliverable boolean NOT NULL DEFAULT false CHECK (NOT deliverable OR (verdict = 'usable' AND phase = 'fusion_summary')),
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

-- A review or compare deleted (its draft, its conversation or a workspace source deleted, the account erased) takes the raw
-- provider responses of its turn with it: they hold the same content as its saved answers (fusion_turn_outputs, cascaded);
-- an adopted compare answer copied into the conversation is emptied and hidden too.
-- The receipts themselves stay (billing records). A receipt still being written holds the row in key-share mode, so the
-- deletion waits for it and removes its raw response too (turn_fusion_record).
CREATE OR REPLACE FUNCTION public.fusion_turn_raw_scrub()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF OLD.turn_id IS NOT NULL THEN
    DELETE FROM turn_call_raw WHERE turn_id = OLD.turn_id;
    -- An adopted compare answer copied into the conversation (fusion_compare_turn_adopt) leaves the history with its compare
    -- (e.g. a workspace source it read was deleted): emptied and hidden, as account erasure does with messages.
    IF TG_TABLE_NAME = 'fusion_compares' THEN
      UPDATE session_messages SET content = '', content_hash = encode(sha256(''::bytea), 'hex'), visible = false,
          deleted_at = coalesce(deleted_at, clock_timestamp())
        WHERE session_id = OLD.session_id AND turn_id = OLD.turn_id AND (content <> '' OR visible);
    END IF;
  END IF;
  RETURN OLD;
END $function$;
DROP TRIGGER IF EXISTS fusion_reviews_turn_raw_scrub ON public.fusion_reviews;
CREATE TRIGGER fusion_reviews_turn_raw_scrub AFTER DELETE ON public.fusion_reviews FOR EACH ROW EXECUTE FUNCTION public.fusion_turn_raw_scrub();
DROP TRIGGER IF EXISTS fusion_compares_turn_raw_scrub ON public.fusion_compares;
CREATE TRIGGER fusion_compares_turn_raw_scrub AFTER DELETE ON public.fusion_compares FOR EACH ROW EXECUTE FUNCTION public.fusion_turn_raw_scrub();
REVOKE ALL ON FUNCTION public.fusion_turn_raw_scrub() FROM PUBLIC, anon, authenticated, service_role;

-- Open a compare, jury or jury adoption turn: the Gold gate and the kind's own rules, the product record, then turn_open in the
-- same transaction (one round trip). A repeated request answers like turn_open, without the live gates (its freeze exists).
-- Locks (ENGINEERING 5): only the account, the conversation and the turn, in turn_open's / turn_close's order (profile ->
-- session -> turn -> stop-loss bucket); a receipt takes the conversation in share mode before its turn. Review and compare rows
-- are never locked: they are written on the owner key, only while still in the state read (a changed one is a conflict or keeps
-- the other path's end).
CREATE OR REPLACE FUNCTION public.turn_fusion_open(p_actor_id uuid, p_session_id uuid, p_request_id uuid, p_kind text, p_policy jsonb, p_product jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rv fusion_reviews; cmp fusion_compares; existing turns; opened jsonb; pol jsonb; lvl text; st jsonb; deps jsonb;
BEGIN
  IF p_kind NOT IN ('compare','jury','jury_adopt') OR jsonb_typeof(p_product) <> 'object' OR jsonb_typeof(p_policy) <> 'object'
    OR p_policy ?| ARRAY['reviewId','versionId','compareId'] THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  -- Only the main path's own locks (ENGINEERING 5): the account, then the conversation, as turn_open and turn_close. The account
  -- serializes this user's opens (one compare, one review, the request's replay); the conversation serializes the open with a
  -- chat closing in it and with a content erasure (content_erasure_confirm locks the conversations first, NOWAIT). The review
  -- and compare rows are not locked: they are written last, on the owner key, only if still in the state read here.
  PERFORM 1 FROM profiles WHERE id = p_actor_id FOR UPDATE;
  -- A jury starts its review record in the same transaction (idempotent by request, turn path: no fee), so a refused open leaves
  -- no review behind. Its fields were read before the open (fusion_review_turn_source, with the old start's permission checks);
  -- here, under the account lock, only what must be atomic: one running review per user.
  IF p_kind = 'jury' AND jsonb_typeof(p_product->'start') = 'object' THEN
    IF NOT EXISTS (SELECT 1 FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id) THEN
      st := p_product->'start';
      IF st->'config'->>'path' IS DISTINCT FROM 'turn' OR jsonb_typeof(st->'materials') IS DISTINCT FROM 'object'
        OR coalesce(st->>'versionHash', '') = '' THEN RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023'; END IF;
      SELECT * INTO rv FROM fusion_reviews WHERE actor_id = p_actor_id AND request_id = p_request_id;
      IF rv.id IS NULL THEN
        IF EXISTS (SELECT 1 FROM fusion_reviews WHERE actor_id = p_actor_id AND state IN ('running','paused')) THEN
          RAISE EXCEPTION 'FUSION_REVIEW_ACTIVE';
        END IF;
        INSERT INTO fusion_reviews (actor_id, request_id, draft_id, project_id, source_session_id, source_version_id, version_hash,
            materials, materials_hash, config, state, round, phase, attempt)
          VALUES (p_actor_id, p_request_id, (st->>'draftId')::uuid, (st->>'projectId')::uuid, (st->>'sessionId')::uuid,
            (st->>'sourceVersionId')::uuid, st->>'versionHash', st->'materials',
            encode(sha256(convert_to((st->'materials')::text, 'UTF8')), 'hex'), st->'config', 'running', 1, 'review', 1)
          RETURNING * INTO rv;
      ELSIF rv.draft_id IS DISTINCT FROM (st->>'draftId')::uuid OR rv.source_version_id IS DISTINCT FROM (st->>'sourceVersionId')::uuid THEN
        RAISE EXCEPTION 'FUSION_REVIEW_CONFLICT';
      END IF;
      p_product := p_product || jsonb_build_object('reviewId', rv.id);
    ELSE
      p_product := p_product || jsonb_build_object('reviewId', (SELECT policy->>'reviewId' FROM turns WHERE actor_id = p_actor_id
        AND request_id = p_request_id));
    END IF;
  END IF;
  -- The conversation: a compare's own; a jury's is its review's draft conversation (whatever the caller passed).
  IF p_kind <> 'compare' THEN
    p_session_id := (SELECT source_session_id FROM fusion_reviews WHERE id = (p_product->>'reviewId')::uuid AND actor_id = p_actor_id);
  END IF;
  PERFORM 1 FROM runtime_sessions WHERE id = p_session_id AND actor_id = p_actor_id FOR UPDATE;
  SELECT * INTO existing FROM turns WHERE actor_id = p_actor_id AND request_id = p_request_id;
  IF existing.id IS NOT NULL THEN
    IF existing.kind <> p_kind THEN RAISE EXCEPTION 'TURN_REQUEST_CONFLICT' USING ERRCODE='22023'; END IF;
    -- A jury's conversation is its review's (the draft conversation); a repeat answers on the turn's own.
    opened := turn_open(p_actor_id, CASE WHEN p_kind = 'compare' THEN p_session_id ELSE existing.session_id END, p_request_id, p_kind,
      p_policy, NULL);
    RETURN opened || jsonb_build_object('reviewId', existing.policy->'reviewId', 'compareId', existing.policy->'compareId');
  END IF;

  -- Review and compare are Gold only (record D, 10-20): the cached membership level and the plan's own switch.
  SELECT membership_level INTO lvl FROM profiles WHERE id = p_actor_id;
  IF lvl IS DISTINCT FROM 'gold' OR NOT EXISTS (SELECT 1 FROM membership_plans mp WHERE mp.level = lvl
      AND CASE WHEN p_kind = 'compare' THEN mp.allow_fusion_compare ELSE mp.allow_fusion_review END) THEN
    RAISE EXCEPTION 'TURN_MEMBERSHIP_REQUIRED' USING ERRCODE='42501';
  END IF;

  IF p_kind = 'compare' THEN
    -- The business writable (0324), the sources allowed, the positioning and the 7-day breaker were read before the open
    -- (fusion_compare_turn_admit). Here, under the locks: the bounds, one compare at a time.
    -- 2.7: the columns' bounds together are at most 500 credits, or the compare does not open; at least two models.
    IF coalesce((p_policy->>'gCredits')::numeric, 501) > 500 THEN RAISE EXCEPTION 'TURN_COMPARE_LIMIT' USING ERRCODE='P0001'; END IF;
    IF coalesce((p_policy->'limits'->>'model')::int, 0) < 2 OR coalesce((p_policy->'limits'->>'paidTools')::int, 1) <> 0
      OR coalesce((p_policy->'limits'->>'freeTools')::int, 1) <> 0 THEN
      RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
    END IF;
    -- One compare at a time per user and none while a review runs, as before (the session lock covers one conversation only).
    IF EXISTS (SELECT 1 FROM turns WHERE actor_id = p_actor_id AND kind = 'compare' AND state IN ('running','paused','stopping'))
      OR EXISTS (SELECT 1 FROM fusion_reviews WHERE actor_id = p_actor_id AND state IN ('running','paused')) THEN
      RAISE EXCEPTION 'TURN_COMPARE_ACTIVE' USING ERRCODE='55P03';
    END IF;
    -- The workspace sources the columns read, frozen with the record (content_erasure_confirm finds the compare by them when a
    -- source is deleted).
    deps := coalesce(p_product->'workspaceDependencies', '[]'::jsonb);
    IF jsonb_typeof(deps) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(deps) d WHERE jsonb_typeof(d) <> 'object'
        OR coalesce(d->>'sourceVersionId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        OR (SELECT count(*) FROM jsonb_object_keys(d)) <> 1) THEN
      RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
    END IF;
    INSERT INTO fusion_compares (actor_id, request_id, session_id, history_revision, question, question_hash, request_hash,
        snapshot_hash, config, gate_verdict, workspace_dependencies, state)
      VALUES (p_actor_id, p_request_id, p_session_id,
        (SELECT coalesce(max(seq), 0) FROM session_messages WHERE session_id = p_session_id),
        p_product->>'question', p_product->>'questionHash', p_product->>'requestHash', p_product->>'snapshotHash',
        coalesce(p_product->'config', '{}'::jsonb), nullif(p_product->>'gateVerdict', ''), deps, 'running')
      RETURNING * INTO cmp;
    pol := p_policy || jsonb_build_object('compareId', cmp.id);
    opened := turn_open(p_actor_id, p_session_id, p_request_id, p_kind, pol, NULL);
    -- Again under turn_open's account lock: two compares opened at once in two conversations both passed the check above;
    -- the second waits on the account row and sees the first here, and rolls back (its freeze and record with it).
    -- A review started at the same time in another conversation is seen here too (the jury checks compares the same way).
    IF EXISTS (SELECT 1 FROM turns WHERE actor_id = p_actor_id AND kind = 'compare' AND state IN ('running','paused','stopping')
        AND id <> (opened->>'turnId')::bigint)
      OR EXISTS (SELECT 1 FROM fusion_reviews WHERE actor_id = p_actor_id AND state IN ('running','paused')) THEN
      RAISE EXCEPTION 'TURN_COMPARE_ACTIVE' USING ERRCODE='55P03';
    END IF;
    UPDATE fusion_compares SET turn_id = (opened->>'turnId')::bigint WHERE actor_id = p_actor_id AND id = cmp.id;
    -- The positioning gate's refusal count in 24 hours (as turn_open's for a free chat; the positioning itself was read before).
    RETURN opened || jsonb_build_object('compareId', cmp.id, 'positioning', jsonb_build_object(
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')));
  END IF;

  SELECT * INTO rv FROM fusion_reviews WHERE id = (p_product->>'reviewId')::uuid AND actor_id = p_actor_id;
  IF rv.id IS NULL THEN RAISE EXCEPTION 'TURN_PRODUCT_DENIED' USING ERRCODE='42501'; END IF;
  IF p_kind = 'jury' THEN
    IF rv.state NOT IN ('running','paused') OR rv.turn_id IS NOT NULL OR rv.config->>'path' IS DISTINCT FROM 'turn' THEN RAISE EXCEPTION 'TURN_PRODUCT_CONFLICT' USING ERRCODE='22023'; END IF;
    IF coalesce((p_policy->>'fixedCredits')::int, 0) < 1 OR (p_policy->>'minCredits')::numeric < (p_policy->>'fixedCredits')::numeric THEN
      RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
    END IF;
    -- "三次未完成暂停该版本" (10-20): the rule fusion_review_start applies, over this version's earlier reviews.
    IF (SELECT count(*) FROM (SELECT state FROM fusion_reviews WHERE source_version_id = rv.source_version_id AND id <> rv.id
          AND breaker_cleared_at IS NULL ORDER BY created_at DESC LIMIT 3) last3 WHERE state IN ('incomplete','revision_failed')) = 3 THEN
      RAISE EXCEPTION 'TURN_JURY_VERSION_BLOCKED' USING ERRCODE='P0001';
    END IF;
  ELSE
    -- jury_adopt: re-finalizing an adopted revision, without a fee (10-20), once per review. The business writable (0324) is read
    -- before the open by its executor, as a compare's and a jury start's checks.
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
  -- A review and a compare exclude each other (fusion_review_start, fusion_compare_begin): checked again here, under
  -- turn_open's account lock, so one started at the same time in another conversation is seen and this one rolls back.
  IF p_kind = 'jury' AND EXISTS (SELECT 1 FROM turns WHERE actor_id = p_actor_id AND kind = 'compare'
      AND state IN ('running','paused','stopping')) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_ACTIVE' USING ERRCODE='55P03';
  END IF;
  IF p_kind = 'jury' THEN
    -- Written only if still as read above (no turn yet, not ended): another path that changed it meanwhile (a business archived
    -- ends the review) makes this open a conflict, rolled back with its freeze.
    UPDATE fusion_reviews SET turn_id = (opened->>'turnId')::bigint, updated_at = clock_timestamp()
      WHERE actor_id = p_actor_id AND id = rv.id AND turn_id IS NULL AND state IN ('running','paused');
    IF NOT FOUND AND NOT (opened->>'replay')::boolean THEN RAISE EXCEPTION 'TURN_PRODUCT_CONFLICT' USING ERRCODE='22023'; END IF;
    -- A new jury waits for its first group as it waits between groups (paused, awaiting_user): the first begin resumes it, and
    -- a first group that never gets sent (the pause or the call limits refusing it) still ends by the 24-hour rule, refunded.
    IF NOT (opened->>'replay')::boolean THEN
      UPDATE turns SET state = 'paused', pause_reason = 'awaiting_user', updated_at = now()
        WHERE actor_id = p_actor_id AND id = (opened->>'turnId')::bigint AND state = 'running';
      opened := opened || jsonb_build_object('state', 'paused');
    END IF;
  END IF;
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
CREATE OR REPLACE FUNCTION public.turn_fusion_record(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_status text, p_nominal_usd numeric, p_actual_usd numeric, p_usage jsonb, p_provider_id text, p_payload_hash text, p_raw text, p_output jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; r jsonb; o fusion_turn_outputs; gone boolean := false; v_review uuid; v_compare uuid; v_hash text;
BEGIN
  -- The conversation in share mode first, then the turn (the close's order: conversation before turn). A deletion of the review
  -- or compare (content_erasure_confirm: draft, source or conversation deleted) locks the conversations first, NOWAIT: it fails
  -- while this receipt is written, or committed before and the product is seen gone below. The product row itself is not locked
  -- (ENGINEERING 5).
  PERFORM 1 FROM runtime_sessions WHERE actor_id = p_actor_id
    AND id = (SELECT session_id FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id) FOR SHARE;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  IF t.kind NOT IN ('compare','jury','jury_adopt') THEN RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023'; END IF;
  v_review := (t.policy->>'reviewId')::uuid; v_compare := (t.policy->>'compareId')::uuid;
  -- A deletion that committed first leaves nothing to keep; one after this receipt removes the raw response with the product
  -- (fusion_turn_raw_scrub). An account erasure is the tombstone below (account_erasure_scrub_turns removes the rest).
  gone := CASE WHEN v_review IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM fusion_reviews WHERE actor_id = p_actor_id AND id = v_review)
               ELSE NOT EXISTS (SELECT 1 FROM fusion_compares WHERE actor_id = p_actor_id AND id = v_compare) END;
  -- The receipt (billing evidence) is always written; the response text is not once its review or compare is gone.
  r := turn_call_record(p_actor_id, p_turn_id, p_seq, p_status, p_nominal_usd, p_actual_usd, p_usage, p_provider_id, p_payload_hash,
    CASE WHEN gone THEN NULL ELSE p_raw END);
  IF jsonb_typeof(p_output) = 'object' AND NOT gone AND NOT (r->>'sessionTombstoned')::boolean AND NOT (r->>'accountErasing')::boolean THEN
    IF p_status NOT IN ('ok','unusable') THEN RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023'; END IF;
    v_hash := encode(sha256(convert_to(p_output->>'body', 'UTF8')), 'hex');
    SELECT * INTO o FROM fusion_turn_outputs WHERE turn_id = p_turn_id AND seq = p_seq;
    IF o.turn_id IS NOT NULL THEN
      IF o.body_hash <> v_hash OR o.verdict <> p_output->>'verdict' THEN RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023'; END IF;
    ELSE
      INSERT INTO fusion_turn_outputs (actor_id, turn_id, seq, review_id, compare_id, phase, body, body_hash, verdict, deliverable)
        VALUES (p_actor_id, p_turn_id, p_seq, v_review, CASE WHEN v_review IS NULL THEN v_compare END, p_output->>'phase',
          p_output->>'body', v_hash, p_output->>'verdict', coalesce((p_output->>'deliverable')::boolean, false));
    END IF;
  END IF;
  IF t.kind = 'jury' AND t.state = 'running'
    AND NOT EXISTS (SELECT 1 FROM turn_calls WHERE turn_id = p_turn_id AND status IN ('dispatched','identified')) THEN
    UPDATE turns SET state = 'paused', pause_reason = 'awaiting_user', updated_at = now() WHERE actor_id = p_actor_id AND id = p_turn_id;
  END IF;
  RETURN r || jsonb_build_object('productGone', gone);
END $function$;

-- The answer of a call whose response is complete but whose cost is not final yet (no usage cost in the stream): saved and
-- judged now, while the call stays dispatched/identified for recovery to settle by its provider id (2.5.2). Same rules as
-- turn_fusion_record for the text: the product row in key-share mode, nothing stored once it or the conversation is gone.
CREATE OR REPLACE FUNCTION public.turn_fusion_output(p_actor_id uuid, p_turn_id bigint, p_seq integer, p_output jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; c turn_calls; o fusion_turn_outputs; gone boolean; tomb jsonb; v_review uuid; v_compare uuid; v_hash text;
BEGIN
  -- The conversation in share mode before the turn, as turn_fusion_record (a deletion of the product waits or is seen gone).
  PERFORM 1 FROM runtime_sessions WHERE actor_id = p_actor_id
    AND id = (SELECT session_id FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id) FOR SHARE;
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id FOR UPDATE;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  IF t.kind NOT IN ('compare','jury') OR jsonb_typeof(p_output) <> 'object' OR p_output->>'verdict' NOT IN ('usable','format_invalid','revision_invalid') THEN
    RAISE EXCEPTION 'TURN_CALL_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO c FROM turn_calls WHERE actor_id = p_actor_id AND turn_id = p_turn_id AND seq = p_seq;
  IF c.turn_id IS NULL OR c.call_kind <> 'model' OR c.status NOT IN ('dispatched','identified','unknown') THEN
    RAISE EXCEPTION 'TURN_CALL_DENIED' USING ERRCODE='42501';
  END IF;
  v_review := (t.policy->>'reviewId')::uuid; v_compare := (t.policy->>'compareId')::uuid;
  gone := CASE WHEN v_review IS NOT NULL THEN NOT EXISTS (SELECT 1 FROM fusion_reviews WHERE actor_id = p_actor_id AND id = v_review)
               ELSE NOT EXISTS (SELECT 1 FROM fusion_compares WHERE actor_id = p_actor_id AND id = v_compare) END;
  tomb := turn_tombstones(p_actor_id, t.session_id, t.policy);
  IF NOT gone AND NOT (tomb->>'sessionTombstoned')::boolean AND NOT (tomb->>'accountErasing')::boolean THEN
    v_hash := encode(sha256(convert_to(p_output->>'body', 'UTF8')), 'hex');
    SELECT * INTO o FROM fusion_turn_outputs WHERE turn_id = p_turn_id AND seq = p_seq;
    IF o.turn_id IS NOT NULL THEN
      IF o.body_hash <> v_hash OR o.verdict <> p_output->>'verdict' THEN RAISE EXCEPTION 'TURN_CALL_CONFLICT' USING ERRCODE='22023'; END IF;
    ELSE
      INSERT INTO fusion_turn_outputs (actor_id, turn_id, seq, review_id, compare_id, phase, body, body_hash, verdict, deliverable)
        VALUES (p_actor_id, p_turn_id, p_seq, v_review, CASE WHEN v_review IS NULL THEN v_compare END, p_output->>'phase',
          p_output->>'body', v_hash, p_output->>'verdict', coalesce((p_output->>'deliverable')::boolean, false));
    END IF;
  END IF;
  RETURN jsonb_build_object('productGone', gone) || tomb;
END $function$;

-- turn_close for these kinds, with the product record ended in the same transaction: the review's end state and outcome (the
-- review read model and the 3-unfinished rule read them) or the compare's finished state. A jury writes no conversation
-- messages; a compare's answers reach the conversation only when the user adopts one (fusion_compare_turn_adopt).
CREATE OR REPLACE FUNCTION public.turn_fusion_close(p_actor_id uuid, p_turn_id bigint, p_close_kind text, p_delivered boolean, p_refund_all boolean, p_failure_code text, p_product jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t turns; target text := p_product->>'state'; closed jsonb;
BEGIN
  SELECT * INTO t FROM turns WHERE actor_id = p_actor_id AND id = p_turn_id;
  IF t.id IS NULL THEN RAISE EXCEPTION 'TURN_DENIED' USING ERRCODE='42501'; END IF;
  IF t.kind NOT IN ('compare','jury','jury_adopt') THEN RAISE EXCEPTION 'TURN_KIND_INVALID' USING ERRCODE='22023'; END IF;
  IF t.kind = 'jury' AND target IS NOT NULL
    AND target NOT IN ('completed','incomplete','revision_failed','interrupted') THEN RAISE EXCEPTION 'TURN_CLOSE_INVALID' USING ERRCODE='22023';
  END IF;
  -- The core close first (it locks the account, the conversation and the turn, in that order); the review or compare row is not
  -- locked (ENGINEERING 5) but written after, on the owner key and only while still live: one another path ended meanwhile
  -- keeps that end.
  closed := turn_close(p_actor_id, p_turn_id, p_close_kind, '[]'::jsonb, p_delivered, p_refund_all, p_failure_code);
  IF t.kind = 'jury' AND target IS NOT NULL THEN
    UPDATE fusion_reviews SET state = target, outcome = p_product->'outcome', updated_at = clock_timestamp(), ended_at = clock_timestamp()
      WHERE actor_id = p_actor_id AND id = (t.policy->>'reviewId')::uuid AND state IN ('running','paused');
  ELSIF t.kind = 'compare' THEN
    UPDATE fusion_compares SET state = 'finished', updated_at = clock_timestamp()
      WHERE actor_id = p_actor_id AND id = (t.policy->>'compareId')::uuid AND state = 'running';
  END IF;
  RETURN closed;
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
  -- Not locked (ENGINEERING 5): each write below names the step it was read at (round, phase, attempt, live state) and changes
  -- nothing if the review moved meanwhile; the review is then read again and answered from its new state.
  SELECT * INTO rv FROM fusion_reviews WHERE id = p_review_id AND actor_id = p_actor_id;
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
      WHERE actor_id = p_actor_id AND id = rv.id AND state IN ('running','paused') AND round = rv.round AND phase = rv.phase
        AND attempt = rv.attempt AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(steps) x WHERE x->>'stepKey' = key)
      RETURNING * INTO rv;
    IF NOT FOUND THEN RETURN fusion_review_turn_step(p_actor_id, p_review_id, p_from, p_to); END IF;
  ELSIF p_to->>'state' = 'running' THEN
    IF coalesce(p_to->>'round','') !~ '^[1-9][0-9]?$' OR p_to->>'phase' NOT IN ('review','summary')
      OR coalesce(p_to->>'attempt','') !~ '^[1-9][0-9]?$' OR (p_to->>'round')::int > coalesce((rv.config->>'maxRounds')::int, 1) THEN
      RAISE EXCEPTION 'FUSION_REVIEW_INVALID';
    END IF;
    UPDATE fusion_reviews SET state = 'running', round = (p_to->>'round')::int, phase = p_to->>'phase', attempt = (p_to->>'attempt')::int,
        updated_at = clock_timestamp()
      WHERE actor_id = p_actor_id AND id = rv.id AND state IN ('running','paused') AND round = rv.round AND phase = rv.phase
        AND attempt = rv.attempt
      RETURNING * INTO rv;
    IF NOT FOUND THEN RETURN fusion_review_turn_step(p_actor_id, p_review_id, p_from, p_to); END IF;
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
  -- Only the compare's conversation is locked (ENGINEERING 5); the compare row is read again under it (its close and its
  -- deletion hold the conversation too) and written on its owner key only if still not adopted.
  SELECT * INTO s FROM runtime_sessions WHERE actor_id = p_actor_id
    AND id = (SELECT session_id FROM fusion_compares WHERE id = p_compare_id AND actor_id = p_actor_id) FOR UPDATE;
  SELECT * INTO cmp FROM fusion_compares WHERE id = p_compare_id AND actor_id = p_actor_id;
  IF cmp.id IS NULL OR cmp.turn_id IS NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
  -- An archived business is read-only (0324), as fusion_compare_adopt.
  PERFORM opc_assert_business_writable(p_actor_id, jsonb_build_object('sessionId', cmp.session_id));
  IF s.id IS NULL OR s.content_deleted_at IS NOT NULL OR s.erased_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_COMPARE_DENIED'; END IF;
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
      updated_at = clock_timestamp() WHERE actor_id = p_actor_id AND id = cmp.id AND adoption IS NULL RETURNING * INTO cmp;
  IF NOT FOUND THEN RAISE EXCEPTION 'FUSION_COMPARE_ADOPTED'; END IF;
  RETURN cmp.adoption || jsonb_build_object('replay', false);
END $function$;

-- What a compare reads before it opens, on the read connection by the owner's keys (ENGINEERING 5: the old permission chain
-- stays out of turn_fusion_open, as V2-7a's report_source): the history it sizes its columns on (the same query as turn_open's,
-- which returns the authoritative copy; the compare refuses when they differ), the business still writable (0324), each
-- workspace source still allowed, the confirmed positioning, and the 7-day breaker statistic (the caller compares it with the
-- settings). Read-only; between this read and the open a deletion can land (milliseconds, AGENTS 5: logged, not compensated).
CREATE OR REPLACE FUNCTION public.fusion_compare_turn_admit(p_actor_id uuid, p_session_id uuid, p_limit integer, p_dependencies jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE deps jsonb := coalesce(p_dependencies, '[]'::jsonb);
BEGIN
  PERFORM opc_assert_business_writable(p_actor_id, jsonb_build_object('sessionId', p_session_id));
  IF jsonb_typeof(deps) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements(deps) d WHERE jsonb_typeof(d) <> 'object'
      OR coalesce(d->>'sourceVersionId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
    RAISE EXCEPTION 'TURN_POLICY_INVALID' USING ERRCODE='22023';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(deps) d
      WHERE NOT coalesce(opc_source_allowed(p_actor_id, (d->>'sourceVersionId')::uuid), false)) THEN
    RAISE EXCEPTION 'FUSION_COMPARE_SOURCE_REVOKED' USING ERRCODE='42501';
  END IF;
  RETURN jsonb_build_object(
    'history', (SELECT coalesce(jsonb_agg(jsonb_build_object('seq', m.seq, 'role', m.role, 'content', m.content) ORDER BY m.seq), '[]'::jsonb)
      FROM (SELECT seq, role, content FROM session_messages
            WHERE session_id = p_session_id AND visible AND deleted_at IS NULL
              AND EXISTS (SELECT 1 FROM runtime_sessions s WHERE s.id = p_session_id AND s.actor_id = p_actor_id
                AND s.content_deleted_at IS NULL AND s.erased_at IS NULL)
            ORDER BY seq DESC LIMIT least(greatest(p_limit, 0), 200)) m),
    'positioned', opc_has_confirmed_positioning(p_actor_id),
    'breaker', fusion_review_breaker_usage(p_actor_id));
END $function$;

-- What a jury start reads before it opens (the same reading, for fusion_review_start's checks on the turn path): the business
-- writable, the draft not read-only, the current formal version of a generated report, no other review or compare running (a
-- review of this same request excepted, so a repeated start answers as a replay), the 3-unfinished rule; and the review
-- record's fields (the draft, its project and conversation, the version and its hash, the materials). turn_fusion_open writes
-- them, under the account lock, with the checks that must be atomic there. Read-only, no lock.
CREATE OR REPLACE FUNCTION public.fusion_review_turn_source(p_actor_id uuid, p_request_id uuid, p_draft_id uuid, p_source_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE d opc_drafts; p artifact_projects; r artifact_rounds; ver artifact_versions; m jsonb;
BEGIN
  PERFORM opc_assert_business_writable(p_actor_id, jsonb_build_object('draftId', p_draft_id));
  IF opc_draft_readonly(p_actor_id, p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF;
  SELECT * INTO d FROM opc_drafts WHERE draft_id = p_draft_id AND actor_id = p_actor_id;
  SELECT * INTO p FROM artifact_projects WHERE id = d.project_id AND actor_id = p_actor_id;
  SELECT * INTO ver FROM artifact_versions WHERE id = p_source_version_id AND project_id = p.id AND erased_at IS NULL;
  SELECT * INTO r FROM artifact_rounds WHERE id = ver.round_id AND project_id = p.id;
  IF d.draft_id IS NULL OR p.id IS NULL OR ver.id IS NULL OR r.state IS DISTINCT FROM 'published' OR d.round_id IS DISTINCT FROM r.id
    OR ver.version IS DISTINCT FROM p.current_version OR NOT coalesce(ver.report ? 'generatedReport', false)
    OR NOT content_erasure_artifact_readable(p_actor_id, ver.id) THEN RAISE EXCEPTION 'FUSION_REVIEW_STALE'; END IF;
  IF fusion_compare_active(p_actor_id)
    OR EXISTS (SELECT 1 FROM fusion_reviews WHERE actor_id = p_actor_id AND state IN ('running','paused') AND request_id <> p_request_id)
    OR EXISTS (SELECT 1 FROM turns WHERE actor_id = p_actor_id AND kind = 'compare' AND state IN ('running','paused','stopping'))
    OR EXISTS (SELECT 1 FROM bill2_calls c JOIN bill2_runs br ON br.id = c.run_id WHERE br.actor_id = p_actor_id
      AND br.fusion_group_id IS NOT NULL AND fusion_call_in_flight(c)) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_ACTIVE';
  END IF;
  SELECT coalesce(jsonb_object_agg(s.key, (SELECT coalesce(jsonb_object_agg(f.key, jsonb_build_object('value', f.value->'value',
      'status', f.value->'status')), '{}') FROM jsonb_each(coalesce(s.value->'information', '{}')) f)), '{}')
    INTO m FROM jsonb_each(r.steps) s;
  RETURN jsonb_build_object('draftId', d.draft_id, 'projectId', p.id, 'sessionId', d.session_id, 'sourceVersionId', ver.id,
    'versionHash', ver.report_hash, 'materials', m, 'breaker', fusion_review_breaker_usage(p_actor_id));
END $function$;

-- Closes a jury turn whose review another path already ended (an archived business, 0326): by the review's end, as the jury
-- itself would have closed it. Used by turn_fusion_recovery; the relay calls the same rule (jury.ts) when it reads such a review.
CREATE OR REPLACE FUNCTION public.turn_fusion_ended_review(p_actor_id uuid, p_turn_id bigint, p_state text, p_outcome jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN CASE
    WHEN p_state IN ('incomplete','revision_failed') THEN
      turn_fusion_close(p_actor_id, p_turn_id, 'failed', false, true, 'review_' || coalesce(p_outcome->>'kind', p_state), '{}'::jsonb)
    WHEN p_state = 'completed' THEN
      turn_fusion_close(p_actor_id, p_turn_id, 'completed', p_outcome->>'kind' = 'revised', false, NULL, '{}'::jsonb)
    ELSE turn_fusion_close(p_actor_id, p_turn_id, 'interrupted', false, false, 'review_' || p_state, '{}'::jsonb) END;
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
  -- First, a review another path ended (its business archived: fusion_review_archive_reconcile ends it incomplete) while its
  -- turn is still open: the turn closes by the review's end, before the 24-hour end could charge it as expired. Incomplete
  -- or a failed revision refunds everything; a delivered revision pays the price; anything else is an interruption.
  FOR item IN SELECT t.actor_id, t.id, r.state, r.outcome FROM turns t
      JOIN fusion_reviews r ON r.id = (t.policy->>'reviewId')::uuid AND r.actor_id = t.actor_id
      WHERE t.state IN ('running','paused') AND t.kind = 'jury' AND r.state NOT IN ('running','paused')
      ORDER BY t.updated_at LIMIT p_limit LOOP
    BEGIN
      PERFORM turn_fusion_ended_review(item.actor_id, item.id, item.state, item.outcome);
      synced := synced + 1;
    EXCEPTION WHEN OTHERS THEN
      failed := failed + 1;
      RAISE WARNING 'turn_fusion_recovery ended review failed: turn % sqlstate %', item.id, SQLSTATE;
    END;
  END LOOP;
  FOR item IN SELECT actor_id, id FROM turns WHERE state = 'paused' AND updated_at < now() - interval '24 hours'
      AND kind = 'jury' AND pause_reason = 'awaiting_user' ORDER BY updated_at LIMIT p_limit LOOP
    BEGIN
      -- Locked in the close's own order (account, conversation, turn), then the condition read again: a relay that resumed the
      -- jury since the listing (its next group's begin) keeps it; only a turn still waiting 24 hours is ended.
      PERFORM 1 FROM profiles WHERE id = item.actor_id FOR UPDATE;
      PERFORM 1 FROM runtime_sessions WHERE actor_id = item.actor_id
        AND id = (SELECT session_id FROM turns WHERE actor_id = item.actor_id AND id = item.id) FOR UPDATE;
      IF NOT EXISTS (SELECT 1 FROM turns WHERE actor_id = item.actor_id AND id = item.id AND state = 'paused'
          AND pause_reason = 'awaiting_user' AND updated_at < now() - interval '24 hours' FOR UPDATE) THEN
        CONTINUE;
      END IF;
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
  FOR item IN SELECT r.actor_id, r.id, t.close_kind FROM fusion_reviews r JOIN turns t ON t.actor_id = r.actor_id AND t.id = r.turn_id
      WHERE r.state IN ('running','paused') AND r.turn_id IS NOT NULL AND t.state = 'closed' LIMIT p_limit LOOP
    UPDATE fusion_reviews SET state = CASE WHEN item.close_kind IN ('interrupted','expired') THEN 'interrupted' ELSE 'incomplete' END,
        outcome = coalesce(outcome, jsonb_build_object('kind', item.close_kind)), updated_at = clock_timestamp(), ended_at = clock_timestamp()
      WHERE actor_id = item.actor_id AND id = item.id AND state IN ('running','paused');
    synced := synced + 1;
  END LOOP;
  FOR item IN SELECT c.actor_id, c.id FROM fusion_compares c JOIN turns t ON t.actor_id = c.actor_id AND t.id = c.turn_id
      WHERE c.state = 'running' AND c.turn_id IS NOT NULL AND t.state = 'closed' LIMIT p_limit LOOP
    UPDATE fusion_compares SET state = 'finished', updated_at = clock_timestamp()
      WHERE actor_id = item.actor_id AND id = item.id AND state = 'running';
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
  carried integer := 0;
BEGIN
  IF p_kind NOT IN ('chat','mentor','report','compare','jury','jury_adopt','review') THEN
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
      PERFORM public.turn_close(p_actor_id, p_resume_of, 'failed', '[]'::jsonb, false, true, 'resumed');
      -- What it carries is not borne by the platform: only what the chain finally does not charge is recorded as absorbed.
      UPDATE turns SET absorbed_credits = greatest(absorbed_credits - carried, 0)
        WHERE actor_id = p_actor_id AND id = p_resume_of AND absorbed_credits IS NOT NULL;
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
      'positioned', public.opc_has_confirmed_positioning(p_actor_id),
      'refusals24h', (SELECT count(*) FROM turns r WHERE r.actor_id = p_actor_id AND r.failure_code = 'positioning_required'
        AND r.closed_at > now() - interval '24 hours')) END,
    -- Per-kind context for the prompt (2.7). Each kind reads its input from p_policy->'<kind>' and adds its own branch here
    -- (CASE p_kind WHEN '<kind>' THEN public.turn_<kind>_context(...) END); no kind has one yet.
    'kindContext', CASE p_kind WHEN 'mentor' THEN public.turn_mentor_context(p_actor_id, p_session_id, p_policy->'mentor') END);
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
  -- A model whose cost went above its bound is blocked until an administrator has checked its price and metering (BILL2).
  IF p_call_kind = 'model' AND EXISTS (SELECT 1 FROM turn_calls WHERE model_id = p_model_id AND budget_conflict
      AND conflict_reviewed_at IS NULL) THEN
    RAISE EXCEPTION 'TURN_MODEL_METERING_BLOCKED' USING ERRCODE='P0001';
  END IF;
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
  -- The remaining freeze must cover min(G_i, L): this call's bound G_i = ceil(q x U_i x m_i), or the start threshold L when the
  -- freeze was capped by the balance (H = min(G, A), Owner 10-01 and 10-28: a balance that covers one normal turn starts it; the
  -- part of a call above the freeze is the platform's, E = N - D). Below that the turn waits for credits. The positioning check
  -- is never charged to the user (Owner 10-12): it needs no freeze; its upper bound counts in U_turn and the stop-loss only.
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
  need := CASE WHEN p_call_kind = 'decision' OR t.kind = 'jury_adopt' THEN 0
    ELSE least(ceil(q * p_upper_usd * p_multiplier), coalesce((t.policy->>'minCredits')::numeric, ceil(q * p_upper_usd * p_multiplier))) END;
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
    IF EXISTS (SELECT 1 FROM turn_calls c WHERE c.turn_id = p_turn_id AND c.status = 'ok' AND c.usage->>'deliverable' = 'true')
      OR EXISTS (SELECT 1 FROM fusion_turn_outputs o WHERE o.turn_id = p_turn_id AND o.deliverable) THEN
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
      'callId',md5(c.turn_id::text||':'||c.seq::text)::uuid,'seq',c.seq,'modelId',c.model_id,
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

-- fusion_review_start(uuid,uuid,uuid,uuid,jsonb)
CREATE OR REPLACE FUNCTION public.fusion_review_start(p_actor_id uuid, p_request_id uuid, p_draft_id uuid, p_source_version_id uuid, p_config jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rv fusion_reviews; d opc_drafts; p artifact_projects; r artifact_rounds; ver artifact_versions; v jsonb;
  usage jsonb; m jsonb; h text;
BEGIN
 -- 0324 archived business guard
 IF true THEN BEGIN
   PERFORM opc_assert_business_writable(p_actor_id,jsonb_build_object('draftId',p_draft_id));
  EXCEPTION WHEN raise_exception THEN
   -- 0326 archived review replay repair
   IF SQLERRM<>'OPC_BUSINESS_ARCHIVED' THEN RAISE; END IF;
   PERFORM fusion_review_archive_reconcile(p_actor_id,jsonb_build_object('draftId',p_draft_id));
   IF EXISTS(SELECT 1 FROM fusion_reviews existing WHERE existing.actor_id=p_actor_id
    AND existing.request_id=p_request_id AND existing.draft_id=p_draft_id AND existing.source_version_id=p_source_version_id) THEN
    RETURN fusion_review_view((SELECT existing FROM fusion_reviews existing
     WHERE existing.actor_id=p_actor_id AND existing.request_id=p_request_id));
   END IF;
   RAISE;
  END; END IF;

 IF opc_draft_readonly(p_actor_id,p_draft_id) THEN RAISE EXCEPTION 'CONTENT_ERASED' USING ERRCODE='42501'; END IF; -- 0249 read-only
  PERFORM bill2_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('fusion-review:'||p_actor_id::text,0));
  SELECT * INTO rv FROM fusion_reviews WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF rv.id IS NOT NULL THEN
    IF rv.draft_id<>p_draft_id OR rv.source_version_id<>p_source_version_id THEN RAISE EXCEPTION 'FUSION_REVIEW_CONFLICT'; END IF;
    RETURN fusion_review_view(rv);
  END IF;
  IF jsonb_typeof(p_config) IS DISTINCT FROM 'object' OR coalesce(p_config->>'estimateUsd','')!~'^[0-9]+(\.[0-9]+)?$' THEN
    RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  v:=fusion_review_settings(p_actor_id);
  SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
  SELECT * INTO p FROM artifact_projects WHERE id=d.project_id FOR SHARE;
  -- Re-read the draft under the project lock, as opc_revise/report_revision do: a revise that committed
  -- meanwhile has moved the draft to a new round, which the freshness check below then refuses.
  SELECT * INTO d FROM opc_drafts WHERE draft_id=p_draft_id AND actor_id=p_actor_id;
  SELECT * INTO ver FROM artifact_versions WHERE id=p_source_version_id AND project_id=p.id AND erased_at IS NULL;
  SELECT * INTO r FROM artifact_rounds WHERE id=ver.round_id AND project_id=p.id;
  -- The same freshness rule as R14 propose: only the current formal version from a generated report.
  IF d.draft_id IS NULL OR p.id IS NULL OR ver.id IS NULL OR r.state IS DISTINCT FROM 'published' OR d.round_id IS DISTINCT FROM r.id
    OR ver.version IS DISTINCT FROM p.current_version OR NOT coalesce(ver.report ? 'generatedReport',false)
    OR NOT content_erasure_artifact_readable(p_actor_id,ver.id) THEN RAISE EXCEPTION 'FUSION_REVIEW_STALE'; END IF;
  IF fusion_compare_active(p_actor_id) OR EXISTS(SELECT 1 FROM fusion_reviews WHERE actor_id=p_actor_id AND state IN ('running','paused'))
    OR EXISTS(SELECT 1 FROM turns WHERE actor_id=p_actor_id AND kind='compare' AND state IN ('running','paused','stopping'))
    OR EXISTS(SELECT 1 FROM bill2_calls c JOIN bill2_runs br ON br.id=c.run_id WHERE br.actor_id=p_actor_id
      AND br.fusion_group_id IS NOT NULL AND fusion_call_in_flight(c)) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_ACTIVE'; END IF;
  usage:=fusion_review_breaker_usage(p_actor_id);
  IF (usage->>'noDeliveryCalls')::int>=coalesce((v#>>'{review,breaker,noDeliveryCalls}')::int,10)
    OR (usage->>'platformUsd')::numeric>=coalesce((v#>>'{review,breaker,platformUsd}')::numeric,2) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_BREAKER'; END IF;
  IF (SELECT count(*) FROM (SELECT state FROM fusion_reviews WHERE source_version_id=ver.id AND breaker_cleared_at IS NULL
      ORDER BY created_at DESC LIMIT 3) last3 WHERE state IN ('incomplete','revision_failed'))=3 THEN
    RAISE EXCEPTION 'FUSION_REVIEW_VERSION_BLOCKED'; END IF;
  IF coalesce(v#>>'{review,maxBudgetUsd}','')='' OR (p_config->>'estimateUsd')::numeric>(v#>>'{review,maxBudgetUsd}')::numeric THEN
    RAISE EXCEPTION 'FUSION_BUDGET_EXCEEDED'; END IF;
  SELECT coalesce(jsonb_object_agg(s.key,(SELECT coalesce(jsonb_object_agg(f.key,jsonb_build_object('value',f.value->'value',
      'status',f.value->'status')),'{}') FROM jsonb_each(coalesce(s.value->'information','{}')) f)),'{}')
    INTO m FROM jsonb_each(r.steps) s;
  h:=encode(sha256(convert_to(m::text,'UTF8')),'hex');
  INSERT INTO fusion_reviews(actor_id,request_id,draft_id,project_id,source_session_id,source_version_id,version_hash,
    materials,materials_hash,config,state,round,phase,attempt)
  VALUES(p_actor_id,p_request_id,d.draft_id,p.id,d.session_id,ver.id,ver.report_hash,m,h,p_config,'running',1,'review',1)
  RETURNING * INTO rv;
  -- 0294 fixed price. On the turn path (CORE-PATH-V2 V2-7b) the price is the jury turn's freeze (turn_fusion_open), not a fee.
  IF p_config->>'path' IS DISTINCT FROM 'turn' THEN PERFORM fusion_review_fee_hold(rv,v,p_config); END IF;
  RETURN fusion_review_view(rv);
END $function$;

-- fusion_review_claim(uuid,uuid,integer,text,integer,uuid,jsonb)
CREATE OR REPLACE FUNCTION public.fusion_review_claim(p_actor_id uuid, p_review_id uuid, p_round integer, p_phase text, p_attempt integer, p_group_id uuid, p_items jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rv fusion_reviews; g fusion_billing_groups; k text; res jsonb;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id FOR UPDATE;
  -- A review on the turn path is billed by its jury turn only (V2-7b): never through a BILL2 group.
  IF rv.id IS NULL OR rv.config->>'path' = 'turn' THEN RAISE EXCEPTION 'FUSION_REVIEW_DENIED'; END IF;
  IF rv.state NOT IN ('running','paused') THEN RAISE EXCEPTION 'FUSION_REVIEW_ENDED'; END IF;
  IF rv.round<>p_round OR rv.phase<>p_phase OR rv.attempt<>p_attempt THEN RAISE EXCEPTION 'FUSION_REVIEW_STEP_CONFLICT'; END IF;
  SELECT * INTO g FROM fusion_billing_groups WHERE id=p_group_id AND actor_id=p_actor_id;
  IF g.id IS NULL OR g.kind<>'review' OR g.source_session_id IS DISTINCT FROM rv.source_session_id THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  k:=format('review:%s:%s:%s',p_round,p_phase,p_attempt);
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(rv.steps) x WHERE x->>'stepKey'=k AND x->>'groupId'<>p_group_id::text) THEN
    RAISE EXCEPTION 'FUSION_REVIEW_STEP_CONFLICT'; END IF;
  -- 0294 fee marker
  IF EXISTS(SELECT 1 FROM fusion_review_fees WHERE review_id=rv.id) THEN
    IF fusion_review_gold(p_actor_id) IS NOT TRUE THEN RAISE EXCEPTION 'FUSION_MEMBERSHIP_REQUIRED'; END IF;
    UPDATE fusion_billing_groups SET fee_review_id=rv.id WHERE id=g.id AND fee_review_id IS NULL;
    IF (SELECT fee_review_id FROM fusion_billing_groups WHERE id=g.id) IS DISTINCT FROM rv.id THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  ELSIF (SELECT fee_review_id FROM fusion_billing_groups WHERE id=g.id) IS NOT NULL THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED';
  END IF;
  res:=fusion_group_claim(p_actor_id,p_group_id,k,1,p_items);
  -- Every successful claim (a replay too) resumes the review; the step is appended once.
  IF res->>'state'='claimed' THEN
    UPDATE fusion_reviews SET steps=CASE WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(steps) x WHERE x->>'stepKey'=k) THEN steps
      ELSE steps||jsonb_build_array(jsonb_build_object('round',p_round,'phase',p_phase,
      'attempt',p_attempt,'groupId',p_group_id,'stepKey',k,'claimedAt',clock_timestamp())) END,
      state='running',updated_at=clock_timestamp() WHERE id=rv.id;
  END IF;
  RETURN res;
END $function$;

-- fusion_review_close(uuid,uuid,text)
CREATE OR REPLACE FUNCTION public.fusion_review_close(p_actor_id uuid, p_review_id uuid, p_state text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE rv fusion_reviews; run record;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF p_state NOT IN ('stopped','interrupted') THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id AND actor_id=p_actor_id FOR UPDATE;
  -- A jury on the turn path has no stop or end button (Owner 10-28); its turn ends it (turn_fusion_close, 24-hour recovery).
  IF rv.id IS NULL OR rv.config->>'path' = 'turn' THEN RAISE EXCEPTION 'FUSION_REVIEW_DENIED'; END IF;
  IF rv.state NOT IN ('running','paused') THEN
    -- 0294 fee settle
    IF rv.state=p_state THEN PERFORM fusion_review_fee_settle_internal(rv.id); RETURN fusion_review_view(rv); END IF;
    RAISE EXCEPTION 'FUSION_REVIEW_ENDED';
  END IF;
  -- "End review" is for a paused review; a running one is stopped.
  IF p_state='interrupted' AND rv.state<>'paused' THEN RAISE EXCEPTION 'FUSION_REVIEW_STEP_CONFLICT'; END IF;
  UPDATE fusion_reviews SET state=p_state,updated_at=clock_timestamp(),ended_at=clock_timestamp() WHERE id=rv.id RETURNING * INTO rv;
  FOR run IN SELECT br.id,br.closed FROM bill2_runs br WHERE br.actor_id=p_actor_id
    AND br.fusion_group_id IN (SELECT (x->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) x) ORDER BY br.id LOOP
    IF NOT run.closed THEN PERFORM bill2_cancel(p_actor_id,run.id); END IF;
    PERFORM bill2_finalize(p_actor_id,run.id);
  END LOOP;
  PERFORM fusion_review_fee_settle_internal(rv.id);
  RETURN fusion_review_view(rv);
END $function$;

-- fusion_review_pause_idle(interval)
CREATE OR REPLACE FUNCTION public.fusion_review_pause_idle(p_idle interval)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE n integer;
BEGIN
  -- Never waits on a review row a claim, advance or close holds: those are skipped until the next run.
  UPDATE fusion_reviews rv SET state='paused',updated_at=clock_timestamp()
  -- Turn-path reviews wait on their jury turn instead (paused between groups, 24-hour recovery; V2-7b).
  WHERE rv.id IN (SELECT id FROM fusion_reviews WHERE state='running' AND turn_id IS NULL AND updated_at<=clock_timestamp()-p_idle
      ORDER BY updated_at LIMIT 500 FOR UPDATE SKIP LOCKED)
    AND rv.state='running' AND rv.updated_at<=clock_timestamp()-p_idle
    AND NOT EXISTS(SELECT 1 FROM bill2_runs br JOIN bill2_calls c ON c.run_id=br.id WHERE br.actor_id=rv.actor_id
      AND br.fusion_group_id IN (SELECT (x->>'groupId')::uuid FROM jsonb_array_elements(rv.steps) x)
      AND (fusion_call_in_flight(c) OR (c.dispatched_at IS NULL AND c.settled_at IS NULL)));
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n;
END $function$;

-- fusion_review_end_paused(interval,integer)
CREATE OR REPLACE FUNCTION public.fusion_review_end_paused(p_idle interval DEFAULT '24:00:00'::interval, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE cand record; rv fusion_reviews; ended integer:=0; failed integer:=0; skipped integer:=0;
BEGIN
  IF p_idle IS NULL OR p_idle<interval '1 hour' OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  -- Turn-path reviews are ended by turn_fusion_recovery (V2-7b).
  FOR cand IN SELECT id FROM fusion_reviews WHERE state='paused' AND turn_id IS NULL AND updated_at<=clock_timestamp()-p_idle
      ORDER BY updated_at,id LOOP
    -- p_limit bounds the reviews actually ended or failed in one run; a skipped review (locked, resumed, or waiting for its
    -- unjudged output to be judged) takes no place, so a stuck one in front never keeps the ones behind it from being ended.
    EXIT WHEN ended+failed>=p_limit;
    BEGIN
      -- Never waits on a review row a claim, advance or close holds: it is skipped until the next run. The state and the age
      -- are read again under the lock, because a claim may have resumed it (running, age restarted) since the listing.
      SELECT * INTO rv FROM fusion_reviews WHERE id=cand.id FOR UPDATE SKIP LOCKED;
      IF NOT FOUND OR rv.state<>'paused' OR rv.updated_at>clock_timestamp()-p_idle THEN skipped:=skipped+1; CONTINUE; END IF;
      IF EXISTS(SELECT 1 FROM jsonb_array_elements(rv.steps) x
          JOIN bill2_runs br ON br.fusion_group_id=(x->>'groupId')::uuid AND br.actor_id=rv.actor_id
          JOIN bill2_calls c ON c.run_id=br.id
          WHERE c.fusion_verdict IS NULL AND c.settled_at IS NULL
            AND EXISTS(SELECT 1 FROM fusion_call_outputs o WHERE o.call_id=c.id)) THEN skipped:=skipped+1; CONTINUE; END IF;
      -- The user's "end review": cancels and finalizes the review's runs, then settles the fixed fee (charge what the stop
      -- rule says was delivered, release the rest) with the settlement's conservation check.
      PERFORM fusion_review_close(rv.actor_id,rv.id,'interrupted');
      ended:=ended+1;
    EXCEPTION
      WHEN deadlock_detected OR lock_not_available THEN skipped:=skipped+1;
      WHEN OTHERS THEN
        -- Content-free: the review id and the error code only. The review stays paused and is tried again next run.
        failed:=failed+1;
        RAISE WARNING 'fusion_review_end_paused failed: review % sqlstate %',cand.id,SQLSTATE;
    END;
  END LOOP;
  RETURN jsonb_build_object('ended',ended,'failed',failed,'skipped',skipped);
END $function$;

-- account_erasure_scrub_turns(uuid)
CREATE OR REPLACE FUNCTION public.account_erasure_scrub_turns(p_profile_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  now_at timestamptz := clock_timestamp(); counts jsonb := '{}'; n bigint; session_ids uuid[];
  empty_hash text := encode(sha256(''::bytea), 'hex');
BEGIN
  IF p_profile_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id) THEN
    RAISE EXCEPTION 'ACCOUNT_ERASURE_NOT_CLOSED' USING ERRCODE = '42501';
  END IF;
  IF NOT public.account_erasure_barrier() THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  IF EXISTS (SELECT 1 FROM account_erasure_requests WHERE profile_id = p_profile_id
    AND confirmed_at >= transaction_timestamp()) THEN
    RETURN jsonb_build_object('retry', true, 'reason', 'transactions_pending');
  END IF;
  -- Turn writers lock the session first; skip a busy one and count what it holds as remaining.
  session_ids := ARRAY(SELECT id FROM runtime_sessions WHERE actor_id = p_profile_id FOR UPDATE SKIP LOCKED);

  DELETE FROM turn_call_raw r USING turn_calls c, turns t
   WHERE c.turn_id = r.turn_id AND c.seq = r.seq AND c.actor_id = p_profile_id
     AND t.actor_id = p_profile_id AND t.id = c.turn_id AND t.state = 'closed';
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('turn_call_raw', n);
  SELECT count(*) INTO n FROM turn_call_raw r JOIN turn_calls c ON c.turn_id = r.turn_id AND c.seq = r.seq
   WHERE c.actor_id = p_profile_id;
  counts := counts || jsonb_build_object('turn_call_raw_skipped', n);

  -- The saved review and compare answers (V2-7b): content, deleted with the rest of the account's turn content. They also go with
  -- their review or compare row (cascade); this covers an answer whose product row erasure removes later or not at all.
  DELETE FROM fusion_turn_outputs WHERE actor_id = p_profile_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('fusion_turn_outputs', n);

  UPDATE session_messages SET content = '', content_hash = empty_hash, visible = false, deleted_at = coalesce(deleted_at, now_at)
   WHERE session_id = ANY(session_ids) AND (content <> '' OR visible);
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('session_messages', n);
  SELECT count(*) INTO n FROM session_messages m JOIN runtime_sessions s ON s.id = m.session_id
   WHERE s.actor_id = p_profile_id AND (m.content <> '' OR m.visible);
  counts := counts || jsonb_build_object('session_messages_skipped', n);
  RETURN counts;
END $function$;

-- fusion_review_breaker_usage(uuid)
CREATE OR REPLACE FUNCTION public.fusion_review_breaker_usage(a uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  -- Platform-borne outcomes of the last 7 days (§3.3 breaker), on both paths: the BILL2 groups, and the compare and jury turns
  -- of CORE-PATH-V2 (V2-7b): calls that delivered nothing (a provider refusal, a 402, an answer refused under the fallback rule)
  -- and the provider cost of calls whose result was unusable or whose turn refunded everything.
  SELECT jsonb_build_object('noDeliveryCalls', o.n + t.n, 'platformUsd', o.usd + t.usd)
  FROM (SELECT count(*) FILTER (WHERE c.fusion_verdict='no_delivery') n,
    coalesce(sum(coalesce(c.selected_cost_usd,0)) FILTER (WHERE c.fusion_verdict IN
      ('no_delivery','format_invalid','revision_invalid','erased_before_verdict')
      OR EXISTS(SELECT 1 FROM fusion_review_fees fe WHERE fe.review_id=g.fee_review_id AND fe.state='refunded')),0) usd
    FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id LEFT JOIN fusion_billing_groups g ON g.id=r.fusion_group_id
    WHERE r.actor_id=a AND r.fusion_group_id IS NOT NULL AND c.created_at>=clock_timestamp()-interval '7 days') o,
  (SELECT count(*) FILTER (WHERE c.status IN ('rejected','no_charge_402')
      OR (c.status='unusable' AND c.usage->>'verdict'='no_delivery')) n,
    coalesce(sum(coalesce(c.actual_usd,c.nominal_usd,0)) FILTER (WHERE c.status='unusable'
      OR (c.status='ok' AND t.state='closed' AND t.charged_credits=0)),0) usd
    FROM turn_calls c JOIN turns t ON t.actor_id=c.actor_id AND t.id=c.turn_id
    WHERE c.actor_id=a AND t.kind IN ('compare','jury') AND c.call_kind='model'
      AND c.dispatched_at>=clock_timestamp()-interval '7 days') t;
$function$;

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
    'fusion_compare_turn_admit(uuid,uuid,integer,jsonb)',
    'fusion_review_turn_source(uuid,uuid,uuid,uuid)',
    'turn_fusion_recovery(integer)',
    'turn_fusion_ended_review(uuid,bigint,text,jsonb)',
    'turn_fusion_output(uuid,bigint,integer,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC, anon, authenticated, service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
