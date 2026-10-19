-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- BENCHMARK-SHORTFALL (Owner 2026-10-20, choice B): a positioning report with fewer than the required qualified
-- benchmarks, only when the user chose it (docs/launch/tasks/RESEARCH-TOOLS.md must-tests 6, 17).
--   * A "round" is one completed benchmark discovery of this session (research_discoveries, state 'completed'): a
--     keyword card the user confirmed, searched to the end of its plan by benchmark_discover. Discoveries still
--     running (stopped by the round limit or a balance pause), and those of a deleted answer or conversation, do
--     not count. Follow-up candidate cards and pasted profile links reuse or skip discovery and are not rounds.
--   * research_benchmark_shortfalls: the host's choice card. It is offered (research_benchmark_shortfall_offer)
--     only after at least 2 rounds while the session has at least 1 but fewer than the required qualified accounts;
--     the user answers it once (research_benchmark_shortfall_choose): who (actor), when (chosen_at) and how many
--     qualified accounts and rounds there were at that moment are frozen with the choice and never rewritten.
--   * report_admission_check: below the required count a report is admitted only when the session still has at
--     least 1 qualified account, at least 2 rounds, and a live "generate" choice. 0 qualified is always refused.
-- Erasure: deleting the answer or conversation that holds the card, and account erasure, delete it. Rows hold no
-- money and no content (ids, counts, times).
-- Compatibility: a new table and functions; old code never offers a card, so admission behaves as before (the extra
-- condition is false without a choice). Repeatable: IF NOT EXISTS, CREATE OR REPLACE, marker-skipped patches.
-- Recovery: restore report_admission_check, content_erasure_confirm and account_erasure_scrub_content from their
-- previous definitions, then drop the functions and the table (choices made are not needed by anything else).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE IF NOT EXISTS public.research_benchmark_shortfalls (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.profiles(id),
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id),
  execution_id uuid NOT NULL REFERENCES public.runtime_executions(id),
  required integer NOT NULL CHECK (required BETWEEN 3 AND 12),
  offered_qualified integer NOT NULL CHECK (offered_qualified>=1 AND offered_qualified<required),
  offered_rounds integer NOT NULL CHECK (offered_rounds>=2),
  choice text CHECK (choice IN ('continue','generate')),
  confirmation_id uuid UNIQUE, chosen_qualified integer CHECK (chosen_qualified>=0), chosen_rounds integer,
  chosen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((choice IS NULL)=(confirmation_id IS NULL) AND (choice IS NULL)=(chosen_at IS NULL)
    AND (choice IS NULL)=(chosen_qualified IS NULL) AND (choice IS NULL)=(chosen_rounds IS NULL))
);
CREATE INDEX IF NOT EXISTS research_benchmark_shortfalls_session_idx ON public.research_benchmark_shortfalls(session_id);
-- At most one unanswered card per session.
CREATE UNIQUE INDEX IF NOT EXISTS research_benchmark_shortfalls_open_idx ON public.research_benchmark_shortfalls(session_id)
  WHERE choice IS NULL;
ALTER TABLE public.research_benchmark_shortfalls ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_benchmark_shortfalls FROM PUBLIC,anon,authenticated,service_role;

-- Completed benchmark discoveries of this session's live answers (see "round" above).
CREATE OR REPLACE FUNCTION public.research_benchmark_rounds(a uuid, s uuid) RETURNS integer
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT count(*)::integer FROM research_discoveries d
  JOIN runtime_executions x ON x.id=d.execution_id AND x.actor_id=a AND x.session_id=s
  WHERE d.actor_id=a AND d.session_id=s AND d.state='completed' AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_view(b research_benchmark_shortfalls) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('cardId',b.id,'required',b.required,'offeredQualified',b.offered_qualified,
    'offeredRounds',b.offered_rounds,'choice',b.choice,'confirmationId',b.confirmation_id,
    'chosenQualified',b.chosen_qualified,'chosenRounds',b.chosen_rounds,'chosenAt',b.chosen_at,'createdAt',b.created_at)
$$;

-- The session's newest card on a live answer, or NULL.
CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_latest(a uuid, s uuid) RETURNS research_benchmark_shortfalls
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT b.* FROM research_benchmark_shortfalls b
  JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
  WHERE b.actor_id=a AND b.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
  ORDER BY b.created_at DESC,b.id DESC LIMIT 1
$$;

-- Whether a report below the required count is allowed: the user chose "generate" on a live card, and the session
-- still has at least 1 qualified account and at least 2 rounds. Re-read at every admission, never cached.
CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_accepted(a uuid, s uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT research_benchmark_qualified(a,s)>=1 AND research_benchmark_rounds(a,s)>=2
    AND EXISTS(SELECT 1 FROM research_benchmark_shortfalls b
      JOIN runtime_executions x ON x.id=b.execution_id AND x.actor_id=a AND x.session_id=s
      WHERE b.actor_id=a AND b.session_id=s AND b.choice='generate' AND x.content_deleted_at IS NULL AND x.erased_at IS NULL)
$$;

-- The tool's card (host-owned, free). Returns the session's open or "generate" card when there is one; otherwise
-- creates one only while it is due: positioning session, 1 <= qualified < required, at least 2 rounds, and (after a
-- "continue") at least one more round since that choice. Not due: RESEARCH_SHORTFALL_NOT_DUE, nothing written.
CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_offer(a uuid, s uuid, e uuid, p_card uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b research_benchmark_shortfalls; req integer; q integer; r integer;
BEGIN
  PERFORM research_session_owned(a,s,e);
  b:=research_benchmark_shortfall_latest(a,s);
  IF b.id IS NOT NULL AND (b.choice IS NULL OR b.choice='generate') THEN RETURN research_benchmark_shortfall_view(b);END IF;
  req:=research_benchmark_required((SELECT scope FROM runtime_sessions WHERE id=s),'{}'::jsonb);
  q:=research_benchmark_qualified(a,s);
  r:=research_benchmark_rounds(a,s);
  IF req=0 OR q<1 OR q>=req OR r<2 OR (b.id IS NOT NULL AND r<=b.chosen_rounds) THEN
    RAISE EXCEPTION 'RESEARCH_SHORTFALL_NOT_DUE';END IF;
  INSERT INTO research_benchmark_shortfalls(id,actor_id,session_id,execution_id,required,offered_qualified,offered_rounds)
  VALUES(p_card,a,s,e,req,q,r) ON CONFLICT DO NOTHING;
  SELECT * INTO b FROM research_benchmark_shortfalls WHERE id=p_card;
  IF b.id IS NULL OR b.actor_id<>a OR b.session_id<>s THEN RAISE EXCEPTION 'RESEARCH_CARD_CONFLICT';END IF;
  RETURN research_benchmark_shortfall_view(b);
END $$;

-- The user's answer, once. A repeat of the same answer returns the stored record; another answer is refused. The
-- qualified count and rounds at this moment are frozen with it.
CREATE OR REPLACE FUNCTION public.research_benchmark_shortfall_choose(a uuid, p_card uuid, p_choice text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b research_benchmark_shortfalls;
BEGIN
  SELECT * INTO b FROM research_benchmark_shortfalls WHERE id=p_card;
  IF b.id IS NULL OR b.actor_id<>a THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
  -- Session lock first (erasure order), then the card.
  PERFORM research_session_owned(a,b.session_id,b.execution_id);
  SELECT * INTO b FROM research_benchmark_shortfalls WHERE id=p_card FOR UPDATE;
  IF b.id IS NULL THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
  IF p_choice IS NULL OR p_choice NOT IN ('continue','generate') THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
  IF b.choice IS NOT NULL THEN
    IF b.choice<>p_choice THEN RAISE EXCEPTION 'RESEARCH_CARD_ALREADY_CONFIRMED';END IF;
    RETURN research_benchmark_shortfall_view(b);
  END IF;
  UPDATE research_benchmark_shortfalls SET choice=p_choice,confirmation_id=gen_random_uuid(),
    chosen_qualified=research_benchmark_qualified(a,b.session_id),chosen_rounds=research_benchmark_rounds(a,b.session_id),
    chosen_at=clock_timestamp()
  WHERE id=b.id RETURNING * INTO b;
  RETURN research_benchmark_shortfall_view(b);
END $$;

-- The page and the host context: the newest card with the session's current counts.
CREATE OR REPLACE FUNCTION public.research_user_shortfall(a uuid, s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE b research_benchmark_shortfalls;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  b:=research_benchmark_shortfall_latest(a,s);
  RETURN jsonb_build_object('rounds',research_benchmark_rounds(a,s),'qualified',research_benchmark_qualified(a,s),
    'card',CASE WHEN b.id IS NULL THEN NULL ELSE research_benchmark_shortfall_view(b) END);
END $$;

-- Report gate (0268): below the required count, only with an accepted shortfall choice.
DO $$ DECLARE definition text; t text; BEGIN
  definition:=pg_get_functiondef('public.report_admission_check(uuid,uuid,jsonb,jsonb)'::regprocedure);
  IF position('-- 0318 shortfall' IN definition)=0 THEN
    t:=$x$ IF research_benchmark_qualified(a,sid)<research_benchmark_required((SELECT scope FROM runtime_sessions WHERE id=sid),spec) THEN$x$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_SHORTFALL_SOURCE_MISMATCH: report_admission_check';END IF;
    EXECUTE replace(definition,t,$x$ IF research_benchmark_qualified(a,sid)<research_benchmark_required((SELECT scope FROM runtime_sessions WHERE id=sid),spec)
  -- 0318 shortfall: the user's frozen "generate" choice, with at least 1 qualified account and 2 rounds.
  AND NOT research_benchmark_shortfall_accepted(a,sid) THEN$x$);
  END IF;
END $$;

-- Content erasure: the card goes with its answer or conversation.
DO $$ DECLARE definition text; d text; BEGIN
  definition:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0318 shortfall' IN definition)=0 THEN
    d:=$x$ -- 0268 benchmarks: derived numbers go with their answer, conversation or evidence.$x$;
    IF array_length(string_to_array(definition,d),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_SHORTFALL_SOURCE_MISMATCH: content_erasure_confirm';END IF;
    EXECUTE replace(definition,d,$x$ -- 0318 shortfall: the choice card goes with its answer or conversation.
 DELETE FROM research_benchmark_shortfalls WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
$x$||d);
  END IF;
END $$;

DO $$ DECLARE definition text; r text; BEGIN
  definition:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
  IF position('-- 0318 shortfall' IN definition)=0 THEN
    r:=$x$  -- 0268 benchmarks$x$;
    IF array_length(string_to_array(definition,r),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_SHORTFALL_SOURCE_MISMATCH: account_erasure_scrub_content';END IF;
    EXECUTE replace(definition,r,$x$  -- 0318 shortfall
  DELETE FROM research_benchmark_shortfalls WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_benchmark_shortfalls_deleted',n);
$x$||r);
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.research_benchmark_rounds(uuid,uuid),
  public.research_benchmark_shortfall_view(research_benchmark_shortfalls),
  public.research_benchmark_shortfall_latest(uuid,uuid),public.research_benchmark_shortfall_accepted(uuid,uuid)
  FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.research_benchmark_shortfall_offer(uuid,uuid,uuid,uuid),
  public.research_benchmark_shortfall_choose(uuid,uuid,text),public.research_user_shortfall(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_benchmark_shortfall_offer(uuid,uuid,uuid,uuid),
  public.research_benchmark_shortfall_choose(uuid,uuid,text),public.research_user_shortfall(uuid,uuid) TO service_role;

COMMIT;
