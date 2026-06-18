/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

-- Smoke test for 0044_credit_transactions_v2_semantics.sql.
-- Run against a migrated database with psql; the transaction rolls back all test data.

BEGIN;

DO $$
DECLARE
  v_user_id UUID := gen_random_uuid();
  v_row RECORD;
BEGIN
  INSERT INTO profiles (id, email, credits, membership_level)
  VALUES (v_user_id, 'credit-ledger-v2@example.test', 1000, 'free');

  INSERT INTO credit_transactions (user_id, amount, type, description, idempotency_key)
  VALUES (v_user_id, -120, 'deduction', 'AI 对话消费', 'ai_spend:test');

  SELECT ledger_type, reason_code, counts_as_spend, source_type
  INTO v_row
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'ai_spend:test';

  IF v_row.ledger_type <> 'spend'
    OR v_row.reason_code <> 'ai_task_spend'
    OR v_row.counts_as_spend IS NOT TRUE
    OR v_row.source_type <> 'ai_task' THEN
    RAISE EXCEPTION 'AI spend v2 classification failed: %', row_to_json(v_row);
  END IF;

  INSERT INTO credit_transactions (user_id, amount, type, description, idempotency_key)
  VALUES (
    v_user_id,
    -80,
    'deduction',
    'Stripe refund credit clawback [order:00000000-0000-0000-0000-000000000000 refund:re_v2 shortfall:0]',
    'stripe_refund:re_v2'
  );

  SELECT ledger_type, reason_code, counts_as_spend, source_type, source_refund_id
  INTO v_row
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'stripe_refund:re_v2';

  IF v_row.ledger_type <> 'refund_clawback'
    OR v_row.reason_code <> 'refund_clawback'
    OR v_row.counts_as_spend IS NOT FALSE
    OR v_row.source_type <> 'stripe_refund'
    OR v_row.source_refund_id <> 're_v2' THEN
    RAISE EXCEPTION 'refund clawback v2 classification failed: %', row_to_json(v_row);
  END IF;

  INSERT INTO credit_transactions (user_id, amount, type, description, idempotency_key)
  VALUES (v_user_id, 500, 'purchase', 'Stripe 购买积分包: Starter [checkout:cs_test_v2]', 'grant:test');

  SELECT ledger_type, reason_code, counts_as_spend, source_type
  INTO v_row
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'grant:test';

  IF v_row.ledger_type <> 'grant'
    OR v_row.reason_code <> 'topup_purchase'
    OR v_row.counts_as_spend IS NOT FALSE
    OR v_row.source_type <> 'stripe_checkout' THEN
    RAISE EXCEPTION 'grant v2 classification failed: %', row_to_json(v_row);
  END IF;

  INSERT INTO credit_transactions (user_id, amount, type, description, idempotency_key)
  VALUES (v_user_id, -30, 'deduction', '管理员手动调整', 'admin_adjustment:test');

  SELECT ledger_type, reason_code, counts_as_spend, source_type
  INTO v_row
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'admin_adjustment:test';

  IF v_row.ledger_type <> 'adjustment'
    OR v_row.reason_code <> 'admin_adjustment'
    OR v_row.counts_as_spend IS NOT FALSE
    OR v_row.source_type <> 'admin' THEN
    RAISE EXCEPTION 'adjustment v2 classification failed: %', row_to_json(v_row);
  END IF;

  INSERT INTO credit_transactions (user_id, amount, type, description, idempotency_key)
  VALUES (v_user_id, -25, 'deduction', '积分消费', 'admin_credit_deduction:admin-1:manual-1');

  SELECT ledger_type, reason_code, counts_as_spend, source_type
  INTO v_row
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'admin_credit_deduction:admin-1:manual-1';

  IF v_row.ledger_type <> 'adjustment'
    OR v_row.reason_code <> 'admin_adjustment'
    OR v_row.counts_as_spend IS NOT FALSE
    OR v_row.source_type <> 'admin' THEN
    RAISE EXCEPTION 'default admin deduction v2 classification failed: %', row_to_json(v_row);
  END IF;

  INSERT INTO credit_transactions (user_id, amount, type, description, idempotency_key)
  VALUES (v_user_id, 25, 'addition', '[Admin] manual top-up', 'admin_adjustment:admin-1:user-1:manual-top-up');

  SELECT ledger_type, reason_code, counts_as_spend, source_type
  INTO v_row
  FROM credit_transactions
  WHERE user_id = v_user_id
    AND idempotency_key = 'admin_adjustment:admin-1:user-1:manual-top-up';

  IF v_row.ledger_type <> 'adjustment'
    OR v_row.reason_code <> 'admin_adjustment'
    OR v_row.counts_as_spend IS NOT FALSE
    OR v_row.source_type <> 'admin' THEN
    RAISE EXCEPTION 'positive admin adjustment v2 classification failed: %', row_to_json(v_row);
  END IF;
END;
$$;

ROLLBACK;
