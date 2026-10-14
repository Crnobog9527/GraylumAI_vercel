-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- INVITE-RETIRE (0264): invitation rewards are retired (Owner 2026-10-14: "取消邀请码送积分，联盟营销上线后做").
-- Drops the three invitation RPCs (claim with 50/30 reward, consumption rebate, public code validation) and
-- makes the two invitation tables a read-only archive. Rows and the credit ledger are kept: rewards already
-- recorded stay in credit_transactions, and account erasure still reviews invitation_records with personal data.
-- Foreign-key actions and SECURITY DEFINER erasure functions run as the table owner and are unaffected.
-- Deploy order (production): ship the code that no longer calls these RPCs first, then apply this migration.
-- Rollback: forward-fix only; re-creating the RPCs would re-open a retired reward path.
BEGIN;
SET LOCAL lock_timeout='5s';

DROP FUNCTION IF EXISTS public.atomic_claim_invitation_code(text,uuid,text,text,text,text,integer,integer,text,text);
DROP FUNCTION IF EXISTS public.atomic_apply_invitation_rebate(uuid,integer,text,integer,integer,integer,
  timestamp with time zone,timestamp with time zone,text);
DROP FUNCTION IF EXISTS public.validate_invitation_code(text);

DO $retire$
DECLARE missing text;
BEGIN
 SELECT string_agg(p.oid::regprocedure::text,', ') INTO missing FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND p.proname IN ('atomic_claim_invitation_code','atomic_apply_invitation_rebate','validate_invitation_code');
 IF missing IS NOT NULL THEN RAISE EXCEPTION 'INVITE_RETIRE_OVERLOAD_REMAINS: %',missing; END IF;
END $retire$;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.invitations, public.invitation_records
  FROM PUBLIC, anon, authenticated, service_role;
-- A table-level REVOKE leaves earlier column grants in place; clear any column-level write grant too.
DO $columns$
DECLARE grant_row record;
BEGIN
 FOR grant_row IN SELECT DISTINCT table_name, column_name, privilege_type, grantee FROM information_schema.column_privileges
  WHERE table_schema='public' AND table_name IN ('invitations','invitation_records')
   AND privilege_type IN ('INSERT','UPDATE') AND grantee IN ('PUBLIC','anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE %s (%I) ON TABLE public.%I FROM %s',grant_row.privilege_type,grant_row.column_name,
   grant_row.table_name,CASE WHEN grant_row.grantee='PUBLIC' THEN 'PUBLIC' ELSE quote_ident(grant_row.grantee) END);
 END LOOP;
END $columns$;

COMMIT;
