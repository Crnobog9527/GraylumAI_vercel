/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: YEAR-1 annual calendar period keys
-- Description:
--   Adds the unconditional uniqueness barrier for subscription credit grant
--   period keys. YEAR-1 replaces millisecond-divided annual periods with UTC
--   calendar-month periods keyed by `annual:<term-start-iso>:<NN>`, so the
--   database must reject a second row for the same subscription and period
--   key regardless of which writer (webhook or cron) races. Existing
--   duplicate groups are a stop condition for Owner adjudication: this
--   migration fails closed instead of auto-resolving them.
--   Expand-only: no column/type/function/grant changes.

DO $$
DECLARE
  duplicate_groups integer;
BEGIN
  SELECT count(*) INTO duplicate_groups
  FROM (
    SELECT public.subscription_credit_grants.stripe_subscription_id,
           public.subscription_credit_grants.grant_period_key
    FROM public.subscription_credit_grants
    GROUP BY 1, 2
    HAVING count(*) > 1
  ) AS duplicates;

  IF duplicate_groups > 0 THEN
    RAISE EXCEPTION
      'YEAR-1 pre-check failed: % duplicate (stripe_subscription_id, grant_period_key) group(s) exist; stop for Owner adjudication, do not auto-resolve',
      duplicate_groups;
  END IF;
END
$$;

ALTER TABLE public.subscription_credit_grants
  ADD CONSTRAINT subscription_credit_grants_subscription_period_key_key
  UNIQUE (stripe_subscription_id, grant_period_key);
