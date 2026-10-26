-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- CHECKIN-RETIRE (0396): daily check-in is removed (Owner 2026-10-26: "每日签到功能删除。").
-- Drops the claim RPC (the only path that granted check-in credits) and makes user_checkins a read-only
-- archive. History is kept: check-in credits already recorded stay in credit_transactions (type 'checkin',
-- still allowed and shown as granted credits), and account erasure still deletes user_checkins rows through
-- its SECURITY DEFINER cleanup, which runs as the table owner and is unaffected by the REVOKE below.
-- 0385 patched this function's body to set an idempotency key; dropping it removes that writer, the
-- NOT NULL key constraint and the backfilled 'checkin:' keys stay as they are.
-- The six checkin_* settings no longer have a reader (the app code was removed first, #1443) and are deleted.
-- Deploy order: ship the code that no longer calls the RPC first (#1443), then apply this migration.
-- Rollback: forward-fix only; re-creating the RPC would re-open a retired reward path. The deleted settings
-- were the defaults 5/10/15/20/25/50 (or staging test values) and have no reader.
BEGIN;
SET LOCAL lock_timeout='5s';

DROP FUNCTION IF EXISTS public.claim_daily_checkin(uuid);

DO $retire$
DECLARE missing text;
BEGIN
 SELECT string_agg(p.oid::regprocedure::text,', ') INTO missing FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname='claim_daily_checkin';
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'CHECKIN_RETIRE_OVERLOAD_REMAINS: %',missing; END IF;
END $retire$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.user_checkins FROM PUBLIC, anon, authenticated, service_role;
-- A table-level REVOKE leaves earlier column grants in place; clear any column-level write grant too.
DO $columns$
DECLARE grant_row record;
BEGIN
 FOR grant_row IN SELECT DISTINCT column_name, privilege_type, grantee FROM information_schema.column_privileges
  WHERE table_schema='public' AND table_name='user_checkins'
   AND privilege_type IN ('INSERT','UPDATE') AND grantee IN ('PUBLIC','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE %s (%I) ON TABLE public.user_checkins FROM %s',grant_row.privilege_type,grant_row.column_name,
   CASE WHEN grant_row.grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grant_row.grantee) END);
 END LOOP;
END $columns$;

DELETE FROM public.system_settings
 WHERE key IN ('checkin_day1','checkin_day2','checkin_day3','checkin_day4','checkin_day5','checkin_monthly_bonus');

COMMIT;
