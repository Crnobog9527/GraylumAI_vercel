-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-2 (number 0420 assigned by the controller): the tables of the new per-turn core path
-- (docs/launch/tasks/CORE-PATH-V2.md sections 2.2, 2.5, 2.5.1, 2.6, 3.3.2 and 5.1). A turn writes the database three ways only:
-- turn_open (one row in turns, a reservation in daily_spend), the call lifecycle (turn_call_begin inserts the receipt row before
-- the request is sent, turn_call_identity stores the provider id, turn_call_record the final usage and the raw body; section
-- 2.5.2) and turn_close (settlement, two rows in session_messages). The functions come in 0421 (V2-3).
--
-- Tables:
--   turns            one row per turn; the frozen policy, the user's reservation H (credits) and the platform bound U_turn
--                    (USD, also the stop-loss reservation), settlement; state machine opening/running/stopping/paused/closed
--   turn_calls       one row per call attempt: dispatched -> identified -> ok | unknown | not_sent | rejected | no_charge_402 | unusable;
--                    request hash and bound U_i before sending, provider id, nominal and actual cost, multiplier, usage (cache tokens)
--   turn_call_raw    the full provider response of a receipt, kept off the hot row (<= 4194304 bytes, the existing persisted
--                    receipt limit; 30-day cleanup by the line G rule)
--   session_messages the visible conversation history; visibility is maintained when content is deleted, never recomputed on read
--   daily_spend      the daily stop-loss in 16 actor buckets plus one row (-1) for large kinds: reserve at open, settle at close
-- runtime_sessions is kept (fewer renames); it gains active_turn_id. Its existing content_deleted_at (conversation deleted) and
-- erased_at (account erased) are the session tombstones the new functions read; no new deleted_at column.
--
-- Scale (section 3.3.2): every primary key leads with, or is, its owner key and every query of the new functions carries it:
-- turns (actor_id, id), turn_calls (turn_id, seq), turn_call_raw (turn_id, seq), session_messages (session_id, id); ids are
-- time-ordered bigint identities. When a table grows past some tens of millions of rows or its retention cleanup slows down,
-- it can be converted to PARTITION BY HASH(actor_id) / HASH(turn_id) / HASH(session_id) by an operational copy (create the
-- partitioned table, copy, rename): every unique key already contains the partition column, so no function or Node code changes.
-- Time columns (opened_at, created_at) have their own indexes for retention cleanup in batches. No row is shared by all users:
-- daily_spend spreads ordinary turns over 16 bucket rows by actor hash; bucket -1 is only for report/compare/jury/jury_adopt.
--
-- Account erasure: account_erasure_scrub_turns (wired into the erasure processor next to account_erasure_scrub_runtime) deletes
-- the raw provider bodies and empties the message text of the account's sessions; turns and turn_calls are billing records and
-- keep their billing fields for three years (plan section 4.6); deleting the session later removes the emptied messages.
-- Compatibility: new tables, one new nullable column and one new function; the old Runtime/BILL2 path never reads them.
-- Nothing writes these tables until core_path_v2 is enabled (V2-4 onward). Repeatable: IF NOT EXISTS throughout.
-- Recovery: drop account_erasure_scrub_turns (and its processor step), the five tables and runtime_sessions.active_turn_id.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.runtime_sessions ADD COLUMN IF NOT EXISTS active_turn_id bigint;

CREATE TABLE IF NOT EXISTS public.turns (
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  id bigint GENERATED ALWAYS AS IDENTITY,
  -- Account erasure deletes the session; the turn is financial evidence and stays (the reference becomes NULL).
  session_id uuid REFERENCES public.runtime_sessions(id) ON DELETE SET NULL,
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('chat','mentor','report','compare','jury','jury_adopt','review')),
  state text NOT NULL DEFAULT 'opening' CHECK (state IN ('opening','running','stopping','paused','closed')),
  pause_reason text CHECK (pause_reason IN ('waiting_credits','awaiting_user')),
  close_kind text CHECK (close_kind IN ('completed','stopped','failed','interrupted','expired','erased')),
  resume_of bigint,
  -- Frozen at turn_open: model, q, m, upper bound U_turn, stop-loss (day, bucket), tool allow-list hash, the two system
  -- segment hashes, voice source version, Skill package hash. Hashes and numbers only, never user text.
  policy jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(policy) = 'object' AND octet_length(policy::text) <= 65536),
  input_bytes integer CHECK (input_bytes >= 0),
  -- H: the user's frozen credits. U_turn: the platform's USD bound (the sum of U_i of the calls this turn may make), which is
  -- also what the turn reserves in daily_spend; they are different numbers (section 2.5).
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
  reserved_usd numeric(20,12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  charged_credits integer CHECK (charged_credits >= 0),
  absorbed_credits integer CHECK (absorbed_credits >= 0),
  settlement text CHECK (settlement IN ('pending','done')),
  stopped_by_user boolean NOT NULL DEFAULT false,
  delivered boolean NOT NULL DEFAULT false,
  failure_code text CHECK (length(failure_code) <= 120),
  opened_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  PRIMARY KEY (actor_id, id),
  UNIQUE (actor_id, request_id),
  FOREIGN KEY (actor_id, resume_of) REFERENCES public.turns(actor_id, id),
  CHECK ((state = 'paused') = (pause_reason IS NOT NULL)),
  CHECK ((state = 'closed') = (close_kind IS NOT NULL AND closed_at IS NOT NULL)),
  CHECK (stopped_by_user = false OR kind = 'report'),
  CHECK (close_kind IS DISTINCT FROM 'stopped' OR kind = 'report')
);
CREATE INDEX IF NOT EXISTS turns_session_opened ON public.turns (session_id, opened_at);
CREATE INDEX IF NOT EXISTS turns_live ON public.turns (state, updated_at) WHERE state IN ('running','paused','stopping');
CREATE INDEX IF NOT EXISTS turns_report_stops ON public.turns (actor_id, kind, closed_at) WHERE stopped_by_user;
CREATE INDEX IF NOT EXISTS turns_settlement_pending ON public.turns (updated_at) WHERE settlement = 'pending';
CREATE INDEX IF NOT EXISTS turns_opened ON public.turns (opened_at);

CREATE TABLE IF NOT EXISTS public.turn_calls (
  actor_id uuid NOT NULL,
  turn_id bigint NOT NULL,
  -- One row per attempt: a retried not_sent or rejected attempt is a new seq (at most two attempts per logical call).
  seq integer NOT NULL CHECK (seq >= 1),
  call_kind text NOT NULL CHECK (call_kind IN ('model','tool','decision')),
  model_id uuid,
  tool_name text CHECK (length(tool_name) BETWEEN 1 AND 80),
  status text NOT NULL DEFAULT 'dispatched' CHECK (status IN
    ('dispatched','identified','ok','unknown','not_sent','rejected','no_charge_402','unusable')),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  upper_usd numeric(20,12) NOT NULL CHECK (upper_usd >= 0),
  multiplier numeric(12,6) NOT NULL CHECK (multiplier > 0),
  provider_id text CHECK (length(provider_id) BETWEEN 1 AND 200),
  nominal_usd numeric(20,12) CHECK (nominal_usd >= 0),
  actual_usd numeric(20,12) CHECK (actual_usd >= 0),
  usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage) = 'object' AND octet_length(usage::text) <= 16384),
  payload_hash text CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  cost_pending boolean NOT NULL DEFAULT false,
  dispatched_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  PRIMARY KEY (turn_id, seq),
  FOREIGN KEY (actor_id, turn_id) REFERENCES public.turns(actor_id, id),
  CHECK ((call_kind = 'tool') = (tool_name IS NOT NULL)),
  CHECK (call_kind = 'tool' OR model_id IS NOT NULL),
  CHECK (status <> 'identified' OR provider_id IS NOT NULL),
  -- In flight: no cost yet. Final and known: a nominal cost. Certainly free: zero.
  CHECK (status NOT IN ('dispatched','identified') OR (nominal_usd IS NULL AND settled_at IS NULL)),
  CHECK (status <> 'ok' OR (nominal_usd IS NOT NULL AND settled_at IS NOT NULL)),
  CHECK (status NOT IN ('no_charge_402','not_sent','rejected','unusable') OR nominal_usd = 0),
  CHECK (NOT cost_pending OR (status = 'unknown' AND actual_usd IS NULL))
);
CREATE INDEX IF NOT EXISTS turn_calls_in_flight ON public.turn_calls (status, dispatched_at) WHERE status IN ('dispatched','identified');
CREATE INDEX IF NOT EXISTS turn_calls_cost_pending ON public.turn_calls (dispatched_at) WHERE cost_pending;
CREATE INDEX IF NOT EXISTS turn_calls_dispatched ON public.turn_calls (dispatched_at);
CREATE INDEX IF NOT EXISTS turn_calls_actor_turn ON public.turn_calls (actor_id, turn_id);

CREATE TABLE IF NOT EXISTS public.turn_call_raw (
  turn_id bigint NOT NULL,
  seq integer NOT NULL,
  body text NOT NULL CHECK (octet_length(body) <= 4194304),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq),
  FOREIGN KEY (turn_id, seq) REFERENCES public.turn_calls(turn_id, seq) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS turn_call_raw_created ON public.turn_call_raw (created_at);

CREATE TABLE IF NOT EXISTS public.session_messages (
  -- Conversation content: removed with its session (account erasure deletes the session).
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id) ON DELETE CASCADE,
  id bigint GENERATED ALWAYS AS IDENTITY,
  seq integer NOT NULL CHECK (seq >= 1),
  role text NOT NULL CHECK (role IN ('user','assistant')),
  turn_id bigint NOT NULL,
  content text NOT NULL CHECK (octet_length(content) <= 1048576),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  visible boolean NOT NULL DEFAULT true,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, id),
  UNIQUE (session_id, seq)
);
CREATE INDEX IF NOT EXISTS session_messages_history ON public.session_messages (session_id, seq DESC)
  WHERE visible AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS session_messages_turn ON public.session_messages (session_id, turn_id);

CREATE TABLE IF NOT EXISTS public.daily_spend (
  day date NOT NULL,
  bucket smallint NOT NULL CHECK (bucket BETWEEN -1 AND 15),
  reserved_usd numeric(20,12) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  spent_usd numeric(20,12) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  PRIMARY KEY (day, bucket)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['turns','turn_calls','turn_call_raw','session_messages','daily_spend'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
  END LOOP;
END $$;

-- Account erasure for the core-path tables (DATA-ERASURE; controller 10-28: option A, V2-9 completes it). Same guards and lock
-- discipline as account_erasure_scrub_runtime: only after confirmation in an earlier transaction, never waits on a busy session.
-- Removes: the raw provider bodies of the account's closed turns, and the text of the messages in the account's sessions.
-- Keeps: turns and turn_calls, the billing records (three years, plan 4.6); a turn still open keeps its raw bodies until it
-- closes and is counted as remaining. Repeating it changes nothing further.
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

  UPDATE session_messages SET content = '', content_hash = empty_hash, visible = false, deleted_at = coalesce(deleted_at, now_at)
   WHERE session_id = ANY(session_ids) AND (content <> '' OR visible);
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('session_messages', n);
  SELECT count(*) INTO n FROM session_messages m JOIN runtime_sessions s ON s.id = m.session_id
   WHERE s.actor_id = p_profile_id AND (m.content <> '' OR m.visible);
  counts := counts || jsonb_build_object('session_messages_skipped', n);
  RETURN counts;
END $function$;
REVOKE ALL ON FUNCTION public.account_erasure_scrub_turns(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.account_erasure_scrub_turns(uuid) TO service_role;

COMMIT;
