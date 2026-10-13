/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-REVIEW PR-1. Number allocated by the controller.
-- A Fusion billing group ties the per-model billing runs of one review (or comparison) together.
-- Every model keeps its own run and execution, so all existing one-run-one-execution invariants
-- (stop, recovery, dispatch, replay, erasure detach, 24h deadline, 32-call cap) stay unchanged.
-- The group adds only: an all-or-nothing full-hold claim for a batch of runs, group-cumulative
-- rounding (the whole group rounds up once), Fusion purposes refused outside the group claim,
-- and a host verdict that must exist before a Fusion call settles.
-- New tables: existing runs cannot express "several runs share one rounding and one batch hold".
BEGIN;

CREATE TABLE IF NOT EXISTS public.fusion_billing_groups (
  id uuid DEFAULT gen_random_uuid() CONSTRAINT fusion_billing_groups_pk PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES public.profiles(id),
  request_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('review','compare')),
  credits_per_usd numeric NOT NULL CHECK (credits_per_usd > 0),
  weighted_nominal_usd numeric NOT NULL DEFAULT 0 CHECK (weighted_nominal_usd >= 0),
  version integer NOT NULL DEFAULT 0,
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

CREATE OR REPLACE FUNCTION public.fusion_group_create(p_actor_id uuid, p_request_id uuid, p_kind text, p_credits_per_usd numeric)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE g fusion_billing_groups;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  INSERT INTO fusion_billing_groups(actor_id, request_id, kind, credits_per_usd)
    VALUES (p_actor_id, p_request_id, p_kind, p_credits_per_usd) ON CONFLICT (actor_id, request_id) DO NOTHING;
  SELECT * INTO g FROM fusion_billing_groups WHERE actor_id=p_actor_id AND request_id=p_request_id;
  IF g.kind IS DISTINCT FROM p_kind OR g.credits_per_usd IS DISTINCT FROM p_credits_per_usd THEN RAISE EXCEPTION 'FUSION_GROUP_CONFLICT'; END IF;
  RETURN g.id;
END $$;

-- Lock order everywhere: runs (by id) -> group -> profile, matching claim and finalize.
CREATE OR REPLACE FUNCTION public.fusion_group_attach(p_actor_id uuid, p_group_id uuid, p_run_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r bill2_runs; g fusion_billing_groups;
BEGIN
  SELECT * INTO r FROM bill2_runs WHERE id=p_run_id AND actor_id=p_actor_id FOR UPDATE;
  SELECT * INTO g FROM fusion_billing_groups WHERE id=p_group_id AND actor_id=p_actor_id FOR UPDATE;
  IF r.id IS NULL OR g.id IS NULL OR r.contract_version<>'bill2.v2' THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
  IF r.fusion_group_id=g.id THEN RETURN; END IF;
  IF r.fusion_group_id IS NOT NULL OR r.closed OR r.credits_per_usd IS DISTINCT FROM g.credits_per_usd
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
  ids uuid[]:='{}'; out jsonb:='[]'; expected integer;
BEGIN
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
  IF (SELECT count(DISTINCT x->>'runId') FROM jsonb_array_elements(p_items) x)<>jsonb_array_length(p_items) THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
  PERFORM 1 FROM bill2_runs WHERE id IN (SELECT (x->>'runId')::uuid FROM jsonb_array_elements(p_items) x)
    AND actor_id=p_actor_id AND fusion_group_id=p_group_id ORDER BY id FOR UPDATE;
  IF (SELECT count(*) FROM bill2_runs WHERE id IN (SELECT (x->>'runId')::uuid FROM jsonb_array_elements(p_items) x)
    AND actor_id=p_actor_id AND fusion_group_id=p_group_id)<>jsonb_array_length(p_items) THEN RAISE EXCEPTION 'FUSION_GROUP_DENIED'; END IF;
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
  BEGIN
    PERFORM set_config('graylum.fusion_group_claim', g.id::text, true);
    FOR item IN SELECT * FROM jsonb_array_elements(p_items) LOOP
      IF NOT fusion_purpose(item->'payload') THEN RAISE EXCEPTION 'FUSION_GROUP_INVALID'; END IF;
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
  IF p_verdict NOT IN ('usable','format_invalid','revision_invalid','no_delivery') THEN RAISE EXCEPTION 'FUSION_VERDICT_INVALID'; END IF;
  SELECT * INTO c FROM bill2_calls WHERE id=p_call_id FOR UPDATE;
  SELECT * INTO r FROM bill2_runs WHERE id=c.run_id AND actor_id=p_actor_id;
  IF c.id IS NULL OR r.id IS NULL OR r.fusion_group_id IS NULL OR NOT fusion_purpose(c.payload) THEN RAISE EXCEPTION 'FUSION_VERDICT_DENIED'; END IF;
  IF c.fusion_verdict IS NOT NULL THEN
    IF c.fusion_verdict<>p_verdict THEN RAISE EXCEPTION 'FUSION_VERDICT_IMMUTABLE'; END IF;
    RETURN c.fusion_verdict;
  END IF;
  IF c.settled_at IS NOT NULL THEN RAISE EXCEPTION 'FUSION_VERDICT_DENIED'; END IF;
  UPDATE bill2_calls SET fusion_verdict=p_verdict WHERE id=c.id;
  RETURN p_verdict;
END $$;

DO $$ DECLARE f text; BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_group_create(uuid,uuid,text,numeric)','fusion_group_attach(uuid,uuid,uuid)',
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

-- Settlement: group members round on the group's cumulative weighted nominal value, so the
-- group as a whole is charged ceil(total * q) once; a Fusion call without a host verdict does
-- not settle (its hold stays), and zero-charge verdicts take the existing refund path.
DO $$ DECLARE src text; a1 text; a2 text; a3 text; a4 text; a5 text; BEGIN
  src:=pg_get_functiondef('public.bill2_payg_finalize(uuid,uuid)'::regprocedure);
  IF position('fusion_billing_groups' IN src)=0 THEN
    a1:='DECLARE r bill2_runs;c bill2_calls;rec record;';
    a2:=$x$ PERFORM bill2_payg_lock_models(r);
 PERFORM id FROM bill2_calls WHERE run_id=rid ORDER BY id FOR UPDATE;$x$;
    a3:=$x$  IF bad THEN UPDATE bill2_runs SET conflict=true$x$;
    a4:=$x$  IF c.provider_rejected OR c.dispatched_at IS NULL OR (r.closed AND r.outcome='confirmed_failure') THEN$x$;
    a5:='   w:=r.weighted_nominal_usd;';
    IF array_length(string_to_array(src,a1),1)<>2 OR array_length(string_to_array(src,a2),1)<>2
      OR array_length(string_to_array(src,a3),1)<>2 OR array_length(string_to_array(src,a4),1)<>2
      OR array_length(string_to_array(src,a5),1)<>2
      OR array_length(string_to_array(src,$x$   version=version+1 WHERE id=rid RETURNING * INTO r;
 END LOOP;$x$),1)<>2 THEN RAISE EXCEPTION 'FUSION_SOURCE_MISMATCH: bill2_payg_finalize'; END IF;
    src:=replace(src,a1,'DECLARE fg fusion_billing_groups;r bill2_runs;c bill2_calls;rec record;');
    src:=replace(src,a2,$x$ PERFORM bill2_payg_lock_models(r);
 SELECT * INTO fg FROM fusion_billing_groups WHERE id=r.fusion_group_id FOR UPDATE;
 PERFORM id FROM bill2_calls WHERE run_id=rid ORDER BY id FOR UPDATE;$x$);
    src:=replace(src,a3,$x$  IF fusion_purpose(c.payload) AND c.dispatched_at IS NOT NULL AND NOT c.provider_rejected
   AND NOT (r.closed AND r.outcome='confirmed_failure') AND c.fusion_verdict IS NULL THEN
   -- Only account closure ends an unjudged call at zero charge; ordinary content deletion keeps the hold.
   IF NOT bill2_erasure_closed(a,rid) THEN CONTINUE;END IF;
   UPDATE bill2_calls SET fusion_verdict='erased_before_verdict' WHERE id=c.id RETURNING * INTO c;
  END IF;
$x$||a3);
    src:=replace(src,a4,$x$  IF c.provider_rejected OR c.dispatched_at IS NULL OR (r.closed AND r.outcome='confirmed_failure')
   OR c.fusion_verdict IN ('format_invalid','revision_invalid','no_delivery','erased_before_verdict') THEN$x$);
    src:=replace(src,a5,'   w:=CASE WHEN fg.id IS NULL THEN r.weighted_nominal_usd ELSE fg.weighted_nominal_usd END;');
    src:=replace(src,$x$   version=version+1 WHERE id=rid RETURNING * INTO r;
 END LOOP;$x$,$x$   version=version+1 WHERE id=rid RETURNING * INTO r;
  IF fg.id IS NOT NULL THEN
   UPDATE fusion_billing_groups SET weighted_nominal_usd=weighted_nominal_usd+n*bill2_unit_multiplier(c.payload->'billingUnit'->'multiplier'),
    version=version+1 WHERE id=fg.id RETURNING * INTO fg;
  END IF;
 END LOOP;$x$);
    EXECUTE src;
  END IF;
END $$;
COMMIT;
