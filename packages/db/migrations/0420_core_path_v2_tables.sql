-- Copyright (c) 2026 Grayscale Luminary LLC.
-- All rights reserved. This code is proprietary and confidential.
-- CORE-PATH-V2 V2-2 (number 0420 assigned by the controller): the tables of the new per-turn core path
-- (docs/launch/tasks/CORE-PATH-V2.md sections 2.2, 2.5, 2.5.1, 2.6, 3.3.2 and 5.1). A turn writes the database three ways only:
-- turn_open (one row in turns, a reservation in daily_spend), turn_call_record (one row per model/tool call in turn_calls, its raw
-- body in turn_call_raw) and turn_close (settlement, two rows in session_messages). The functions come in 0421 (V2-3).
--
-- Tables:
--   turns            one row per turn; the frozen policy, reservation and settlement; state machine opening/running/stopping/paused/closed
--   turn_calls       one receipt per model/tool call: nominal and actual cost, multiplier, usage (cache tokens), generation id
--   turn_call_raw    the raw provider body of a receipt, kept off the hot row (<= 256 KB; 30-day cleanup by the line G rule)
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
-- Compatibility: new tables and one new nullable column only; the old Runtime/BILL2 path never reads them and keeps working.
-- Nothing writes these tables until core_path_v2 is enabled (V2-4 onward). Repeatable: IF NOT EXISTS throughout.
-- Recovery: drop the five tables and runtime_sessions.active_turn_id; no existing object depends on them.
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
  reserved_credits integer NOT NULL DEFAULT 0 CHECK (reserved_credits >= 0),
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
  seq integer NOT NULL CHECK (seq >= 1),
  call_kind text NOT NULL CHECK (call_kind IN ('model','tool','decision')),
  model_id uuid,
  tool_name text CHECK (length(tool_name) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('ok','no_charge_402','unknown','unusable','rejected')),
  nominal_usd numeric(20,12) NOT NULL CHECK (nominal_usd >= 0),
  actual_usd numeric(20,12) CHECK (actual_usd >= 0),
  multiplier numeric(12,6) NOT NULL CHECK (multiplier > 0),
  usage jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(usage) = 'object' AND octet_length(usage::text) <= 16384),
  generation_id text CHECK (length(generation_id) BETWEEN 1 AND 200),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  cost_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (turn_id, seq),
  FOREIGN KEY (actor_id, turn_id) REFERENCES public.turns(actor_id, id),
  CHECK ((call_kind = 'tool') = (tool_name IS NOT NULL)),
  CHECK (call_kind = 'tool' OR model_id IS NOT NULL),
  CHECK (status <> 'no_charge_402' OR nominal_usd = 0),
  CHECK (NOT cost_pending OR actual_usd IS NULL)
);
CREATE INDEX IF NOT EXISTS turn_calls_cost_pending ON public.turn_calls (created_at) WHERE cost_pending;
CREATE INDEX IF NOT EXISTS turn_calls_created ON public.turn_calls (created_at);
CREATE INDEX IF NOT EXISTS turn_calls_actor_turn ON public.turn_calls (actor_id, turn_id);

CREATE TABLE IF NOT EXISTS public.turn_call_raw (
  turn_id bigint NOT NULL,
  seq integer NOT NULL,
  body text NOT NULL CHECK (octet_length(body) <= 262144),
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

COMMIT;
