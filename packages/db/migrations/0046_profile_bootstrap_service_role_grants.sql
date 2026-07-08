/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: profile bootstrap service-role grants
-- Description:
--   Forward-only posture repair for PR #250 server-side ensureProfile.
--   Restores the service_role grants required to create a missing safe
--   bootstrap profile row, run the ledger-backed opening grant, verify the
--   opening-grant ledger idempotency state, and delete the just-created empty
--   profile only when that ledger row does not exist. Source only: do not apply
--   to staging or production without separate owner approval.

DO $$
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'public.profiles is required before applying 0046_profile_bootstrap_service_role_grants';
  END IF;
END $$;

-- PR #250 moved profile bootstrap to the server-side service-role client.
-- Keep direct profile creation closed to browser/client roles, including any
-- legacy column-level grant that may still exist on environments where 0027 was
-- applied before the staging drift.
REVOKE INSERT ON TABLE public.profiles FROM PUBLIC;
REVOKE INSERT ON TABLE public.profiles FROM anon;
REVOKE INSERT ON TABLE public.profiles FROM authenticated;
REVOKE INSERT (
  id,
  email,
  nickname,
  avatar_url,
  role,
  status,
  membership_level,
  credits
) ON TABLE public.profiles FROM PUBLIC;
REVOKE INSERT (
  id,
  email,
  nickname,
  avatar_url,
  role,
  status,
  membership_level,
  credits
) ON TABLE public.profiles FROM anon;
REVOKE INSERT (
  id,
  email,
  nickname,
  avatar_url,
  role,
  status,
  membership_level,
  credits
) ON TABLE public.profiles FROM authenticated;

REVOKE DELETE ON TABLE public.profiles FROM PUBLIC;
REVOKE DELETE ON TABLE public.profiles FROM anon;
REVOKE DELETE ON TABLE public.profiles FROM authenticated;

DROP POLICY IF EXISTS "profiles_insert_own_zero_credits" ON public.profiles;

-- Service-role bootstrap needs to:
-- 1. SELECT profile state by id.
-- 2. INSERT only the safe fields written by PR #250 ensureProfile.
-- 3. SELECT opening-grant ledger state before any cleanup delete.
-- 4. DELETE only a still-safe zero-credit bootstrap profile, so a committed
--    opening grant that already moved credits to 100 is not orphaned.
GRANT SELECT ON TABLE public.profiles TO service_role;
GRANT INSERT (
  id,
  email,
  nickname,
  role,
  status,
  membership_level,
  credits
) ON TABLE public.profiles TO service_role;
GRANT DELETE ON TABLE public.profiles TO service_role;
GRANT SELECT ON TABLE public.credit_transactions TO service_role;

-- Opening credits must still be written through the atomic ledger RPC, not by a
-- direct profile credit grant or client-callable function.
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.atomic_apply_credit_ledger_entry(UUID, INTEGER, TEXT, TEXT, TEXT) TO service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'profiles_select_own'
  ) THEN
    EXECUTE $comment$
      COMMENT ON POLICY "profiles_select_own" ON public.profiles
        IS 'Users may read their own profile; missing profile bootstrap is handled server-side by service_role grants in 0046.'
    $comment$;
  END IF;
END $$;
