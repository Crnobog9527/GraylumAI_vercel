/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-REVIEW PR-1. Number allocated by the controller.
-- A Fusion billing group ties the per-model billing runs of one review (or comparison) together.
-- Every model keeps its own run and execution, and each run settles and rounds on its own like any
-- PAYG run (Owner 2026-10-14). All existing one-run-one-execution invariants stay unchanged.
-- The group adds only: an all-or-nothing full-hold claim for a batch of runs (balance must cover the
-- whole batch's upper bound, Owner 2026-10-13 option A), Fusion purposes refused outside the group
-- claim, one call per Fusion run, and a host verdict that must exist before a Fusion call settles.
-- New tables: existing runs cannot express "a batch of runs is held all-or-nothing, idempotently".
BEGIN;

CREATE TABLE IF NOT EXISTS public.fusion_billing_groups (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT fusion_billing_groups_pk PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('review','compare')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fusion_billing_groups_request_unique UNIQUE (actor_id, request_id)
);
CREATE TABLE IF NOT EXISTS public.fusion_billing_group_steps (
  group_id uuid NOT NULL REFERENCES public.fusion_billing_groups(id),
  step_key text NOT NULL CHECK (step_key ~ '^[a-z0-9:_-]{1,80}$'),
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 32),
  call_ids uuid[] NOT NULL CHECK (cardinality(call_ids) BETWEEN 1 AND 16),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT fusion_billing_group_steps_pk PRIMARY KEY (group_id, step_key, attempt)
);
ALTER TABLE public.bill2_runs ADD COLUMN IF NOT EXISTS fusion_group_id uuid REFERENCES public.fusion_billing_groups(id);
CREATE INDEX IF NOT EXISTS bill2_runs_fusion_group_idx ON public.bill2_runs(fusion_group_id) WHERE fusion_group_id IS NOT NULL;
ALTER TABLE public.bill2_calls ADD COLUMN IF NOT EXISTS fusion_verdict text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='bill2_calls_fusion_verdict_check') THEN
    ALTER TABLE public.bill2_calls ADD CONSTRAINT bill2_calls_fusion_verdict_check CHECK (fusion_verdict IS NULL OR fusion_verdict IN
      ('usable','format_invalid','revision_invalid','no_delivery','erased_before_verdict'));
  END IF;
END $$;
ALTER TABLE public.fusion_billing_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fusion_billing_group_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fusion_billing_groups, public.fusion_billing_group_steps FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fusion_purpose(p jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(p->>'phase' IN ('fusion_review','fusion_summary','fusion_compare'), false);
$$;
REVOKE ALL ON FUNCTION public.fusion_purpose(jsonb) FROM PUBLIC, anon, authenticated, service_role;

-- Membership is set once, before the run has any call, and never changes; a verdict is written once.
CREATE OR REPLACE FUNCTION public.fusion_billing_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  -- Nested IFs: PL/pgSQL does not guarantee short-circuit, and each table lacks the other's column.
  IF TG_TABLE_NAME='bill2_runs' THEN
    IF NEW.fusion_group_id IS DISTINCT FROM OLD.fusion_group_id THEN
      IF OLD.fusion_group_id IS NOT NULL OR current_setting('graylum.fusion_group_attach', true) IS DISTINCT FROM NEW.id::text
        OR EXISTS (SELECT 1 FROM bill2_calls WHERE run_id=NEW.id) THEN RAISE EXCEPTION 'FUSION_GROUP_IMMUTABLE'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME='bill2_calls' THEN
    IF OLD.fusion_verdict IS NOT NULL THEN
      IF NEW.fusion_verdict IS DISTINCT FROM OLD.fusion_verdict THEN RAISE EXCEPTION 'FUSION_VERDICT_IMMUTABLE'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.fusion_billing_guard() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS fusion_billing_run_guard ON public.bill2_runs;
CREATE TRIGGER fusion_billing_run_guard BEFORE UPDATE OF fusion_group_id ON public.bill2_runs
  FOR EACH ROW EXECUTE FUNCTION public.fusion_billing_guard();
DROP TRIGGER IF EXISTS fusion_billing_call_guard ON public.bill2_calls;
CREATE TRIGGER fusion_billing_call_guard BEFORE UPDATE OF fusion_verdict ON public.bill2_calls
  FOR EACH ROW EXECUTE FUNCTION public.fusion_billing_guard();

CREATE OR REPLACE FUNCTION public.fusion_group_create(p_actor_id uuid, p_request_id uuid, p_kind text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g fusion_billing_groups;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  INSERT INTO fusion_billing_groups(actor_id, request_id, kind)
    VALUES (p_actor_id, p_request_id, p_kind) ON CONFLICT (actor_id, request_id) DO NOTHING;
  SELECT * INTO g FROM fusion_billing_groups WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF g.kind IS DISTINCT FROM p_kind THEN RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
  RETURN g.id;
END $$;

-- Lock order: runs (by id) -> model advisory locks (sorted) -> group -> profile; settlement never locks the group.
CREATE OR REPLACE FUNCTION public.fusion_group_attach(p_actor_id uuid, p_group_id uuid, p_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs; g fusion_billing_groups;
BEGIN
  SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
  SELECT * INTO g FROM fusion_billing_groups WHERE id=p_group_id AND actor_id=p_actor_id FOR UPDATE;
  IF r.id IS NULL OR g.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  IF r.fusion_group_id=g.id THEN RETURN; END IF;
  IF r.fusion_group_id IS NOT NULL OR r.closed
    OR EXISTS (SELECT 1 FROM bill2_calls WHERE run_id=r.id) THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  PERFORM set_config('graylum.fusion_group_attach', r.id::text, true);
  UPDATE bill2_runs SET fusion_group_id=g.id, version=version+1 WHERE id=r.id;
  PERFORM set_config('graylum.fusion_group_attach', '', true);
END $$;

-- p_items: [{runId, sequence, payload}]. Either every call is created with a full hold
-- (reserved = ceil(upperUsd * q * m), the call's own upper bound), or none is.
CREATE OR REPLACE FUNCTION public.fusion_group_claim(p_actor_id uuid, p_group_id uuid, p_step_key text, p_attempt integer, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g fusion_billing_groups; s fusion_billing_group_steps; item jsonb; res jsonb; c bill2_calls; r bill2_runs;
  ids uuid[]:='{}'; out jsonb:='[]'; expected integer; k bigint;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
  IF (SELECT count(DISTINCT x->>'runId') FROM jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
  PERFORM 1 FROM bill2_runs WHERE id IN (SELECT (x->>'runId')::uuid FROM jsonb_array_elements(p_items) x)
    AND actor_id=p_actor_id AND fusion_group_id=p_group_id ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM bill2_runs WHERE id IN (SELECT (x->>'runId')::uuid FROM jsonb_array_elements(p_items) x)
    AND actor_id=p_actor_id AND fusion_group_id=p_group_id)<>jsonb_array_length(p_items) THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  -- Model advisory locks before the group row, in one sorted pass over every member's models:
  -- finalize and record take run -> models -> group, so claim must never hold the group while
  -- waiting for a model lock.
  FOR k IN SELECT DISTINCT hashtextextended('bill2-payg:'||(x->>'model'),0)
    FROM bill2_runs br, jsonb_array_elements(br.payload->'callPolicy') x
    WHERE br.id IN (SELECT (y->>'runId')::uuid FROM jsonb_array_elements(p_items) y) ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(k);
  END LOOP;
  SELECT * INTO g FROM fusion_billing_groups WHERE id=p_group_id AND actor_id=p_actor_id FOR UPDATE;
  IF g.id IS NULL THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  SELECT * INTO s FROM fusion_billing_group_steps WHERE group_id=g.id AND step_key=p_step_key AND attempt=p_attempt;
  IF s.group_id IS NOT NULL THEN
    -- Replay: same runs and payloads return the same calls; no new hold.
    FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      SELECT * INTO c FROM bill2_calls WHERE id=ANY(s.call_ids) AND run_id=(item->>'runId')::uuid;
      IF c.id IS NULL OR c.sequence IS DISTINCT FROM (item->>'sequence')::int OR c.payload IS DISTINCT FROM item->'payload' THEN
        RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
      out:=out||jsonb_build_object('runId',c.run_id,'id',c.id,'state',c.state,'dispatchToken',NULL);
    END LOOP;
    IF jsonb_array_length(out)<>cardinality(s.call_ids) THEN RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
    RETURN jsonb_build_object('state','claimed','calls',out);
  END IF;
  -- A new step only takes fresh runs: a run that already has a call belongs to an earlier step, and
  -- replacements and later rounds must use new runs, never reuse an old result.
  IF EXISTS (SELECT 1 FROM bill2_calls WHERE run_id IN (SELECT (x->>'runId')::uuid FROM jsonb_array_elements(p_items) x)) THEN
    RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
  BEGIN
    PERFORM set_config('graylum.fusion_group_claim', g.id::text, true);
    FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      -- One call per Fusion run: replacements and later rounds use new runs, so max_calls never binds.
      IF NOT fusion_purpose(item->'payload') OR (item->>'sequence') IS DISTINCT FROM '1' THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
      res:=bill2_claim(p_actor_id, (item->>'runId')::uuid, (item->>'sequence')::int, item->'payload');
      IF res->>'state'='waiting_credits' OR res->>'id' IS NULL THEN RAISE EXCEPTION 'FUSION_GROUP_WAITING_CREDITS'; END IF;
      SELECT * INTO c FROM bill2_calls WHERE id=(res->>'id')::uuid;
      SELECT * INTO r FROM bill2_runs WHERE id=c.run_id;
      expected:=ceil(c.upper_usd*r.credits_per_usd*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'))::int;
      -- Owner 2026-10-13 (option A): no partial hold for a Fusion batch.
      IF c.reserved_credits IS DISTINCT FROM expected OR c.settled_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_GROUP_WAITING_CREDITS'; END IF;
      ids:=ids||c.id;
      out:=out||jsonb_build_object('runId',c.run_id,'id',c.id,'state',res->>'state','dispatchToken',res->'dispatchToken');
    END LOOP;
    INSERT INTO fusion_billing_group_steps(group_id, step_key, attempt, call_ids) VALUES (g.id, p_step_key, p_attempt, ids);
    PERFORM set_config('graylum.fusion_group_claim', '', true);
  EXCEPTION WHEN raise_exception THEN
    PERFORM set_config('graylum.fusion_group_claim', '', true);
    IF SQLERRM='FUSION_GROUP_WAITING_CREDITS' THEN RETURN jsonb_build_object('state','waiting_credits','calls','[]'::jsonb); END IF;
    RAISE;
  END;
  RETURN jsonb_build_object('state','claimed','calls',out);
END $$;

-- Host verdict after saving the response and validating it (format, template, fields).
CREATE OR REPLACE FUNCTION public.fusion_call_verdict(p_actor_id uuid, p_call_id uuid, p_verdict text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE c bill2_calls; r bill2_runs;
BEGIN
  IF p_verdict IS NULL OR p_verdict NOT IN ('usable','format_invalid','revision_invalid','no_delivery') THEN RAISE EXCEPTION 'FUSION_VERDICT_INVALID'; END IF;
  SELECT * INTO c FROM bill2_calls WHERE id=p_call_id FOR UPDATE;
  SELECT * INTO r FROM bill2_runs WHERE id=c.run_id AND actor_id=p_actor_id;
  IF c.id IS NULL OR r.id IS NULL OR r.fusion_group_id IS NULL OR NOT fusion_purpose(c.payload) THEN RAISE EXCEPTION 'FUSION_VERDICT_DENIED'; END IF;
  IF c.fusion_verdict IS NOT NULL THEN
    IF c.fusion_verdict<>p_verdict THEN RAISE EXCEPTION 'FUSION_VERDICT_IMMUTABLE'; END IF;
    RETURN c.fusion_verdict;
  END IF;
  IF c.settled_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_VERDICT_DENIED'; END IF;
  -- After account closure a new verdict may not override the zero-charge erasure path. The call row
  -- lock serializes this with settlement; the profile share lock serializes it with account closure,
  -- which updates the profile row, so closure either commits first (verdict refused) or waits.
  PERFORM 1 FROM profiles WHERE id=p_actor_id FOR SHARE;
  IF bill2_erasure_closed(p_actor_id, r.id) THEN RAISE EXCEPTION 'FUSION_VERDICT_DENIED'; END IF;
  UPDATE bill2_calls SET fusion_verdict=p_verdict WHERE id=c.id;
  RETURN p_verdict;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_group_create(uuid,uuid,text)','fusion_group_attach(uuid,uuid,uuid)',
    'fusion_group_claim(uuid,uuid,text,integer,jsonb)','fusion_call_verdict(uuid,uuid,text)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

-- Ordinary claims refuse Fusion purposes and grouped runs; only fusion_group_claim may create them.
-- Replays of an existing call stay allowed (the check sits after the idempotent return).
DO $$ DECLARE src text; anchor text:=$a$  RETURN jsonb_build_object('id',c.id,'state',c.state,'dispatchToken',NULL);
 END IF;
$a$; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_claim(uuid,uuid,integer,jsonb)'::regprocedure);
  IF position('FUSION_GROUP_CLAIM_REQUIRED' IN src)=0 THEN
    IF array_length(string_to_array(src, anchor),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: bill2_payg_claim'; END IF;
    EXECUTE replace(src, anchor, anchor||$i$ IF (fusion_purpose(p) OR r.fusion_group_id IS NOT NULL) AND (r.fusion_group_id IS NULL
  OR current_setting('graylum.fusion_group_claim',true) IS DISTINCT FROM r.fusion_group_id::text) THEN
  RAISE EXCEPTION 'FUSION_GROUP_CLAIM_REQUIRED';END IF;
$i$);
  END IF;
END $$;

-- Settlement (Owner 2026-10-14): every member run settles and rounds on its own, exactly as an
-- ordinary PAYG run; the group adds no shared rounding. Only two changes: a Fusion call without a host
-- verdict does not settle (its hold stays), and zero-charge verdicts take the existing refund path.
DO $$ DECLARE src text; a3 text; a4 text; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('fusion_purpose(c.payload)' IN src)=0 THEN
    a3:=$x$  IF bad THEN UPDATE bill2_runs SET conflict=true$x$;
    a4:=$x$  IF c.provider_rejected OR c.dispatched_at IS NULL OR (r.closed AND r.outcome='confirmed_failure') THEN$x$;
    IF array_length(string_to_array(src,a3),1)<>2 OR array_length(string_to_array(src,a4),1)<>2 THEN
      RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: bill2_payg_finalize'; END IF;
    src:=replace(src,a3,$x$  -- Calls that end without a response (provider rejection, cancelled before dispatch, run closed as
  -- confirmed failure) record the exhaustive no_delivery verdict before the existing zero-charge path.
  IF fusion_purpose(c.payload) AND c.fusion_verdict IS NULL AND (c.provider_rejected
   OR (c.dispatched_at IS NULL AND c.state='cancelled') OR (r.closed AND r.outcome='confirmed_failure')) THEN
   UPDATE bill2_calls SET fusion_verdict='no_delivery' WHERE id=c.id RETURNING * INTO c;
  END IF;
  IF fusion_purpose(c.payload) AND c.dispatched_at IS NOT NULL AND NOT c.provider_rejected
   AND NOT (r.closed AND r.outcome='confirmed_failure') AND c.fusion_verdict IS NULL THEN
   -- Only account closure ends an unjudged call at zero charge; ordinary content deletion keeps the hold.
   IF NOT bill2_erasure_closed(a,rid) THEN CONTINUE;END IF;
   UPDATE bill2_calls SET fusion_verdict='erased_before_verdict' WHERE id=c.id RETURNING * INTO c;
  END IF;
$x$||a3);
    src:=replace(src,a4,$x$  IF c.provider_rejected OR c.dispatched_at IS NULL OR (r.closed AND r.outcome='confirmed_failure')
   OR c.fusion_verdict IN ('format_invalid','revision_invalid','no_delivery','erased_before_verdict') THEN$x$);
    EXECUTE src;
  END IF;
END $$;
COMMIT;
