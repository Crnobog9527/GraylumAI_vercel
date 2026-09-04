/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- BILL-1: forward-only, additive column SELECT contract repair after 0047/0056.
-- Keep existing table, client-role, write, RLS and RPC privileges unchanged.
-- Reapplying these grants is idempotent. No business rows are changed.
-- Recovery: any later privilege narrowing requires a separately reviewed
-- forward migration based on the pre-apply ACL snapshot, not a blanket REVOKE.

GRANT SELECT (
  operation_type,
  amount,
  created_at
) ON TABLE public.billing_history TO service_role;

-- Only the missing columns in the readiness/daily read union; 0047 already
-- grants id, user_id, amount, idempotency_key and balance_after.
-- description is required for legacy spend/refund/adjustment/top-up detection.
GRANT SELECT (
  type,
  ledger_type,
  reason_code,
  counts_as_spend,
  source_type,
  source_order_id,
  grant_period_key,
  balance_before,
  metadata,
  created_at,
  description
) ON TABLE public.credit_transactions TO service_role;

GRANT SELECT (
  updated_at
) ON TABLE public.subscription_credit_grants TO service_role;

DO $$
DECLARE
  v_contract RECORD;
  v_column TEXT;
BEGIN
  FOR v_contract IN
    SELECT * FROM (VALUES
      ('billing_history', ARRAY['operation_type', 'amount', 'created_at']),
      ('credit_transactions', ARRAY[
        'id', 'user_id', 'amount', 'type', 'ledger_type', 'reason_code',
        'counts_as_spend', 'source_type', 'source_order_id', 'grant_period_key',
        'idempotency_key', 'balance_before', 'balance_after', 'metadata',
        'created_at', 'description'
      ]),
      ('subscription_credit_grants', ARRAY[
        'id', 'user_id', 'stripe_subscription_id', 'stripe_invoice_id',
        'billing_cycle', 'grant_type', 'grant_period_key', 'period_index',
        'total_periods', 'credits_granted', 'consumed_amount', 'accounting_state',
        'status', 'idempotency_key', 'credit_transaction_id', 'metadata',
        'created_at', 'updated_at'
      ])
    ) AS required(table_name, columns)
  LOOP
    IF has_table_privilege('service_role', 'public.' || v_contract.table_name, 'SELECT') THEN
      RAISE EXCEPTION
        '0063_bill_1_reconciliation_select_contract unexpected service_role table SELECT on %',
        v_contract.table_name;
    END IF;
    FOREACH v_column IN ARRAY v_contract.columns
    LOOP
      IF NOT has_column_privilege(
        'service_role',
        'public.' || v_contract.table_name,
        v_column,
        'SELECT'
      ) THEN
        RAISE EXCEPTION
          '0063_bill_1_reconciliation_select_contract missing service_role SELECT on %.%',
          v_contract.table_name, v_column;
      END IF;
    END LOOP;
  END LOOP;
END $$;
