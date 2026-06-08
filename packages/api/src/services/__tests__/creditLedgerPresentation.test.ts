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
});
