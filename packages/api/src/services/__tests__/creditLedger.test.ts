/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import {
  countsAsCreditSpend,
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
  });

  it('maps legacy transaction types without losing refund clawback semantics', () => {
    expect(normalizeCreditLedgerType({
      amount: -12,
      type: 'deduction',
      description: 'AI 对话消费',
    })).toBe('spend');

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
});
