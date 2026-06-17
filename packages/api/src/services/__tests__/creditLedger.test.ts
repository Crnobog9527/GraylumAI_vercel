/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import {
  countsAsCreditSpend,
  countsAsTopupPurchaseCredit,
  inferCreditReasonCode,
  normalizeCreditLedgerType,
  normalizeCreditTransactionRow,
} from '../creditLedger';

describe('credit ledger v2 semantics', () => {
  it('counts only AI spend as monthly consumption', () => {
    expect(countsAsCreditSpend({
      amount: -40,
      type: 'deduction',
      ledger_type: 'spend',
      counts_as_spend: true,
    })).toBe(true);

    expect(countsAsCreditSpend({
      amount: -40,
      type: 'deduction',
      ledger_type: 'refund_clawback',
      counts_as_spend: false,
    })).toBe(false);

    expect(countsAsCreditSpend({
      amount: -40,
      type: 'deduction',
      description: 'Stripe refund credit clawback [refund:re_123]',
      idempotency_key: 'stripe_refund:re_123',
    })).toBe(false);

    expect(countsAsCreditSpend({
      amount: -40,
      type: 'deduction',
      description: '积分消费',
      idempotency_key: 'admin_credit_deduction:admin-1:request-1',
    })).toBe(false);

    expect(countsAsCreditSpend({
      amount: -40,
      type: 'deduction',
      source_type: 'admin',
    })).toBe(false);

    expect(countsAsCreditSpend({
      amount: -40,
      type: 'deduction',
      description: '积分消费',
    })).toBe(false);
  });

  it('maps legacy transaction types without losing refund clawback semantics', () => {
    expect(normalizeCreditLedgerType({
      amount: -12,
      type: 'deduction',
      description: 'AI 对话消费',
    })).toBe('spend');

    expect(normalizeCreditLedgerType({
      amount: -12,
      type: 'deduction',
      description: '积分消费',
      idempotency_key: 'admin_credit_deduction:admin-1:request-1',
    })).toBe('adjustment');

    expect(normalizeCreditLedgerType({
      amount: 25,
      type: 'addition',
      description: '[Admin] manual top-up',
      idempotency_key: 'admin_adjustment:admin-1:user-1:request-1',
    })).toBe('adjustment');

    expect(inferCreditReasonCode({
      amount: 25,
      type: 'addition',
      description: '[Admin] manual top-up',
      idempotency_key: 'admin_adjustment:admin-1:user-1:request-1',
    })).toBe('admin_adjustment');

    expect(normalizeCreditLedgerType({
      amount: 100,
      type: 'purchase',
      description: 'Stripe 购买积分包: Starter [checkout:cs_test]',
    })).toBe('grant');

    expect(normalizeCreditLedgerType({
      amount: -80,
      type: 'deduction',
      description: 'Stripe refund credit clawback [refund:re_123]',
      idempotency_key: 'stripe_refund:re_123',
    })).toBe('refund_clawback');

    expect(inferCreditReasonCode({
      amount: -80,
      type: 'deduction',
      description: 'Stripe refund credit clawback [refund:re_123]',
      idempotency_key: 'stripe_refund:re_123',
    })).toBe('refund_clawback');
  });

  it('normalizes rows returned by the credits router', () => {
    expect(normalizeCreditTransactionRow({
      id: 'txn-1',
      amount: -9,
      type: 'deduction',
      description: 'AI 对话消费',
    })).toMatchObject({
      id: 'txn-1',
      ledger_type: 'spend',
      reason_code: 'ai_task_spend',
      counts_as_spend: true,
    });
  });

  it('counts only top-up purchase grants as purchase credits', () => {
    expect(countsAsTopupPurchaseCredit({
      amount: 100,
      type: 'purchase',
    })).toBe(true);

    expect(countsAsTopupPurchaseCredit({
      amount: 100,
      type: 'addition',
      ledger_type: 'grant',
      reason_code: 'topup_purchase',
    })).toBe(true);

    expect(countsAsTopupPurchaseCredit({
      amount: 100,
      type: 'addition',
      ledger_type: 'grant',
      reason_code: 'checkin',
      source_type: 'system',
    })).toBe(false);

    expect(countsAsTopupPurchaseCredit({
      amount: 100,
      type: 'addition',
      ledger_type: 'grant',
      reason_code: 'subscription_grant',
      source_type: 'stripe_invoice',
    })).toBe(false);

    expect(countsAsTopupPurchaseCredit({
      amount: 100,
      type: 'addition',
      ledger_type: 'adjustment',
      reason_code: 'admin_adjustment',
      source_type: 'admin',
    })).toBe(false);

    expect(countsAsTopupPurchaseCredit({
      amount: 100,
      type: 'addition',
      description: '[Admin] manual top-up',
      idempotency_key: 'admin_adjustment:admin-1:user-1:request-1',
    })).toBe(false);

    expect(countsAsTopupPurchaseCredit({
      amount: 100,
      type: 'refund',
      ledger_type: 'adjustment',
      reason_code: 'credit_refund',
    })).toBe(false);
  });
});
