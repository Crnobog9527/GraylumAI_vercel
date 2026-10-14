-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS RT-3b (storage): host-owned records for the research tools
-- (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md §1.2, §1.6, §4.3, §6.1 RT-3).
--   * research_selection_cards: keyword and candidate cards with a write-once user confirmation.
--   * research_discoveries: one discovery per keyword confirmation, with its resumable cursor.
--   * research_account_fetches: "one paid fetch per platform + account per session", including attempts
--     whose result is unknown; a new paid fetch needs a one-time research_refresh_grants row, marked used
--     before any request is sent.
--   * research_plans / research_operations gain links to the session, answer, discovery and BILL2 call, so
--     evidence from conversation searches (which have no artifact) is found by conversation and answer deletion.
-- Erasure: deleting a conversation or an answer, and account erasure, delete these rows and clear linked
-- evidence text (only the cost key stays). A runtime research operation counts as finished once its BILL2
-- call is settled: the user side is already final, while the call keeps its supplier-cost state, bound and
-- metering flags (bill2_calls is never cleared by content erasure).
-- Function patches follow packages/db/tests/content-erasure/md5-chain.mjs: text-marker patches only.
-- Compatibility: new tables and nullable columns; nothing reads them until RT-3b wiring. Repeatable: IF NOT
-- EXISTS, CREATE OR REPLACE, marker-skipped patches. Recovery: the rows hold no money; drop the functions and
-- tables, and restore the patched functions from their previous definitions.
BEGIN;
SET LOCAL lock_timeout='5s';

ALTER TABLE public.research_plans ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES public.runtime_sessions(id);
ALTER TABLE public.research_plans ADD COLUMN IF NOT EXISTS execution_id uuid REFERENCES public.runtime_executions(id);
ALTER TABLE public.research_plans ADD COLUMN IF NOT EXISTS discovery_id uuid;
ALTER TABLE public.research_operations ADD COLUMN IF NOT EXISTS bill2_call_id uuid REFERENCES public.bill2_calls(id);
CREATE INDEX IF NOT EXISTS research_plans_session_idx ON public.research_plans(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS research_plans_execution_idx ON public.research_plans(execution_id) WHERE execution_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS research_operations_call_idx ON public.research_operations(bill2_call_id) WHERE bill2_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.research_selection_cards (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.profiles(id),
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id),
  execution_id uuid NOT NULL REFERENCES public.runtime_executions(id),
  kind text NOT NULL CHECK (kind IN ('keywords','candidates')),
  discovery_id uuid,
  options jsonb NOT NULL CHECK (jsonb_typeof(options)='array' AND jsonb_array_length(options) BETWEEN 1 AND 24
    AND octet_length(options::text)<=16384),
  min_select integer NOT NULL, max_select integer NOT NULL,
  confirmation_id uuid UNIQUE, confirmed_items jsonb, confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (min_select BETWEEN 1 AND max_select AND max_select<=12),
  CHECK ((confirmation_id IS NULL)=(confirmed_items IS NULL) AND (confirmation_id IS NULL)=(confirmed_at IS NULL)),
  CHECK (kind='keywords' OR discovery_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS research_cards_session_idx ON public.research_selection_cards(session_id);
CREATE TABLE IF NOT EXISTS public.research_discoveries (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.profiles(id),
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id),
  execution_id uuid NOT NULL REFERENCES public.runtime_executions(id),
  keyword_confirmation_id uuid NOT NULL UNIQUE,
  platforms text[] NOT NULL CHECK (cardinality(platforms) BETWEEN 1 AND 2),
  keywords jsonb NOT NULL CHECK (jsonb_typeof(keywords)='array'),
  cursor jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(cursor)='object' AND octet_length(cursor::text)<=65536),
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','completed')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_discoveries_session_idx ON public.research_discoveries(session_id);
CREATE TABLE IF NOT EXISTS public.research_account_fetches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES public.profiles(id),
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id),
  execution_id uuid NOT NULL REFERENCES public.runtime_executions(id),
  platform text NOT NULL CHECK (platform ~ '^[a-z]{1,20}$'),
  account text NOT NULL CHECK (length(account) BETWEEN 1 AND 200),
  -- prepared: claimed, nothing sent yet (a crash here leaves it reclaimable); in_progress: marked sent, never resent.
  state text NOT NULL CHECK (state IN ('prepared','in_progress','succeeded','unknown','failed')),
  attempt uuid NOT NULL DEFAULT gen_random_uuid(),
  evidence jsonb CHECK (evidence IS NULL OR (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=8192)),
  -- The last successful (paid) evidence; a later refresh replaces it only when that refresh succeeds.
  last_success jsonb CHECK (last_success IS NULL OR (jsonb_typeof(last_success)='object' AND octet_length(last_success::text)<=8192)),
  last_success_execution_id uuid REFERENCES public.runtime_executions(id),
  -- The refresh grant a prepared attempt consumed; retrying with it after a crash takes the attempt over.
  refresh_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, platform, account)
);
CREATE TABLE IF NOT EXISTS public.research_refresh_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES public.profiles(id),
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id),
  platform text NOT NULL, account text NOT NULL,
  used_at timestamptz, used_execution_id uuid REFERENCES public.runtime_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((used_at IS NULL)=(used_execution_id IS NULL))
);
CREATE INDEX IF NOT EXISTS research_refresh_session_idx ON public.research_refresh_grants(session_id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['research_selection_cards','research_discoveries','research_account_fetches','research_refresh_grants'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated,service_role',t);
  END LOOP;
END $$;

-- The caller's own, live session and (when given) an execution of it; deleted or erased ones are refused.
-- Same lock order as content_erasure_confirm / content_erasure_mark_session (profile, session, execution): the share
-- locks conflict with their update locks, so a write either commits before a deletion takes its locks (and is then
-- cleaned by it) or waits and sees the deletion marker here.
CREATE OR REPLACE FUNCTION public.research_session_owned(a uuid, s uuid, e uuid) RETURNS void
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  -- Lock first, then check: an account closed while we waited for the lock is refused here.
  PERFORM id FROM profiles WHERE id=a FOR SHARE;
  PERFORM bill2_actor(a);
  PERFORM id FROM runtime_sessions WHERE id=s AND actor_id=a FOR SHARE;
  IF e IS NOT NULL THEN PERFORM id FROM runtime_executions WHERE id=e AND actor_id=a FOR SHARE;END IF;
  IF NOT EXISTS(SELECT 1 FROM runtime_sessions x WHERE x.id=s AND x.actor_id=a AND x.content_deleted_at IS NULL AND x.erased_at IS NULL)
   OR (e IS NOT NULL AND NOT EXISTS(SELECT 1 FROM runtime_executions x WHERE x.id=e AND x.session_id=s AND x.actor_id=a
     AND x.content_deleted_at IS NULL AND x.erased_at IS NULL))
  THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
END $$;

-- A research operation is finished for erasure once the user side is final: a terminal state, or (for a runtime
-- search) its BILL2 call is settled. The call itself keeps its supplier-cost state and bound for reconciliation.
CREATE OR REPLACE FUNCTION public.research_operation_settled(o research_operations) RETURNS boolean
LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT o.state IN ('succeeded','failed','cancelled')
    OR (o.bill2_call_id IS NOT NULL AND o.state IN ('prepared','dispatched','unknown')
      AND EXISTS(SELECT 1 FROM bill2_calls c WHERE c.id=o.bill2_call_id AND c.settled_at IS NOT NULL))
$$;

CREATE OR REPLACE FUNCTION public.research_card_create(a uuid, p_card uuid, s uuid, e uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c research_selection_cards; o jsonb; k text:=p->>'kind'; n integer:=0;
BEGIN
  PERFORM research_session_owned(a,s,e);
  IF k NOT IN ('keywords','candidates') OR jsonb_typeof(p->'options') IS DISTINCT FROM 'array'
   OR p-ARRAY['kind','options','discoveryId','minSelect','followUp']<>'{}'::jsonb THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
  FOR o IN SELECT value FROM jsonb_array_elements(p->'options') LOOP
    IF coalesce(o->>'id','') !~ '^[a-z0-9]{1,8}$' THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
    IF k='keywords' AND (o-ARRAY['id','text']<>'{}'::jsonb OR char_length(coalesce(o->>'text',''))
      NOT BETWEEN 1 AND 40 OR o->>'text' ~ '[[:cntrl:]]') THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
    IF k='candidates' AND (o-ARRAY['id','platform','account','evidenceRef','label','selectable']<>'{}'::jsonb
      OR coalesce(o->>'platform','') !~ '^[a-z]{1,20}$' OR char_length(coalesce(o->>'account','')) NOT BETWEEN 1 AND 200
      OR jsonb_typeof(o->'selectable') IS DISTINCT FROM 'boolean' OR coalesce(o->>'evidenceRef','') !~ '^[A-Za-z0-9._:#-]{1,120}$')
    THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
    IF k='keywords' OR (o->'selectable')='true'::jsonb THEN n:=n+1;END IF;
  END LOOP;
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p->'options') x)<>jsonb_array_length(p->'options')
   -- A first candidate card needs 8–12 selectable accounts (fewer: no card, the tool returns partial); only a
   -- follow-up card (followUp) from already found candidates may offer fewer and ask for a smaller minimum.
   OR (k='keywords' AND n NOT BETWEEN 3 AND 5)
   OR (k='candidates' AND p->'followUp' IS DISTINCT FROM 'true'::jsonb AND n NOT BETWEEN 8 AND 12)
   OR (k='candidates' AND n NOT BETWEEN 1 AND 12)
   OR (p ? 'followUp' AND (k<>'candidates' OR jsonb_typeof(p->'followUp')<>'boolean'))
   OR (k='candidates' AND NOT EXISTS(SELECT 1 FROM research_discoveries d WHERE d.id=(p->>'discoveryId')::uuid AND d.session_id=s))
   OR (p ? 'minSelect' AND (k<>'candidates' OR p->'followUp' IS DISTINCT FROM 'true'::jsonb OR coalesce(p->>'minSelect','') !~ '^[1-3]$'))
  THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
  INSERT INTO research_selection_cards(id,actor_id,session_id,execution_id,kind,discovery_id,options,min_select,max_select)
  -- A first candidate card asks for 3–5 picks (fewer only when fewer are offered); a follow-up card may name a
  -- smaller minimum (minSelect) for the accounts still missing.
  VALUES(p_card,a,s,e,k,CASE WHEN k='candidates' THEN (p->>'discoveryId')::uuid END,p->'options',
    CASE WHEN k='keywords' THEN 1 ELSE least(n,coalesce((p->>'minSelect')::int,3)) END,CASE WHEN k='keywords' THEN 5 ELSE least(n,5) END)
  ON CONFLICT (id) DO NOTHING;
  SELECT * INTO c FROM research_selection_cards WHERE id=p_card;
  IF c.actor_id<>a OR c.session_id<>s OR c.options IS DISTINCT FROM p->'options' THEN RAISE EXCEPTION 'RESEARCH_CARD_CONFLICT';END IF;
  RETURN jsonb_build_object('cardId',c.id,'kind',c.kind,'options',c.options,'minSelect',c.min_select,'maxSelect',c.max_select);
END $$;

-- The user's own submission, once. Keyword cards accept selection, edits and additions; candidate cards accept
-- option ids only, and every account comes back from the host's own option (never from the submission).
CREATE OR REPLACE FUNCTION public.research_card_confirm(a uuid, p_card uuid, p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c research_selection_cards; items jsonb:='[]'; opt text; t text;
BEGIN
  -- Session lock first (erasure order), then the card.
  SELECT * INTO c FROM research_selection_cards WHERE id=p_card;
  IF c.id IS NULL OR c.actor_id<>a THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
  PERFORM research_session_owned(a,c.session_id,NULL);
  SELECT * INTO c FROM research_selection_cards WHERE id=p_card FOR UPDATE;
  IF c.id IS NULL THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
  IF jsonb_typeof(p->'selected') IS DISTINCT FROM 'array' OR p-ARRAY['selected','edits','additions']<>'{}'::jsonb
   OR (c.kind='candidates' AND (p ? 'edits' OR p ? 'additions')) THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p->'selected') v WHERE jsonb_typeof(v)<>'string'
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(c.options) o WHERE o->>'id'=v#>>'{}')) THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
  -- Confirmed items follow the card's own option order, not the submission order.
  FOR opt IN SELECT o->>'id' FROM jsonb_array_elements(c.options) WITH ORDINALITY x(o,i) WHERE (p->'selected') ? (o->>'id') ORDER BY i LOOP
    SELECT x INTO STRICT t FROM (SELECT o::text x FROM jsonb_array_elements(c.options) o WHERE o->>'id'=opt) z;
    IF c.kind='keywords' THEN
      t:=btrim(coalesce(p->'edits'->>opt,(t::jsonb)->>'text'));
      items:=items||to_jsonb(t);
    ELSE
      IF ((t::jsonb)->'selectable') IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
      items:=items||jsonb_build_array((t::jsonb)-ARRAY['label','selectable']);
    END IF;
  END LOOP;
  IF c.kind='keywords' THEN
    IF jsonb_typeof(coalesce(p->'additions','[]')) IS DISTINCT FROM 'array'
     OR (p ? 'edits' AND (jsonb_typeof(p->'edits') IS DISTINCT FROM 'object'
       OR EXISTS(SELECT 1 FROM jsonb_object_keys(p->'edits') k WHERE NOT (p->'selected') ? k)))
    THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
    FOR t IN SELECT btrim(value) FROM jsonb_array_elements_text(coalesce(p->'additions','[]')) LOOP items:=items||to_jsonb(t);END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(items) v WHERE char_length(v) NOT BETWEEN 1 AND 40 OR v ~ '[[:cntrl:]]')
     OR (SELECT count(DISTINCT lower(v)) FROM jsonb_array_elements_text(items) v)<>jsonb_array_length(items)
    THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
  END IF;
  IF jsonb_array_length(items) NOT BETWEEN c.min_select AND c.max_select THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';END IF;
  IF c.confirmation_id IS NOT NULL THEN
    IF c.confirmed_items IS DISTINCT FROM items THEN RAISE EXCEPTION 'RESEARCH_CARD_ALREADY_CONFIRMED';END IF;
  ELSE
    UPDATE research_selection_cards SET confirmation_id=gen_random_uuid(),confirmed_items=items,confirmed_at=clock_timestamp()
    WHERE id=c.id RETURNING * INTO c;
  END IF;
  RETURN jsonb_build_object('cardId',c.id,'confirmationId',c.confirmation_id,'kind',c.kind,'items',c.confirmed_items);
EXCEPTION WHEN no_data_found OR invalid_text_representation THEN RAISE EXCEPTION 'RESEARCH_CARD_INVALID';
END $$;

-- What a tool may rely on: a confirmation of this user's live session, by its confirmation id.
CREATE OR REPLACE FUNCTION public.research_confirmation_read(a uuid, s uuid, p_confirmation uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c research_selection_cards;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT * INTO c FROM research_selection_cards WHERE confirmation_id=p_confirmation AND actor_id=a AND session_id=s;
  IF c.id IS NULL THEN RETURN NULL;END IF;
  RETURN jsonb_build_object('kind',c.kind,'discoveryId',c.discovery_id,'items',c.confirmed_items);
END $$;

-- The user's own message in this session: the input of one of its answers.
CREATE OR REPLACE FUNCTION public.research_user_message(a uuid, s uuid, e uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  RETURN (SELECT x.payload->>'input' FROM runtime_executions x WHERE x.id=e AND x.session_id=s AND x.actor_id=a
    AND x.content_deleted_at IS NULL AND x.erased_at IS NULL);
END $$;

CREATE OR REPLACE FUNCTION public.research_discovery_start(a uuid, s uuid, e uuid, p_confirmation uuid, p_platforms text[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c research_selection_cards; d research_discoveries;
BEGIN
  PERFORM research_session_owned(a,s,e);
  SELECT * INTO c FROM research_selection_cards WHERE confirmation_id=p_confirmation AND actor_id=a AND session_id=s AND kind='keywords';
  IF c.id IS NULL THEN RAISE EXCEPTION 'RESEARCH_NOT_CONFIRMED';END IF;
  -- Each platform once: a repeated one would pay for the same searches twice.
  IF cardinality(p_platforms) NOT BETWEEN 1 AND 2 OR EXISTS(SELECT 1 FROM unnest(p_platforms) x WHERE x !~ '^[a-z]{1,20}$')
   OR (SELECT count(DISTINCT x) FROM unnest(p_platforms) x)<>cardinality(p_platforms) THEN RAISE EXCEPTION 'RESEARCH_DISCOVERY_INVALID';END IF;
  INSERT INTO research_discoveries(id,actor_id,session_id,execution_id,keyword_confirmation_id,platforms,keywords)
  VALUES(gen_random_uuid(),a,s,e,p_confirmation,p_platforms,c.confirmed_items) ON CONFLICT (keyword_confirmation_id) DO NOTHING;
  SELECT * INTO d FROM research_discoveries WHERE keyword_confirmation_id=p_confirmation;
  IF d.platforms IS DISTINCT FROM p_platforms THEN RAISE EXCEPTION 'RESEARCH_DISCOVERY_CONFLICT';END IF;
  RETURN jsonb_build_object('discoveryId',d.id,'keywords',d.keywords,'platforms',to_jsonb(d.platforms),'cursor',d.cursor,'state',d.state);
END $$;

CREATE OR REPLACE FUNCTION public.research_discovery_save(a uuid, s uuid, p_discovery uuid, p_cursor jsonb, p_state text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE d research_discoveries;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  UPDATE research_discoveries SET cursor=p_cursor,state=p_state,updated_at=clock_timestamp()
  WHERE id=p_discovery AND actor_id=a AND session_id=s AND state='running' RETURNING * INTO d;
  IF d.id IS NULL THEN
    SELECT * INTO d FROM research_discoveries WHERE id=p_discovery AND actor_id=a AND session_id=s;
    IF d.id IS NULL THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
  END IF;
  RETURN jsonb_build_object('discoveryId',d.id,'keywords',d.keywords,'platforms',to_jsonb(d.platforms),'cursor',d.cursor,'state',d.state);
END $$;

-- One paid fetch per platform + account per session. A claim is `prepared` until research_account_fetch_dispatch
-- marks it sent (`in_progress`); a prepared claim left by a crash may be claimed again (new attempt token, so the old
-- one can never send). A sent attempt is never sent twice; an earlier success is reused (also after a refresh that
-- failed or ended unknown); an unknown result without an earlier success is never resent. A one-time refresh grant,
-- consumed here before any request, starts a new paid fetch. A confirmed free failure without an earlier success
-- may be retried.
CREATE OR REPLACE FUNCTION public.research_account_fetch_claim(a uuid, s uuid, e uuid, p_platform text, p_account text, p_refresh uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f research_account_fetches; g research_refresh_grants;
BEGIN
  PERFORM research_session_owned(a,s,e);
  INSERT INTO research_account_fetches(actor_id,session_id,execution_id,platform,account,state)
  VALUES(a,s,e,p_platform,p_account,'prepared') ON CONFLICT (session_id,platform,account) DO NOTHING RETURNING * INTO f;
  IF f.id IS NOT NULL THEN
    IF p_refresh IS NOT NULL THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;
    RETURN jsonb_build_object('claimed',true,'fetchId',f.id,'attempt',f.attempt);
  END IF;
  SELECT * INTO f FROM research_account_fetches WHERE session_id=s AND platform=p_platform AND account=p_account FOR UPDATE;
  IF p_refresh IS NOT NULL THEN
    SELECT * INTO g FROM research_refresh_grants WHERE id=p_refresh AND actor_id=a AND session_id=s FOR UPDATE;
    IF g.id IS NULL OR g.platform<>p_platform OR g.account<>p_account THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;
    -- A grant used by an attempt that never got sent (crash before dispatch) may claim that attempt again.
    IF g.used_at IS NOT NULL AND NOT (f.state='prepared' AND f.refresh_id=g.id) THEN RAISE EXCEPTION 'RESEARCH_REFRESH_USED';END IF;
    IF f.state='in_progress' OR (f.state='prepared' AND f.refresh_id IS DISTINCT FROM g.id) THEN
      RETURN jsonb_build_object('claimed',false,'fetchId',f.id,'state',f.state,'evidence',f.last_success);END IF;
    UPDATE research_refresh_grants SET used_at=coalesce(used_at,clock_timestamp()),used_execution_id=coalesce(used_execution_id,e) WHERE id=g.id;
  ELSIF f.state='in_progress' OR (f.state<>'prepared' AND (f.last_success IS NOT NULL OR f.state<>'failed')) THEN
    RETURN jsonb_build_object('claimed',false,'fetchId',f.id,'state',f.state,'evidence',f.last_success);
  END IF;
  -- Every paid attempt gets its own token, so a late result of an earlier attempt can never finish this one.
  UPDATE research_account_fetches SET state='prepared',execution_id=e,evidence=NULL,attempt=gen_random_uuid(),refresh_id=p_refresh,
    updated_at=clock_timestamp() WHERE id=f.id RETURNING * INTO f;
  RETURN jsonb_build_object('claimed',true,'fetchId',f.id,'attempt',f.attempt);
END $$;

-- Marks the attempt sent, immediately before the supplier request. Only the latest attempt can be sent, once.
CREATE OR REPLACE FUNCTION public.research_account_fetch_dispatch(a uuid, p_fetch uuid, p_attempt uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f research_account_fetches;
BEGIN
  SELECT * INTO f FROM research_account_fetches WHERE id=p_fetch AND actor_id=a;
  IF f.id IS NULL THEN RETURN false;END IF;
  -- Same checks and locks as every write: a closed account or a deleted conversation sends nothing.
  PERFORM research_session_owned(a,f.session_id,NULL);
  UPDATE research_account_fetches SET state='in_progress',updated_at=clock_timestamp()
  WHERE id=p_fetch AND actor_id=a AND attempt=p_attempt AND state='prepared';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.research_account_fetch_finish(a uuid, p_fetch uuid, p_attempt uuid, p_state text, p_evidence jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  -- A success must carry its evidence: a paid result without it could be neither reused nor refreshed.
  IF p_state NOT IN ('succeeded','unknown','failed') OR (p_state='succeeded' AND jsonb_typeof(p_evidence) IS DISTINCT FROM 'object')
  THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
  -- A sent attempt ends in any state; an attempt never sent can only end as a (free) failure.
  UPDATE research_account_fetches SET state=p_state,evidence=p_evidence,updated_at=clock_timestamp(),
    last_success=CASE WHEN p_state='succeeded' THEN p_evidence ELSE last_success END,
    last_success_execution_id=CASE WHEN p_state='succeeded' THEN execution_id ELSE last_success_execution_id END
  WHERE id=p_fetch AND actor_id=a AND attempt=p_attempt AND (state='in_progress' OR (state='prepared' AND p_state='failed'));
  IF NOT FOUND AND NOT EXISTS(SELECT 1 FROM research_account_fetches WHERE id=p_fetch AND actor_id=a AND attempt=p_attempt
    AND state=p_state AND evidence IS NOT DISTINCT FROM p_evidence) THEN RAISE EXCEPTION 'RESEARCH_FETCH_CONFLICT';END IF;
END $$;

-- The "refresh" button: only for an account this session has fetched successfully before (also after a refresh that
-- failed or ended unknown), and not while a fetch of it is in progress.
CREATE OR REPLACE FUNCTION public.research_refresh_create(a uuid, s uuid, p_platform text, p_account text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g uuid;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  IF NOT EXISTS(SELECT 1 FROM research_account_fetches WHERE session_id=s AND actor_id=a AND platform=p_platform
    AND account=p_account AND last_success IS NOT NULL AND state NOT IN ('prepared','in_progress')) THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;
  INSERT INTO research_refresh_grants(actor_id,session_id,platform,account) VALUES(a,s,p_platform,p_account) RETURNING id INTO g;
  RETURN g;
END $$;

-- Links a research plan to its session, answer and discovery, and an operation to its BILL2 call; links never move.
CREATE OR REPLACE FUNCTION public.research_runtime_link(a uuid, p_plan uuid, s uuid, e uuid, p_discovery uuid, p_operation uuid, p_call uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p research_plans;
BEGIN
  PERFORM research_session_owned(a,s,e);
  SELECT * INTO p FROM research_plans WHERE id=p_plan AND actor_id=a FOR UPDATE;
  IF p.id IS NULL OR (p.session_id IS NOT NULL AND (p.session_id,p.execution_id,p.discovery_id) IS DISTINCT FROM (s,e,p_discovery))
  THEN RAISE EXCEPTION 'RESEARCH_LINK_CONFLICT';END IF;
  UPDATE research_plans SET session_id=s,execution_id=e,discovery_id=p_discovery WHERE id=p.id AND session_id IS NULL;
  IF p_operation IS NOT NULL THEN
    -- The operation and its BILL2 call describe the same supplier request: the call's requestHash is the
    -- operation's identity hash, so an operation can never be tied to another subcall of the same answer.
    IF NOT EXISTS(SELECT 1 FROM research_operations o JOIN bill2_calls c ON c.id=p_call
      WHERE o.id=p_operation AND o.plan_id=p.id AND c.payload->>'requestHash'=o.identity_hash)
     OR NOT EXISTS(SELECT 1 FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id JOIN runtime_executions x ON x.billing_run_id=r.id
       WHERE c.id=p_call AND r.actor_id=a AND c.call_kind='tool' AND x.id=e)
    THEN RAISE EXCEPTION 'RESEARCH_LINK_CONFLICT';END IF;
    UPDATE research_operations SET bill2_call_id=p_call WHERE id=p_operation AND bill2_call_id IS NULL;
    IF NOT EXISTS(SELECT 1 FROM research_operations WHERE id=p_operation AND bill2_call_id=p_call) THEN RAISE EXCEPTION 'RESEARCH_LINK_CONFLICT';END IF;
  END IF;
END $$;

-- Content erasure (conversation / answer): find runtime research evidence by session and answer, treat settled
-- runtime operations as finished, and delete the host records of the deleted conversation or answer.
DO $$ DECLARE definition text; f text; b text; d text; BEGIN
  definition:=pg_get_functiondef('public.content_erasure_confirm(uuid,text,uuid,text)'::regprocedure);
  IF position('-- 0263 runtime research' IN definition)=0 THEN
    f:=$x$ research_plan_ids:=ARRAY(SELECT DISTINCT plan_id FROM research_operations WHERE id=ANY(research_ids));$x$;
    b:=$x$(state NOT IN ('succeeded','failed','cancelled') OR (pre_deduct_id IS NOT NULL AND charged_credits IS NULL))$x$;
    d:=$x$ -- Same terminal-result cost projection as account erasure; original amounts and charge IDs stay intact.$x$;
    IF array_length(string_to_array(definition,f),1)<>2 OR array_length(string_to_array(definition,b),1)<>2
     OR array_length(string_to_array(definition,d),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_RUNTIME_SOURCE_MISMATCH: content_erasure_confirm';END IF;
    definition:=replace(definition,f,$x$ -- 0263 runtime research: conversation searches have no artifact evidence.
 research_ids:=research_ids||ARRAY(SELECT o.id FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
  WHERE p.actor_id=a AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids)) AND NOT o.id=ANY(research_ids));
$x$||f);
    definition:=replace(definition,b,$x$(NOT research_operation_settled(research_operations) OR (pre_deduct_id IS NOT NULL AND charged_credits IS NULL))$x$);
    definition:=replace(definition,d,$x$ DELETE FROM research_selection_cards WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
 DELETE FROM research_account_fetches WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR last_success_execution_id=ANY(ids));
 DELETE FROM research_refresh_grants WHERE actor_id=a AND session_id=ANY(sessions);
 DELETE FROM research_discoveries WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids));
$x$||d);
    EXECUTE definition;
  END IF;
END $$;

-- Account erasure: settled runtime operations are scrubbed like terminal ones, and the host records are deleted.
DO $$ DECLARE definition text; t text; r text; BEGIN
  definition:=pg_get_functiondef('public.account_erasure_scrub_content(uuid)'::regprocedure);
  IF position('-- 0263 runtime research' IN definition)=0 THEN
    t:=$x$    AND o.state IN ('succeeded', 'failed', 'cancelled');$x$;
    r:=$x$  RETURN counts;$x$;
    IF array_length(string_to_array(definition,t),1)<>2 OR array_length(string_to_array(definition,r),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_RUNTIME_SOURCE_MISMATCH: account_erasure_scrub_content';END IF;
    definition:=replace(definition,t,$x$    AND research_operation_settled(o);$x$);
    definition:=replace(definition,r,$x$  -- 0263 runtime research
  DELETE FROM research_selection_cards WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_selection_cards_deleted',n);
  DELETE FROM research_account_fetches WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_account_fetches_deleted',n);
  DELETE FROM research_refresh_grants WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_refresh_grants_deleted',n);
  DELETE FROM research_discoveries WHERE actor_id=p_profile_id;
  GET DIAGNOSTICS n=ROW_COUNT;counts:=counts||jsonb_build_object('research_discoveries_deleted',n);
$x$||r);
    EXECUTE definition;
  END IF;
END $$;

DO $$ DECLARE definition text; t text; BEGIN
  definition:=pg_get_functiondef('public.account_erasure_financial_proof(uuid)'::regprocedure);
  IF position('-- 0263 runtime research' IN definition)=0 THEN
    t:=$x$  WHERE p.actor_id=p_profile_id AND (o.erased_at IS NULL OR o.state NOT IN ('succeeded','failed','cancelled'));$x$;
    IF array_length(string_to_array(definition,t),1)<>2 THEN
      RAISE EXCEPTION 'RESEARCH_RUNTIME_SOURCE_MISMATCH: account_erasure_financial_proof';END IF;
    EXECUTE replace(definition,t,$x$  -- 0263 runtime research: a settled runtime search is finished money.
  WHERE p.actor_id=p_profile_id AND (o.erased_at IS NULL OR NOT research_operation_settled(o));$x$);
  END IF;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['research_session_owned(uuid,uuid,uuid)','research_operation_settled(research_operations)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role',f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['research_card_create(uuid,uuid,uuid,uuid,jsonb)','research_card_confirm(uuid,uuid,jsonb)',
    'research_confirmation_read(uuid,uuid,uuid)','research_user_message(uuid,uuid,uuid)',
    'research_discovery_start(uuid,uuid,uuid,uuid,text[])','research_discovery_save(uuid,uuid,uuid,jsonb,text)',
    'research_account_fetch_claim(uuid,uuid,uuid,text,text,uuid)','research_account_fetch_dispatch(uuid,uuid,uuid)',
    'research_account_fetch_finish(uuid,uuid,uuid,text,jsonb)',
    'research_refresh_create(uuid,uuid,text,text)','research_runtime_link(uuid,uuid,uuid,uuid,uuid,uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role',f);
  END LOOP;
END $$;
COMMIT;
