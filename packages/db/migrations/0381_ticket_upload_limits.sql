-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- ARCH-FIX B2 (number 0381 assigned by the controller). Ticket attachments (/api/upload) had no
-- per-user count or byte limit, and an attachment never added to a ticket stayed in Storage until account erasure.
-- 1. ticket_upload_begin now takes the declared byte size and refuses, per profile, more than 20 attachments or
--    50 MB in any rolling 24 hours, and more than 10 in any minute. Usage is what Storage already holds for the
--    profile's prefix (storage.objects rows with their recorded size) plus admissions still in flight (their declared
--    size, kept on the intent), so no new usage table is needed. The existing profile FOR UPDATE serializes admissions.
--    The old two-argument call stays valid during deployment: the size defaults to the 5 MB maximum.
-- 2. ticket_attachment_orphans(limit) lists attachments older than 24 hours that no ticket or ticket reply refers to
--    (by object name, or by an older full Storage URL that points into the bucket),
--    with no live upload intent and no account erasure in progress (erasure removes and proves its own objects).
--    The daily cron removes them through the Storage API; SQL never deletes Storage rows.
-- Repeatable: IF NOT EXISTS column, DROP IF EXISTS of the replaced signature, CREATE OR REPLACE.
-- Rollback: recreate 0190's two-argument ticket_upload_begin (and its grants), drop the three-argument one and
-- ticket_attachment_orphans, drop column ticket_upload_intents.declared_bytes; no business data changes.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE public.ticket_upload_intents ADD COLUMN IF NOT EXISTS declared_bytes bigint NOT NULL DEFAULT 5242880
  CHECK(declared_bytes BETWEEN 1 AND 5242880);
DROP FUNCTION IF EXISTS public.ticket_upload_begin(uuid,uuid);
CREATE OR REPLACE FUNCTION public.ticket_upload_begin(p_profile_id uuid,p_upload_id uuid,p_bytes bigint DEFAULT 5242880)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE p public.profiles; day_count bigint; day_bytes bigint; minute_count bigint;
BEGIN
  IF p_profile_id IS NULL OR p_upload_id IS NULL OR p_bytes IS NULL OR p_bytes NOT BETWEEN 1 AND 5242880 THEN
    RAISE EXCEPTION 'UPLOAD_INVALID' USING ERRCODE='22023';
  END IF;
  SELECT * INTO p FROM public.profiles WHERE id=p_profile_id FOR UPDATE;
  IF p.id IS NULL OR p.status IS DISTINCT FROM 'active' OR p.is_deleted::text IS DISTINCT FROM 'false'
    OR EXISTS(SELECT 1 FROM account_erasure_requests WHERE profile_id=p_profile_id) THEN
    RAISE EXCEPTION 'UPLOAD_ACCOUNT_CLOSED' USING ERRCODE='42501';
  END IF;
  -- Stored objects of the last 24 hours plus admissions not finished yet (an object can briefly count twice).
  SELECT count(*),coalesce(sum(bytes),0),count(*) FILTER (WHERE at>clock_timestamp()-interval '1 minute')
  INTO day_count,day_bytes,minute_count FROM (
    SELECT o.created_at AS at,coalesce((o.metadata->>'size')::bigint,5242880) AS bytes FROM storage.objects o
    WHERE o.bucket_id='ticket-attachments' AND starts_with(o.name,p_profile_id::text||'/')
      AND o.created_at>clock_timestamp()-interval '24 hours'
    UNION ALL
    SELECT i.admitted_at,i.declared_bytes FROM ticket_upload_intents i
    WHERE i.profile_id=p_profile_id AND i.admitted_at>clock_timestamp()-interval '24 hours'
  ) used;
  IF minute_count>=10 THEN RAISE EXCEPTION 'UPLOAD_RATE_LIMITED' USING ERRCODE='P0001'; END IF;
  IF day_count>=20 THEN RAISE EXCEPTION 'UPLOAD_DAILY_COUNT' USING ERRCODE='P0001'; END IF;
  IF day_bytes+p_bytes>52428800 THEN RAISE EXCEPTION 'UPLOAD_DAILY_BYTES' USING ERRCODE='P0001'; END IF;
  -- Never return a second dispatch grant for an existing identity, including an unknown outcome.
  INSERT INTO public.ticket_upload_intents(upload_id,profile_id,declared_bytes) VALUES(p_upload_id,p_profile_id,p_bytes);
  RETURN jsonb_build_object('admitted',true);
END $$;
REVOKE ALL ON FUNCTION public.ticket_upload_begin(uuid,uuid,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_upload_begin(uuid,uuid,bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.ticket_attachment_orphans(p_limit integer DEFAULT 100)
RETURNS text[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  WITH raw AS (
    SELECT value AS ref FROM tickets t,jsonb_array_elements_text(t.attachments) WHERE jsonb_typeof(t.attachments)='array'
    UNION
    SELECT value FROM ticket_replies r,jsonb_array_elements_text(r.attachments) WHERE jsonb_typeof(r.attachments)='array'
  ), referenced AS (
    -- Older rows may hold a full Storage URL (.../ticket-attachments/<name>?...): its object name counts as referenced.
    SELECT CASE WHEN ref ~ '^https?://' THEN split_part(substring(ref FROM '/ticket-attachments/(.*)$'),'?',1)
      ELSE ref END AS name FROM raw
  )
  SELECT coalesce(array_agg(name ORDER BY created_at),'{}') FROM (
    SELECT o.name,o.created_at FROM storage.objects o
    WHERE o.bucket_id='ticket-attachments' AND o.created_at<clock_timestamp()-interval '24 hours'
      AND NOT EXISTS(SELECT 1 FROM referenced x WHERE x.name=o.name)
      AND NOT EXISTS(SELECT 1 FROM ticket_upload_intents i
        WHERE starts_with(o.name,i.profile_id::text||'/'||i.upload_id::text||'.'))
      AND NOT EXISTS(SELECT 1 FROM account_erasure_requests e WHERE starts_with(o.name,e.profile_id::text||'/'))
    ORDER BY o.created_at LIMIT greatest(1,least(coalesce(p_limit,100),1000))
  ) orphan;
$$;
REVOKE ALL ON FUNCTION public.ticket_attachment_orphans(integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ticket_attachment_orphans(integer) TO service_role;
COMMIT;
