/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
-- FUSION-BACKGROUND (Owner 2026-10-15 "现在就做。"): reviews advance on the server, one step per function invocation,
-- so the user may leave the page. Number allocated by the controller. Adds an advance lease (one advancer at a time),
-- a cumulative advance counter (a hard stop for a runaway relay), a daily kick marker and a "seen" marker for the
-- completion notice. All functions are service-role only with a fixed search_path; no existing function changes.
BEGIN;

ALTER TABLE public.fusion_reviews ADD COLUMN IF NOT EXISTS advance_token uuid,
  ADD COLUMN IF NOT EXISTS advance_until timestamptz,
  ADD COLUMN IF NOT EXISTS advance_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS advance_kicked_at timestamptz,
  ADD COLUMN IF NOT EXISTS seen_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fusion_reviews_advance_lease_complete') THEN
    ALTER TABLE public.fusion_reviews ADD CONSTRAINT fusion_reviews_advance_lease_complete CHECK (
      (advance_token IS NULL) = (advance_until IS NULL) AND advance_count >= 0);
  END IF;
END $$;
-- The completion notice lists a user's latest reviews.
CREATE INDEX IF NOT EXISTS fusion_reviews_actor_recent_idx ON public.fusion_reviews(actor_id, created_at DESC);

-- Takes the advance lease of a review that is still running or paused. Only one holder at a time: a live lease of
-- another token refuses, an expired one is taken over. A row another transaction holds (a claim, a close) refuses
-- at once (NOWAIT), never waits. Every grant counts toward p_max: past it the lease is refused for good and the
-- caller alerts (a relay bug must not call itself forever). Returns {acquired, reason, actorId, count}.
CREATE OR REPLACE FUNCTION public.fusion_review_advance_lease(p_review_id uuid, p_token uuid, p_ttl interval, p_max integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rv fusion_reviews;
BEGIN
  IF p_review_id IS NULL OR p_token IS NULL OR p_ttl IS NULL OR p_ttl<=interval '0' OR p_ttl>interval '10 minutes'
    OR p_max IS NULL OR p_max<1 THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  BEGIN
    SELECT * INTO rv FROM fusion_reviews WHERE id=p_review_id FOR UPDATE NOWAIT;
  EXCEPTION WHEN lock_not_available THEN
    RETURN jsonb_build_object('acquired',false,'reason','busy');
  END;
  IF rv.id IS NULL THEN RETURN jsonb_build_object('acquired',false,'reason','missing'); END IF;
  IF rv.state NOT IN ('running','paused') THEN
    RETURN jsonb_build_object('acquired',false,'reason','ended','actorId',rv.actor_id);
  END IF;
  IF rv.advance_token IS NOT NULL AND rv.advance_token<>p_token AND rv.advance_until>clock_timestamp() THEN
    RETURN jsonb_build_object('acquired',false,'reason','leased','actorId',rv.actor_id);
  END IF;
  IF rv.advance_count>=p_max THEN
    RETURN jsonb_build_object('acquired',false,'reason','limit','actorId',rv.actor_id,'count',rv.advance_count);
  END IF;
  UPDATE fusion_reviews SET advance_token=p_token,advance_until=clock_timestamp()+p_ttl,advance_count=advance_count+1
    WHERE id=rv.id RETURNING * INTO rv;
  RETURN jsonb_build_object('acquired',true,'reason','acquired','actorId',rv.actor_id,'count',rv.advance_count);
END $$;

-- Refund expected no-work stops only while releasing the same holder; stale holders cannot refund a later lease.
DROP FUNCTION IF EXISTS public.fusion_review_advance_release(uuid,uuid);
CREATE OR REPLACE FUNCTION public.fusion_review_advance_release(p_review_id uuid, p_token uuid, p_refund boolean DEFAULT false)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE fusion_reviews SET advance_token=NULL,advance_until=NULL,
    advance_count=greatest(0,advance_count-CASE WHEN p_refund THEN 1 ELSE 0 END)
    WHERE id=p_review_id AND advance_token=p_token;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;

-- Daily backstop: reviews still running or paused, with no live lease and no movement for p_idle, that were not
-- kicked in the last day. Marks them kicked in the same statement, so each is kicked at most once a day; rows
-- another transaction holds are skipped (SKIP LOCKED).
DROP FUNCTION IF EXISTS public.fusion_review_kick_stalled(interval,integer);
CREATE OR REPLACE FUNCTION public.fusion_review_kick_stalled(p_idle interval, p_limit integer)
RETURNS TABLE(review_id uuid, kicked_at timestamptz) LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF p_idle IS NULL OR p_idle<interval '1 minute' THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  RETURN QUERY
  UPDATE fusion_reviews rv SET advance_kicked_at=clock_timestamp()
  WHERE rv.id IN (SELECT id FROM fusion_reviews WHERE state IN ('running','paused')
      AND updated_at<=clock_timestamp()-p_idle
      AND (advance_until IS NULL OR advance_until<=clock_timestamp())
      AND (advance_kicked_at IS NULL OR advance_kicked_at<=clock_timestamp()-interval '1 day')
      ORDER BY updated_at LIMIT least(greatest(coalesce(p_limit,20),1),100) FOR UPDATE SKIP LOCKED)
  RETURNING rv.id,rv.advance_kicked_at;
END $$;

-- Undo only the caller's reservation when a kick failed or was not attempted. Table access remains revoked.
CREATE OR REPLACE FUNCTION public.fusion_review_kick_reset(p_review_id uuid, p_kicked_at timestamptz)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
  UPDATE fusion_reviews SET advance_kicked_at=NULL WHERE id=p_review_id AND advance_kicked_at=p_kicked_at;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $$;

-- The completion notice: a user's latest reviews with what the page needs to show "评审已完成，待选择" or "已暂停".
DROP FUNCTION IF EXISTS public.fusion_review_mine(uuid,integer);
CREATE OR REPLACE FUNCTION public.fusion_review_mine(p_actor_id uuid, p_limit integer,
  p_draft_id uuid DEFAULT NULL, p_before_created_at timestamptz DEFAULT NULL, p_before_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM bill2_actor(p_actor_id);
  IF (p_before_created_at IS NULL) <> (p_before_id IS NULL) THEN RAISE EXCEPTION 'FUSION_REVIEW_INVALID'; END IF;
  RETURN coalesce((SELECT jsonb_agg(item ORDER BY created DESC, id DESC) FROM (
    SELECT rv.created_at AS created, rv.id, jsonb_build_object('reviewId',rv.id,'draftId',rv.draft_id,
      'sourceVersionId',rv.source_version_id,'round',rv.round,'phase',rv.phase,'state',rv.state,'outcomeKind',rv.outcome->>'kind',
      'awaitingChoice',coalesce(rv.state='completed' AND rv.outcome->>'kind'='revised'
        AND coalesce(rv.adoption->>'state','')<>'recorded',false),
      'createdAt',rv.created_at,'endedAt',rv.ended_at,'seenAt',rv.seen_at) AS item
    FROM fusion_reviews rv WHERE rv.actor_id=p_actor_id
      AND (p_draft_id IS NULL OR rv.draft_id=p_draft_id)
      AND (p_before_created_at IS NULL OR (rv.created_at,rv.id)<(p_before_created_at,p_before_id))
    ORDER BY rv.created_at DESC, rv.id DESC LIMIT least(greatest(coalesce(p_limit,10),1),50)) x),'[]'::jsonb);
END $$;

-- Marks the notice of the user's own review as seen (idempotent; the first time is kept).
CREATE OR REPLACE FUNCTION public.fusion_review_mark_seen(p_actor_id uuid, p_review_id uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE n integer;
BEGIN
  PERFORM bill2_actor(p_actor_id);
  UPDATE fusion_reviews SET seen_at=coalesce(seen_at,clock_timestamp()) WHERE id=p_review_id AND actor_id=p_actor_id;
  GET DIAGNOSTICS n=ROW_COUNT;
  IF n=0 THEN RAISE EXCEPTION 'FUSION_REVIEW_DENIED'; END IF;
  RETURN true;
END $$;

DO $$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['fusion_review_advance_lease(uuid,uuid,interval,integer)',
    'fusion_review_advance_release(uuid,uuid,boolean)','fusion_review_kick_stalled(interval,integer)',
    'fusion_review_kick_reset(uuid,timestamp with time zone)',
    'fusion_review_mine(uuid,integer,uuid,timestamp with time zone,uuid)','fusion_review_mark_seen(uuid,uuid)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role', f);
  END LOOP;
END $$;

COMMIT;
