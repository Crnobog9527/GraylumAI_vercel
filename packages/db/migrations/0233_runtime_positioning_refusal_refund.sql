-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- POSITIONING-GATE (Owner 2026-10-12): when Decisions was unavailable and the primary model's fallback rule
-- refused the turn (user without a confirmed positioning asking for own-account social media operations),
-- the round charges nothing; Graylum bears the model cost. Reuses runtime_execution action fail_platform
-- (0215: bill2 confirmed_failure + bill2_finalize compensation, once per call) with one more reason,
-- positioning_required. Nothing else in the function changes.
-- Also adds runtime_positioning_gate(actor), read-only: whether the actor has a confirmed positioning (the 0219 rule)
-- and how many of their rounds were refunded as positioning refusals in the last 24 hours. Admission caps that
-- refund path (5 per 24 hours, POSITIONING-GATE abuse guard, controller 2026-10-14). No remote database use.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE definition text; source_md5 text; patched text;
BEGIN
 definition:=pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure);source_md5:=md5(definition);
 IF source_md5='7525ae8d4e450dd8f03db7fa77e89453' THEN RETURN;END IF;
 IF source_md5<>'3312aaac174e973ac33c29ff2c75dd20' THEN RAISE EXCEPTION 'POSITIONING_REFUSAL_SOURCE_MISMATCH: runtime_execution(uuid,uuid,text,jsonb)';END IF;
 IF (length(definition)-length(replace(definition,$a1$NOT IN ('provider_history','preflight')$a1$,'')))
  <>length($a1$NOT IN ('provider_history','preflight')$a1$) THEN RAISE EXCEPTION 'POSITIONING_REFUSAL_ANCHOR_1';END IF;
 definition:=replace(definition,$a1$NOT IN ('provider_history','preflight')$a1$,
  $b1$NOT IN ('provider_history','preflight','positioning_required')$b1$);
 EXECUTE definition;
 patched:=md5(pg_get_functiondef('public.runtime_execution(uuid,uuid,text,jsonb)'::regprocedure));
 IF patched<>'7525ae8d4e450dd8f03db7fa77e89453' THEN RAISE EXCEPTION 'POSITIONING_REFUSAL_TARGET_MISMATCH: %',patched;END IF;
END $migration$;
-- Counts only fallback refusals refunded in full: positioning_required is written solely by fail_platform (above),
-- and only once the round is settled/refunded and cancelled. A user's own stop never carries this reason.
-- Returns these two values only, never content. Runs on every gated admission: the partial (actor_id, created_at)
-- index below holds only positioning refusals, so the count never scans the actor's other rounds or the table.
CREATE INDEX IF NOT EXISTS runtime_executions_positioning_refusals
 ON public.runtime_executions(actor_id,created_at) WHERE unavailable_reason='positioning_required';
CREATE OR REPLACE FUNCTION public.runtime_positioning_gate(p_actor_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('positioned',public.opc_has_confirmed_positioning(p_actor_id),
  'refusals24h',(SELECT count(*) FROM public.runtime_executions e WHERE e.actor_id=p_actor_id
   AND e.state='cancelled' AND e.unavailable_reason='positioning_required' AND e.created_at>=now()-interval '24 hours'));
$$;
REVOKE ALL ON FUNCTION public.runtime_positioning_gate(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.runtime_positioning_gate(uuid) TO service_role;
COMMIT;
