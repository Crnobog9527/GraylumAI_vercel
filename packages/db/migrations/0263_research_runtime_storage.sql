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
-- One account has one key however it was written: cards, fetches and refresh grants all match by this key, so the
-- same account can never be fetched and paid for twice. Same rule as canonicalAccount (research/tools/accountLinks.ts):
-- TikTok, X and Instagram handles are case-insensitive (lower case, one leading @ dropped); YouTube channel ids are
-- case-sensitive and Xiaohongshu ids lower-case hex, so they keep their case; Bilibili and Weibo ids are digits.
CREATE OR REPLACE FUNCTION public.research_account_key(p_platform text, p text) RETURNS text LANGUAGE sql IMMUTABLE
SET search_path=public,pg_temp AS $$
  SELECT CASE WHEN p_platform IN ('tiktok','x','instagram')
    THEN lower(regexp_replace(btrim(p),'^@','')) ELSE btrim(p) END
$$;
CREATE TABLE IF NOT EXISTS public.research_account_fetches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES public.profiles(id),
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id),
  execution_id uuid NOT NULL REFERENCES public.runtime_executions(id),
  platform text NOT NULL CHECK (platform ~ '^[a-z]{1,20}$'),
  account text NOT NULL CHECK (length(account) BETWEEN 1 AND 200),
  -- prepared: claimed, nothing sent yet (a crash here leaves it reclaimable); in_progress: marked sent, never resent.
  -- failed: confirmed free failure (may be claimed again); failed_charged: a sent request the supplier charged for
  -- although it failed (platform cost) — like unknown, it is never sent again in this session.
  state text NOT NULL CHECK (state IN ('prepared','in_progress','succeeded','unknown','failed','failed_charged')),
  attempt uuid NOT NULL DEFAULT gen_random_uuid(),
  evidence jsonb CHECK (evidence IS NULL OR (jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=8192)),
  -- The last successful (paid) evidence; a later refresh replaces it only when that refresh succeeds.
  last_success jsonb CHECK (last_success IS NULL OR (jsonb_typeof(last_success)='object' AND octet_length(last_success::text)<=8192)),
  last_success_execution_id uuid REFERENCES public.runtime_executions(id),
  -- The refresh grant a prepared attempt consumed; retrying with it after a crash takes the attempt over.
  refresh_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  account_key text GENERATED ALWAYS AS (public.research_account_key(platform,account)) STORED CHECK (account_key<>''),
  UNIQUE (session_id, platform, account_key)
);
CREATE TABLE IF NOT EXISTS public.research_refresh_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), actor_id uuid NOT NULL REFERENCES public.profiles(id),
  session_id uuid NOT NULL REFERENCES public.runtime_sessions(id),
  platform text NOT NULL, account text NOT NULL,
  used_at timestamptz, used_execution_id uuid REFERENCES public.runtime_executions(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((used_at IS NULL)=(used_execution_id IS NULL))
);
-- The answer whose successful evidence the grant refreshes: deleting that answer deletes the grant (with the
-- fetch record), like deleting the answer that used it.
ALTER TABLE public.research_refresh_grants ADD COLUMN IF NOT EXISTS source_execution_id uuid REFERENCES public.runtime_executions(id);
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
  -- Option ids and, on candidate cards, platform + account are unique: one account can fill only one slot.
  IF (SELECT count(DISTINCT x->>'id') FROM jsonb_array_elements(p->'options') x)<>jsonb_array_length(p->'options')
   OR (k='candidates' AND (SELECT count(DISTINCT (x->>'platform',research_account_key(x->>'platform',x->>'account'))) FROM jsonb_array_elements(p->'options') x)
     <>jsonb_array_length(p->'options'))
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
  PERFORM research_session_owned(a,s,c.execution_id);
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
  VALUES(a,s,e,p_platform,p_account,'prepared') ON CONFLICT (session_id,platform,account_key) DO NOTHING RETURNING * INTO f;
  IF f.id IS NOT NULL THEN
    IF p_refresh IS NOT NULL THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;
    RETURN jsonb_build_object('claimed',true,'fetchId',f.id,'attempt',f.attempt);
  END IF;
  SELECT * INTO f FROM research_account_fetches WHERE session_id=s AND platform=p_platform
    AND account_key=research_account_key(p_platform,p_account) FOR UPDATE;
  IF p_refresh IS NOT NULL THEN
    IF f.state='failed_charged' THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;
    SELECT * INTO g FROM research_refresh_grants WHERE id=p_refresh AND actor_id=a AND session_id=s FOR UPDATE;
    IF g.id IS NULL OR g.platform<>p_platform OR research_account_key(g.platform,g.account)<>research_account_key(p_platform,p_account)
    THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;
    -- A grant used by an attempt that never got sent (crash before dispatch) may claim that attempt again.
    IF g.used_at IS NOT NULL AND NOT (f.state='prepared' AND f.refresh_id=g.id) THEN RAISE EXCEPTION 'RESEARCH_REFRESH_USED';END IF;
    IF f.state='in_progress' OR (f.state='prepared' AND f.refresh_id IS DISTINCT FROM g.id) THEN
      RETURN jsonb_build_object('claimed',false,'fetchId',f.id,'state',f.state,'evidence',f.last_success);END IF;
    -- The grant belongs to the answer that holds the attempt now: an answer that took over an unsent attempt
    -- becomes its user, so deleting that answer deletes the grant and deleting the earlier one does not.
    UPDATE research_refresh_grants SET used_at=coalesce(used_at,clock_timestamp()),used_execution_id=e WHERE id=g.id;
  -- An ordinary claim takes over only a prepared attempt not bound to a refresh grant (that one resumes with its
  -- own grant; meanwhile the earlier evidence is reused, never a new paid fetch).
  ELSIF f.state='in_progress' OR (f.state='prepared' AND f.refresh_id IS NOT NULL)
    OR (f.state<>'prepared' AND (f.last_success IS NOT NULL OR f.state<>'failed')) THEN
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
DECLARE f research_account_fetches; metric text;
BEGIN
  -- A success must carry its evidence: a paid result without it could be neither reused nor refreshed.
  IF p_state NOT IN ('succeeded','unknown','failed','failed_charged') OR (p_state='succeeded' AND jsonb_typeof(p_evidence) IS DISTINCT FROM 'object')
  THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
  IF p_state='succeeded' THEN
    SELECT * INTO f FROM research_account_fetches WHERE id=p_fetch AND actor_id=a;
    -- The host cache is accountMetrics + classification; query/source/call records remain in research_operations.
    IF p_evidence->>'platform' IS DISTINCT FROM f.platform
     OR research_account_key(f.platform,p_evidence->>'account') IS DISTINCT FROM f.account_key
     OR jsonb_typeof(p_evidence->'fetchedAt') IS DISTINCT FROM 'string'
     OR NOT pg_input_is_valid(p_evidence->>'fetchedAt','timestamp with time zone')
     OR jsonb_typeof(p_evidence->'metrics') IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_evidence->'metrics'->'postsAnalyzed') IS DISTINCT FROM 'number'
     OR jsonb_typeof(p_evidence->'metrics'->'missing') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_evidence->'metrics'->'wholeHistory') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(p_evidence->'classification'->'qualified') IS DISTINCT FROM 'boolean'
     OR NOT coalesce(p_evidence->'classification' ?& ARRAY['category','excluded'],false)
    THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
    FOREACH metric IN ARRAY ARRAY['followers','medianViews','engagementRate','postsPerWeek','lastPublishedAt','earliestPublishedAt'] LOOP
      IF jsonb_typeof(p_evidence->'metrics'->metric) IS DISTINCT FROM 'object'
       OR NOT (p_evidence->'metrics'->metric ? 'value')
       OR jsonb_typeof(p_evidence->'metrics'->metric->'refs') IS DISTINCT FROM 'array'
      THEN RAISE EXCEPTION 'RESEARCH_FETCH_INVALID';END IF;
    END LOOP;
  END IF;
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
DECLARE g uuid; src uuid;
BEGIN
  PERFORM research_session_owned(a,s,NULL);
  SELECT last_success_execution_id INTO src FROM research_account_fetches WHERE session_id=s AND actor_id=a AND platform=p_platform
    AND account_key=research_account_key(p_platform,p_account) AND last_success IS NOT NULL AND state NOT IN ('prepared','in_progress','failed_charged');
  IF src IS NULL THEN RAISE EXCEPTION 'RESEARCH_REFRESH_INVALID';END IF;
  INSERT INTO research_refresh_grants(actor_id,session_id,platform,account,source_execution_id)
    VALUES(a,s,p_platform,p_account,src) RETURNING id INTO g;
  RETURN g;
END $$;

-- A runtime research plan is created already bound to its session, answer and discovery, under the same locks as
-- deletion, so every operation (dispatched or finished later) is found by deleting that conversation or answer.
-- Runtime plans are created only here; research_runtime_link never binds a plan afterwards.
CREATE OR REPLACE FUNCTION public.research_runtime_plan_create(a uuid, p_plan uuid, s uuid, e uuid, p_discovery uuid, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p research_plans; v jsonb;
BEGIN
  PERFORM research_session_owned(a,s,e);
  IF p_discovery IS NOT NULL AND NOT EXISTS(SELECT 1 FROM research_discoveries WHERE id=p_discovery AND actor_id=a AND session_id=s)
  THEN RAISE EXCEPTION 'RESEARCH_LINK_CONFLICT';END IF;
  SELECT * INTO p FROM research_plans WHERE id=p_plan FOR UPDATE;
  IF p.id IS NOT NULL AND (p.actor_id<>a OR (p.session_id,p.execution_id,p.discovery_id) IS DISTINCT FROM (s,e,p_discovery))
  THEN RAISE EXCEPTION 'RESEARCH_LINK_CONFLICT';END IF;
  v:=research_transition('create',p_plan,a,NULL,p_payload);
  UPDATE research_plans SET session_id=s,execution_id=e,discovery_id=p_discovery WHERE id=p_plan AND session_id IS NULL;
  RETURN v;
END $$;

-- Links an operation of a runtime plan to its BILL2 call; links never move.
CREATE OR REPLACE FUNCTION public.research_runtime_link(a uuid, p_plan uuid, s uuid, e uuid, p_discovery uuid, p_operation uuid, p_call uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p research_plans;
BEGIN
  PERFORM research_session_owned(a,s,e);
  SELECT * INTO p FROM research_plans WHERE id=p_plan AND actor_id=a FOR UPDATE;
  -- Only a plan bound at creation (research_runtime_plan_create) can be linked.
  IF p.id IS NULL OR p.session_id IS NULL OR (p.session_id,p.execution_id,p.discovery_id) IS DISTINCT FROM (s,e,p_discovery)
  THEN RAISE EXCEPTION 'RESEARCH_LINK_CONFLICT';END IF;
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
 research_plan_ids:=ARRAY(SELECT p.id FROM research_plans p WHERE p.actor_id=a AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids)))));
 research_ids:=research_ids||ARRAY(SELECT o.id FROM research_operations o
  WHERE o.plan_id=ANY(research_plan_ids) AND NOT o.id=ANY(research_ids));
 research_plan_ids:=research_plan_ids||ARRAY(SELECT DISTINCT plan_id FROM research_operations WHERE id=ANY(research_ids));
$x$);
    definition:=replace(definition,b,$x$(NOT research_operation_settled(research_operations) OR (pre_deduct_id IS NOT NULL AND charged_credits IS NULL))$x$);
    definition:=replace(definition,d,$x$ -- Bound plans include approved operations that were never reserved; erasing them prevents late reserve.
 UPDATE research_plans p SET operations=NULL,erased_at=stamp WHERE p.actor_id=a AND p.erased_at IS NULL AND (p.session_id=ANY(sessions) OR p.execution_id=ANY(ids) OR p.discovery_id IN (
   SELECT d.id FROM research_discoveries d JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id
   WHERE c.actor_id=a AND (c.session_id=ANY(sessions) OR c.execution_id=ANY(ids))));
 WITH removed AS (
  DELETE FROM research_discoveries d WHERE d.actor_id=a AND (d.session_id=ANY(sessions) OR d.execution_id=ANY(ids)
   OR d.keyword_confirmation_id IN (SELECT confirmation_id FROM research_selection_cards
    WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)))) RETURNING id
 ) DELETE FROM research_selection_cards WHERE actor_id=a AND
  (session_id=ANY(sessions) OR execution_id=ANY(ids) OR discovery_id IN (SELECT id FROM removed));
 -- Deleting only the answer of a later refresh keeps the earlier success of a remaining answer: the record goes back
 -- to that success (the refresh attempt is dropped and can never finish), so it is reused and never paid for again.
 UPDATE research_account_fetches SET state=CASE WHEN state='failed_charged' THEN state ELSE 'succeeded' END,execution_id=last_success_execution_id,evidence=last_success,
   attempt=gen_random_uuid(),refresh_id=NULL,updated_at=clock_timestamp()
 WHERE actor_id=a AND execution_id=ANY(ids) AND last_success IS NOT NULL
   AND NOT coalesce(last_success_execution_id=ANY(ids),false) AND NOT coalesce(session_id=ANY(sessions),false);
 DELETE FROM research_account_fetches WHERE actor_id=a AND (session_id=ANY(sessions) OR execution_id=ANY(ids)
   OR last_success_execution_id=ANY(ids));
 DELETE FROM research_refresh_grants WHERE actor_id=a AND (session_id=ANY(sessions)
   OR used_execution_id=ANY(ids) OR source_execution_id=ANY(ids));
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
  FOREACH f IN ARRAY ARRAY['research_session_owned(uuid,uuid,uuid)','research_operation_settled(research_operations)',
    'research_account_key(text,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role',f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['research_card_create(uuid,uuid,uuid,uuid,jsonb)','research_card_confirm(uuid,uuid,jsonb)',
    'research_confirmation_read(uuid,uuid,uuid)','research_user_message(uuid,uuid,uuid)',
    'research_discovery_start(uuid,uuid,uuid,uuid,text[])','research_discovery_save(uuid,uuid,uuid,jsonb,text)',
    'research_account_fetch_claim(uuid,uuid,uuid,text,text,uuid)','research_account_fetch_dispatch(uuid,uuid,uuid)',
    'research_account_fetch_finish(uuid,uuid,uuid,text,jsonb)',
    'research_refresh_create(uuid,uuid,text,text)','research_runtime_link(uuid,uuid,uuid,uuid,uuid,uuid,uuid)',
    'research_runtime_plan_create(uuid,uuid,uuid,uuid,uuid,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated',f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role',f);
  END LOOP;
END $$;

-- Host-only scoped reads. All tables remain inaccessible, including to service_role.
CREATE OR REPLACE FUNCTION public.research_runtime_read(a uuid,s uuid,e uuid,p_kind text,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v jsonb;
BEGIN
  PERFORM research_session_owned(a,s,e);
  CASE p_kind
  WHEN 'operation' THEN
    SELECT jsonb_build_object('identityHash',o.identity_hash,'state',o.state,'result',o.result,'executionId',p.execution_id) INTO v
    FROM research_operations o JOIN research_plans p ON p.id=o.plan_id
    JOIN runtime_executions x ON x.id=p.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE o.id=p_id AND p.actor_id=a AND p.session_id=s AND o.erased_at IS NULL AND p.erased_at IS NULL
    AND x.content_deleted_at IS NULL AND x.erased_at IS NULL;
  WHEN 'plan' THEN
    SELECT jsonb_build_object('executionId',p.execution_id,'discoveryId',p.discovery_id,'operations',p.operations,
      'budgetUnits',p.budget_units,'cancelled',p.cancelled) INTO v FROM research_plans p
    JOIN runtime_executions x ON x.id=p.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE p.id=p_id AND p.actor_id=a AND p.session_id=s AND p.erased_at IS NULL
    AND x.content_deleted_at IS NULL AND x.erased_at IS NULL;
  WHEN 'discovery' THEN
    SELECT jsonb_build_object('discoveryId',d.id,'keywords',d.keywords,'platforms',d.platforms,'cursor',d.cursor,'state',d.state)
    INTO v FROM research_discoveries d
    JOIN research_selection_cards c ON c.confirmation_id=d.keyword_confirmation_id AND c.actor_id=a
    JOIN runtime_executions src ON src.id=c.execution_id AND src.content_deleted_at IS NULL AND src.erased_at IS NULL
    JOIN runtime_executions x ON x.id=d.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE d.id=p_id AND d.actor_id=a AND d.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL;
  WHEN 'refresh' THEN
    SELECT jsonb_build_object('platform',g.platform,'account',g.account,'used',g.used_at IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM research_account_fetches f WHERE f.actor_id=a AND f.session_id=s AND f.refresh_id=g.id
      AND f.state='prepared' AND f.platform=g.platform AND f.account_key=research_account_key(g.platform,g.account)))
    INTO v FROM research_refresh_grants g
    JOIN runtime_executions x ON x.id=g.source_execution_id AND x.actor_id=a AND x.session_id=s
    WHERE g.id=p_id AND g.actor_id=a AND g.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
    AND (g.used_execution_id IS NULL OR EXISTS(SELECT 1 FROM runtime_executions u WHERE u.id=g.used_execution_id
      AND u.actor_id=a AND u.session_id=s AND u.content_deleted_at IS NULL AND u.erased_at IS NULL));
  WHEN 'selected' THEN
    SELECT coalesce(jsonb_agg(item),'[]'::jsonb) INTO v FROM research_selection_cards c
    JOIN runtime_executions x ON x.id=c.execution_id AND x.actor_id=a AND x.session_id=s
    CROSS JOIN LATERAL jsonb_array_elements(c.confirmed_items) item
    WHERE c.actor_id=a AND c.session_id=s AND c.discovery_id=p_id AND c.kind='candidates' AND c.confirmation_id IS NOT NULL
    AND x.content_deleted_at IS NULL AND x.erased_at IS NULL;
  WHEN 'card' THEN
    SELECT jsonb_build_object('cardId',c.id,'kind',c.kind,'options',c.options,'minSelect',c.min_select,'maxSelect',c.max_select,
      'confirmationId',c.confirmation_id,'items',c.confirmed_items)
    INTO v FROM research_selection_cards c
    JOIN runtime_executions x ON x.id=c.execution_id AND x.actor_id=a AND x.session_id=s
    WHERE c.id=p_id AND c.actor_id=a AND c.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL;
  ELSE RAISE EXCEPTION 'RESEARCH_READ_INVALID';
  END CASE;
  RETURN v;
END $$;
REVOKE ALL ON FUNCTION public.research_runtime_read(uuid,uuid,uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_runtime_read(uuid,uuid,uuid,text,uuid) TO service_role;

-- User-facing reads: service-only, actor-scoped, live content only. No supplier/cost columns leave these RPCs.
CREATE OR REPLACE FUNCTION public.research_user_tool_charges(a uuid,p_transaction uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE tx credit_transactions; output jsonb;
BEGIN
 PERFORM bill2_actor(a);
 SELECT * INTO tx FROM credit_transactions WHERE id=p_transaction AND user_id=a;
 IF tx.id IS NULL THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('callId',c.id,'toolName',o.result->>'toolName','args',o.result->'args',
  'source',CASE WHEN c.nominal_source IN ('tool_usage','tool_no_usage','tool_failed','tool_failed_charged','tool_unknown')
    THEN c.nominal_source END,
  -- Same frozen call multiplier and run conversion as settlement, before its cumulative ceil.
  'credits',CASE WHEN c.settled_at IS NOT NULL AND c.nominal_source LIKE 'tool_%'
    THEN (c.nominal_cost_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier')*r.credits_per_usd)::text END
 ) ORDER BY c.sequence,c.id),'[]'::jsonb) INTO output
 FROM bill2_calls c JOIN bill2_runs r ON r.id=c.run_id
 JOIN runtime_executions x ON x.billing_run_id=r.id AND x.actor_id=a
 JOIN runtime_sessions s ON s.id=x.session_id AND s.actor_id=a
 LEFT JOIN LATERAL (SELECT evidence.result FROM research_operations evidence
  JOIN research_plans p ON p.id=evidence.plan_id AND p.execution_id=x.id AND p.actor_id=a AND p.erased_at IS NULL
  WHERE evidence.bill2_call_id=c.id AND evidence.erased_at IS NULL) o ON true
 WHERE r.id=tx.bill2_run_id AND r.actor_id=a AND c.call_kind='tool'
 AND x.content_deleted_at IS NULL AND x.erased_at IS NULL AND s.content_deleted_at IS NULL AND s.erased_at IS NULL;
 RETURN output;
END $$;

CREATE OR REPLACE FUNCTION public.research_user_evidence(a uuid,p_limit integer,p_cursor_time timestamptz,p_cursor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE output jsonb;
BEGIN
 PERFORM bill2_actor(a);
 IF p_limit NOT BETWEEN 1 AND 101 OR (p_cursor_time IS NULL)<>(p_cursor_id IS NULL)
 THEN RAISE EXCEPTION 'RESEARCH_SCOPE_DENIED' USING ERRCODE='42501';END IF;
 SELECT coalesce(jsonb_agg(row ORDER BY stamp DESC,oid DESC),'[]'::jsonb) INTO output FROM (
  SELECT o.created_at stamp,o.id oid,jsonb_build_object(
   'operationId',o.id,'toolName',o.result->>'toolName','args',o.result->'args','state',o.state,
   'fetchedAt',o.result->>'fetchedAt',
   'itemCount',CASE WHEN jsonb_typeof(o.result->'items')='array' THEN jsonb_array_length(o.result->'items') END,
   'truncated',o.result->'truncated',
   'sources',coalesce((SELECT jsonb_agg(item->>'url') FROM jsonb_array_elements(
     CASE WHEN jsonb_typeof(o.result->'items')='array' THEN o.result->'items' ELSE '[]'::jsonb END) item
     WHERE jsonb_typeof(item->'url')='string'),'[]'::jsonb),
   'sessionId',s.id,'sessionTitle',coalesce(n.name,(SELECT left(nullif(btrim(t.payload->>'input'),''),80)
     FROM runtime_executions t WHERE t.session_id=s.id AND t.actor_id=a
     AND t.content_deleted_at IS NULL AND t.erased_at IS NULL ORDER BY t.created_at,t.id LIMIT 1)),
   'createdAt',o.created_at) row
  FROM research_operations o JOIN research_plans p ON p.id=o.plan_id AND p.actor_id=a
  JOIN runtime_sessions s ON s.id=p.session_id AND s.actor_id=a
  JOIN runtime_executions x ON x.id=p.execution_id AND x.actor_id=a AND x.session_id=s.id
  LEFT JOIN runtime_session_names n ON n.session_id=s.id AND n.actor_id=a
  WHERE o.erased_at IS NULL AND p.erased_at IS NULL AND x.content_deleted_at IS NULL AND x.erased_at IS NULL
   AND s.content_deleted_at IS NULL AND s.erased_at IS NULL AND o.state IN ('succeeded','failed','unknown')
   AND (p_cursor_time IS NULL OR (o.created_at,o.id)<(p_cursor_time,p_cursor_id))
  ORDER BY o.created_at DESC,o.id DESC LIMIT p_limit
 ) records;
 RETURN output;
END $$;

CREATE OR REPLACE FUNCTION public.research_user_cards(a uuid,s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE output jsonb;
BEGIN
 PERFORM research_session_owned(a,s,NULL);
 SELECT coalesce(jsonb_agg(jsonb_build_object('cardId',c.id,'kind',c.kind,'options',c.options,
  'minSelect',c.min_select,'maxSelect',c.max_select,'confirmationId',c.confirmation_id,'items',c.confirmed_items)
  ORDER BY c.created_at,c.id),'[]'::jsonb) INTO output FROM research_selection_cards c
 JOIN runtime_executions x ON x.id=c.execution_id AND x.actor_id=a AND x.session_id=s
 WHERE c.actor_id=a AND c.session_id=s AND x.content_deleted_at IS NULL AND x.erased_at IS NULL;
 RETURN output;
END $$;
REVOKE ALL ON FUNCTION public.research_user_tool_charges(uuid,uuid),public.research_user_evidence(uuid,integer,timestamptz,uuid),
 public.research_user_cards(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_user_tool_charges(uuid,uuid),public.research_user_evidence(uuid,integer,timestamptz,uuid),
 public.research_user_cards(uuid,uuid) TO service_role;

COMMIT;
