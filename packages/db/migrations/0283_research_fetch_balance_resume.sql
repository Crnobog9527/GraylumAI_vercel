-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- RESEARCH-TOOLS / BILL-PAYG: a research subcall the balance cannot start pauses the turn between two steps and
-- continues after a top-up (MASTER_PLAN §2.1, 2026-10-01). A benchmark_fetch account takes several paid subcalls
-- under one attempt; when the pause falls between them, the attempt is already marked sent (in_progress).
--   * research_account_fetch_resume (new, host only): the answer that holds an in-progress attempt (same execution
--     and the same refresh grant, or none) gets that attempt back; anything else gets null. The host calls it only
--     after research_account_fetch_claim reported in_progress, reuses the subcalls the attempt already finished
--     (stable operation ids) and sends only the rest, so nothing is paid twice. It never changes the row.
--   * research_account_fetch_claim is unchanged, so code deployed before this migration keeps its exact behaviour
--     during a rolling deploy (#1062 review P1).
-- Compatibility: additive function; old code never calls it. Repeatable: CREATE OR REPLACE plus grants.
-- Recovery: DROP FUNCTION public.research_account_fetch_resume(uuid,uuid,uuid,text,text,uuid); paused fetches then
-- stay in progress (the pre-0283 behaviour).
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.research_account_fetch_resume(a uuid, s uuid, e uuid, p_platform text, p_account text,
  p_refresh uuid) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE f research_account_fetches;
BEGIN
  PERFORM research_session_owned(a,s,e);
  SELECT * INTO f FROM research_account_fetches WHERE session_id=s AND platform=p_platform
    AND account_key=encode(sha256(convert_to(s::text||':'||research_account_key(p_platform,p_account),'utf8')),'hex') FOR UPDATE;
  -- Only the answer that marked this attempt sent continues it; another answer never takes it over.
  IF f.id IS NULL OR f.state<>'in_progress' OR f.execution_id IS DISTINCT FROM e OR f.refresh_id IS DISTINCT FROM p_refresh THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object('fetchId',f.id,'attempt',f.attempt);
END $$;

REVOKE ALL ON FUNCTION public.research_account_fetch_resume(uuid,uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.research_account_fetch_resume(uuid,uuid,uuid,text,text,uuid) TO service_role;

COMMIT;
