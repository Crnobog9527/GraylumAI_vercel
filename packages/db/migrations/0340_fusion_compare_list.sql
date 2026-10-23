/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-COMPARE PR-2c (docs/launch/tasks/FUSION-COMPARE.md §3.4, §4 fusionCompare.list). Number 0340 assigned by the controller (2026-10-23).
-- The compare cards of one conversation, so a reloaded page can show them in place and recognise the adopted answer
-- (adoption.executionId is written only by fusion_compare_adopt, so the page cannot forge it). fusion_compares is closed
-- to every API role (0290), hence a SECURITY DEFINER reader with the same ownership and deletion checks as
-- fusion_compare_read. Read only: no table, no existing function and no data change.
-- Also fusion_compare_unjudged: compare calls whose answer was saved but whose verdict was never written (the process ended
-- between the two), for the daily recovery to judge before settlement, as fusion_review_unjudged does for reviews.
-- Also fusion_compare_dispatch_claim: an exclusive, one-winner claim to dispatch one compare column. bill2_dispatch's rotation
-- always succeeds on a prepared call (the later rotation steals the earlier token), so it cannot decide which of two requests
-- for the same column (two tabs, a retry) dispatches; the claim does, before any call-gate unit is taken. The claim is a lease:
-- one that was never followed by a dispatch can be taken again after two minutes, and a confirmed no-start releases it at once.
-- Rollback: DROP FUNCTION public.fusion_compare_list(uuid,uuid,uuid), public.fusion_compare_unjudged(integer),
-- public.fusion_compare_dispatch_claim(uuid,uuid), public.fusion_compare_dispatch_release(uuid,uuid); DROP TABLE public.fusion_compare_dispatch_claims (it holds only call ids and
-- times); nothing depends on them except the compare routes (behind the compare switch, off by default) and the recovery step.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- p_compare_id: one exact compare of the conversation (adoption and its replay), never cut by the newest-50 page.
CREATE OR REPLACE FUNCTION public.fusion_compare_list(p_actor_id uuid, p_session_id uuid, p_compare_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE cards jsonb;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  -- A deleted or foreign conversation lists nothing (its compares are cleaned with it, 0290).
  IF NOT EXISTS(SELECT 1 FROM runtime_sessions WHERE id=p_session_id AND actor_id=p_actor_id
    AND content_deleted_at IS NULL AND erased_at IS NULL) THEN RETURN '[]'::jsonb; END IF;
  -- Refused starts never showed a card; the newest 50 are enough for one conversation page.
  SELECT coalesce(jsonb_agg(card ORDER BY created_at),'[]') INTO cards FROM (
    -- workspaceDependencies: adoption must repeat them exactly (fusion_compare_adopt compares the jsonb).
    SELECT fusion_compare_view(fc)||jsonb_build_object('question',fc.question,'workspaceDependencies',fc.workspace_dependencies) card,
      fc.created_at
    FROM fusion_compares fc WHERE fc.actor_id=p_actor_id AND fc.session_id=p_session_id AND fc.group_id IS NOT NULL
      AND (p_compare_id IS NULL OR fc.id=p_compare_id)
    ORDER BY fc.created_at DESC LIMIT 50) x;
  RETURN cards;
END $$;
REVOKE ALL ON FUNCTION public.fusion_compare_list(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_compare_list(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fusion_compare_unjudged(p_limit integer)
RETURNS TABLE(actor_id uuid, compare_id uuid, call_id uuid, run_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT fc.actor_id, fc.id, c.id, br.id
  FROM fusion_compares fc JOIN bill2_runs br ON br.fusion_group_id=fc.group_id AND br.actor_id=fc.actor_id
  JOIN bill2_calls c ON c.run_id=br.id
  WHERE fc.group_id IS NOT NULL AND c.fusion_verdict IS NULL AND c.settled_at IS NULL
    AND EXISTS(SELECT 1 FROM fusion_call_outputs o WHERE o.call_id=c.id)
  ORDER BY c.created_at, c.id LIMIT least(greatest(coalesce(p_limit,50),1),200);
$$;
REVOKE ALL ON FUNCTION public.fusion_compare_unjudged(integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_compare_unjudged(integer) TO service_role;

CREATE TABLE IF NOT EXISTS public.fusion_compare_dispatch_claims (
  call_id uuid CONSTRAINT fusion_compare_dispatch_claims_pk PRIMARY KEY,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.fusion_compare_dispatch_claims ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.fusion_compare_dispatch_claims FROM PUBLIC, anon, authenticated, service_role;

-- True for exactly one caller per call (and per lease): the call must be an undispatched column of one of this actor's compares.
CREATE OR REPLACE FUNCTION public.fusion_compare_dispatch_claim(p_actor_id uuid, p_call_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE won uuid;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF NOT EXISTS(SELECT 1 FROM bill2_calls c JOIN bill2_runs br ON br.id=c.run_id JOIN fusion_compares fc ON fc.group_id=br.fusion_group_id
    WHERE c.id=p_call_id AND br.actor_id=p_actor_id AND fc.actor_id=p_actor_id AND c.dispatched_at IS NULL AND c.settled_at IS NULL)
  THEN RETURN false; END IF;
  INSERT INTO fusion_compare_dispatch_claims(call_id) VALUES(p_call_id)
    ON CONFLICT (call_id) DO UPDATE SET claimed_at=clock_timestamp()
      WHERE fusion_compare_dispatch_claims.claimed_at < clock_timestamp()-interval '2 minutes'
    RETURNING call_id INTO won;
  RETURN won IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.fusion_compare_dispatch_claim(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_compare_dispatch_claim(uuid,uuid) TO service_role;

-- A column whose provider connection was confirmed never started (BILL2 restored the call to prepared) gives its claim back, so
-- the next request can dispatch it within the call's dispatch window instead of waiting out the lease.
CREATE OR REPLACE FUNCTION public.fusion_compare_dispatch_release(p_actor_id uuid, p_call_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE gone uuid;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  DELETE FROM fusion_compare_dispatch_claims d USING bill2_calls c JOIN bill2_runs br ON br.id=c.run_id
    JOIN fusion_compares fc ON fc.group_id=br.fusion_group_id
    WHERE d.call_id=p_call_id AND c.id=p_call_id AND br.actor_id=p_actor_id AND fc.actor_id=p_actor_id
      AND c.dispatched_at IS NULL AND c.settled_at IS NULL
    RETURNING d.call_id INTO gone;
  RETURN gone IS NOT NULL;
END $$;
REVOKE ALL ON FUNCTION public.fusion_compare_dispatch_release(uuid,uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.fusion_compare_dispatch_release(uuid,uuid) TO service_role;

COMMIT;
