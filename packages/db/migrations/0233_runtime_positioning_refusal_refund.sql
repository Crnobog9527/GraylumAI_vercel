-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- POSITIONING-GATE (Owner 2026-10-12): when Decisions was unavailable and the primary model's fallback rule
-- refused the turn (user without a confirmed positioning asking for own-account social media operations),
-- the round charges nothing; Graylum bears the model cost. Reuses runtime_execution action fail_platform
-- (0215: bill2 confirmed_failure + bill2_finalize compensation, once per call) with one more reason,
-- positioning_required. Nothing else in the function changes. No remote database use.
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
COMMIT;
