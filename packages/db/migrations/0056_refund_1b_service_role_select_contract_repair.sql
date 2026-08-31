/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Migration: REFUND-1B service-role select contract repair
-- Description:
--   The locked refund resolver added trusted period-window and consumed-credit
--   reads after migration 0047 established its column-scoped service_role
--   posture. Add only the five SELECT columns now required by
--   loadAllSubscriptionCreditGrants. No write or table-level privilege is
--   broadened.

GRANT SELECT (
  period_start,
  period_end,
  total_periods,
  consumed_amount,
  created_at
) ON TABLE public.subscription_credit_grants TO service_role;

DO $$
DECLARE
  v_column TEXT;
BEGIN
  FOREACH v_column IN ARRAY ARRAY[
    'period_start',
    'period_end',
    'total_periods',
    'consumed_amount',
    'created_at'
  ]
  LOOP
    IF NOT has_column_privilege(
      'service_role',
      'public.subscription_credit_grants',
      v_column,
      'SELECT'
    ) THEN
      RAISE EXCEPTION
        '0056_refund_1b_service_role_select_contract_repair missing service_role SELECT on subscription_credit_grants.%',
        v_column;
    END IF;
  END LOOP;
END $$;
