-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- PUBLISH-MONITOR: a read-only view of the current Post for Me billing period's publish count, for the admin page and the
-- 80% / full alerts. The count itself (social_publish_quota_periods, written only by the publish claim and close) is
-- closed to every client role, and no existing function returns it, so the Owner could not compare it with Post for Me's
-- usage report (Post for Me counts one per platform that was delivered; so does this table: used = successes only).
--   * Returns {configured:false} when the admin has not set publish_monitor_publish_quota; otherwise the period's start and
--     end, the limit, used (delivered platforms) and reserved (held by publishes still open). A period that has no row yet
--     (nobody published in it) reads as 0 used, 0 reserved.
--   * Only the server role may call it; it changes nothing and exposes no user or job data.
-- Compatibility: one new function; nothing existing changes. Repeatable: CREATE OR REPLACE.
-- Recovery: DROP FUNCTION public.publish_monitor_quota_usage();
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE OR REPLACE FUNCTION public.publish_monitor_quota_usage() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE q record;per social_publish_quota_periods;
BEGIN
 BEGIN
  SELECT * INTO q FROM publish_monitor_quota_period();
 EXCEPTION WHEN SQLSTATE '22023' THEN
  RETURN jsonb_build_object('configured',false);
 END;
 SELECT * INTO per FROM social_publish_quota_periods WHERE period_start=q.p_start;
 RETURN jsonb_build_object('configured',true,'periodStart',q.p_start,'periodEnd',q.p_end,'limit',q.p_limit,
  'used',coalesce(per.used,0),'reserved',coalesce(per.reserved,0));
END $$;

REVOKE ALL ON FUNCTION public.publish_monitor_quota_usage() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.publish_monitor_quota_usage() TO service_role;
COMMIT;
