/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import {
  countsAsCreditSpend,
  getCreditLedgerLabel,
  normalizeCreditLedgerType,
} from '../../../../../apps/web/src/components/profile/creditLedgerPresentation';

describe('CreditRecordsCard ledger presentation', () => {
  it('labels refund clawbacks separately from AI spend', () => {
    const refundClawback = {
      amount: -100,
      type: 'deduction',
      ledger_type: 'refund_clawback',
      counts_as_spend: false,
    };

    expect(normalizeCreditLedgerType(refundClawback)).toBe('refund_clawback');
    expect(getCreditLedgerLabel(refundClawback)).toBe('退款扣回');
    expect(countsAsCreditSpend(refundClawback)).toBe(false);
  });

  it('keeps legacy AI deductions displayed as AI spend', () => {
    const legacySpend = {
      amount: -15,
      type: 'deduction',
      description: 'AI 对话消费',
    };

    expect(normalizeCreditLedgerType(legacySpend)).toBe('spend');
    expect(getCreditLedgerLabel(legacySpend)).toBe('AI 使用消耗');
    expect(countsAsCreditSpend(legacySpend)).toBe(true);
  });

  it('labels admin/manual deductions separately from AI spend', () => {
    const adminAdjustment = {
      amount: -15,
      type: 'deduction',
      description: '积分消费',
      idempotency_key: 'admin_credit_deduction:admin-1:request-1',
    };

    expect(normalizeCreditLedgerType(adminAdjustment)).toBe('adjustment');
    expect(getCreditLedgerLabel(adminAdjustment)).toBe('系统调整');
    expect(countsAsCreditSpend(adminAdjustment)).toBe(false);
  });

  it('labels positive admin adjustments separately from grants', () => {
    const adminAdjustment = {
      amount: 25,
      type: 'addition',
      description: '[Admin] manual top-up',
      idempotency_key: 'admin_adjustment:admin-1:user-1:request-1',
    };

    expect(normalizeCreditLedgerType(adminAdjustment)).toBe('adjustment');
    expect(getCreditLedgerLabel(adminAdjustment)).toBe('系统调整');
    expect(countsAsCreditSpend(adminAdjustment)).toBe(false);
  });
});
