-- Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved.
-- LOCAL-ONLY check on a database built by run-db-baseline-replay.mjs (0148 applied): every
-- legitimate credit write still works with trg_prevent_client_profile_credit_write installed, and
-- the trigger does block a client role that could otherwise write credits. Synthetic rows only.
-- The guard looks at current_user: inside a SECURITY DEFINER function it is the owner (postgres).
\set ON_ERROR_STOP on
INSERT INTO public.profiles (id, email, role, credits) VALUES
  ('00000000-0000-4000-8000-00000000c001', 'user@example.invalid', 'user', 0),
  ('00000000-0000-4000-8000-00000000c002', 'inviter@example.invalid', 'user', 0),
  ('00000000-0000-4000-8000-00000000c003', 'closing@example.invalid', 'user', 0);
CREATE TEMP TABLE guard_results(path text, ok boolean);
GRANT INSERT ON guard_results TO authenticated, service_role;

-- 1. Opening grant and admin adjustUserCredits: service_role -> atomic_apply_credit_ledger_entry.
SET ROLE service_role;
SELECT public.atomic_apply_credit_ledger_entry('00000000-0000-4000-8000-00000000c001', 100, 'addition',
  'opening grant', 'opening-grant:c001');
SELECT public.atomic_apply_credit_ledger_entry('00000000-0000-4000-8000-00000000c001', -10, 'deduction',
  'admin adjust', 'admin-adjust:c001');
RESET ROLE;
INSERT INTO guard_results SELECT 'ledger entry (opening grant, admin adjust) via service_role',
  credits = 90 FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000c001';

-- 2. Daily check-in: the authenticated user calls the SECURITY DEFINER RPC for themself.
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-00000000c001","role":"authenticated"}', false);
SELECT public.claim_daily_checkin('00000000-0000-4000-8000-00000000c001');
RESET ROLE;
INSERT INTO guard_results SELECT 'daily check-in as authenticated', credits > 90
  FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000c001';

-- 3. BILL2 legacy pre-deduct (service_role) and settle/refund (called inside BILL2's definer chain).
SET ROLE service_role;
SELECT public.atomic_pre_deduct('00000000-0000-4000-8000-00000000c001', 20, 'pre-deduct',
  '00000000-0000-4000-8000-0000000000d1');
RESET ROLE;
CREATE TEMP TABLE guard_balance AS SELECT credits FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000c001';
SELECT public.bill2_legacy_settle('00000000-0000-4000-8000-00000000c001',
  (SELECT id FROM public.billing_history WHERE user_id = '00000000-0000-4000-8000-00000000c001'
    AND operation_type = 'pre_deduct' ORDER BY created_at DESC LIMIT 1), 5);
INSERT INTO guard_results SELECT 'BILL2 pre-deduct (service_role) + settle refunds the unused part',
  p.credits = b.credits + 15 FROM public.profiles p, guard_balance b
  WHERE p.id = '00000000-0000-4000-8000-00000000c001';

-- 4. Invitation rebate: service_role, inviter credited for the invitee's consumption.
INSERT INTO public.invitation_records (invite_code, inviter_id, invitee_id, status)
  VALUES ('GUARD01', '00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000c001', 'rewarded');
SET ROLE service_role;
SELECT * FROM public.atomic_apply_invitation_rebate('00000000-0000-4000-8000-00000000c001', 100, 'guard-pre-1', 10);
RESET ROLE;
INSERT INTO guard_results SELECT 'invitation rebate via service_role', credits > 0
  FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000c002';

-- 5. Profile bootstrap by service_role (trpc.ts inserts credits 0; the opening grant is step 1).
SET ROLE service_role;
INSERT INTO public.profiles (id, email, nickname, role, status, membership_level, credits)
  VALUES ('00000000-0000-4000-8000-00000000c004', 'new@example.invalid', 'New', 'user', 'active', 'free', 0);
UPDATE public.profiles SET email = 'synced@example.invalid' WHERE id = '00000000-0000-4000-8000-00000000c004';
RESET ROLE;
INSERT INTO guard_results SELECT 'service_role profile bootstrap insert and email sync', email = 'synced@example.invalid'
  FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000c004';

-- 6. Own nickname update by the authenticated user (credits unchanged).
SET ROLE authenticated;
UPDATE public.profiles SET nickname = 'Renamed' WHERE id = '00000000-0000-4000-8000-00000000c001';
RESET ROLE;
INSERT INTO guard_results SELECT 'authenticated own nickname update', nickname = 'Renamed'
  FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000c001';

-- 7. Account erasure confirm (#526, applied before this file when present): service_role RPC.
DO $$
BEGIN
  IF to_regprocedure('public.account_erasure_confirm(uuid,uuid)') IS NULL THEN
    INSERT INTO guard_results VALUES ('account erasure confirm (#526 not applied: skipped)', true);
  END IF;
END $$;
SELECT to_regprocedure('public.account_erasure_confirm(uuid,uuid)') IS NOT NULL AS has_erasure \gset
\if :has_erasure
SELECT to_regprocedure('public.account_erasure_confirm_with_digests(uuid,uuid,jsonb)') IS NOT NULL AS has_erasure_digests \gset
\if :has_erasure_digests
-- Synthetic prehashed fixture only. Actual identity derivation is covered by the PR-E Auth runner.
SET ROLE service_role;
SELECT public.account_erasure_confirm_with_digests(
  '00000000-0000-4000-8000-00000000c003', '00000000-0000-4000-8000-0000000000e1',
  jsonb_build_array(jsonb_build_object('kind', 'email', 'key_version', 'test-v1', 'digest', repeat('e',64))));
RESET ROLE;
\else
SET ROLE service_role;
SELECT public.account_erasure_confirm('00000000-0000-4000-8000-00000000c003', '00000000-0000-4000-8000-0000000000e1');
RESET ROLE;
\endif
INSERT INTO guard_results SELECT 'account erasure confirm (#526) via service_role', status = 'deleted' AND credits = 0
  FROM public.profiles WHERE id = '00000000-0000-4000-8000-00000000c003';
\endif

-- 8. Control: with a (hypothetically widened) client credit grant, the guard still blocks.
GRANT UPDATE (credits) ON public.profiles TO authenticated;
SET ROLE authenticated;
DO $$
BEGIN
  UPDATE public.profiles SET credits = credits + 1000 WHERE id = '00000000-0000-4000-8000-00000000c001';
  INSERT INTO guard_results VALUES ('control: client credit write is blocked by the guard', false);
EXCEPTION WHEN insufficient_privilege THEN
  -- Must be the guard itself, not RLS or a missing grant (same SQLSTATE).
  INSERT INTO guard_results VALUES ('control: client credit write is blocked by the guard',
    SQLERRM = 'client role cannot update profile credits');
END $$;
RESET ROLE;
REVOKE UPDATE (credits) ON public.profiles FROM authenticated;

SELECT path || ': ' || CASE WHEN ok THEN 'PASS' ELSE 'FAIL' END FROM guard_results;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM guard_results WHERE NOT ok) OR (SELECT count(*) FROM guard_results) < 8 THEN
    RAISE EXCEPTION 'credit guard path check failed';
  END IF;
END $$;
