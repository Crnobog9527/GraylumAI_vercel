/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import {
  getBillingRecordStatusPresentation,
  normalizeBillingRecordStatus,
} from '../../../../../apps/web/src/components/profile/billingRecordStatus';

describe('BillingRecordsCard status presentation', () => {
  it('renders the v1.5 billing status labels and legacy compatibility snapshot', () => {
    const statuses = [
      'pending',
      'completed',
      'failed',
      'canceled',
      'cancelled',
      'expired',
      'refunded',
      'partially_refunded',
      'partial_refunded',
    ];

    expect(
      statuses.map((status) => ({
        input: status,
        normalized: normalizeBillingRecordStatus(status),
        label: getBillingRecordStatusPresentation(status).label,
      })),
    ).toMatchInlineSnapshot(`
      [
        {
          "input": "pending",
          "label": "待支付",
          "normalized": "pending",
        },
        {
          "input": "completed",
          "label": "已完成",
          "normalized": "completed",
        },
        {
          "input": "failed",
          "label": "支付失败",
          "normalized": "failed",
        },
        {
          "input": "canceled",
          "label": "已取消",
          "normalized": "canceled",
        },
        {
          "input": "cancelled",
          "label": "已取消",
          "normalized": "canceled",
        },
        {
          "input": "expired",
          "label": "已过期",
          "normalized": "expired",
        },
        {
          "input": "refunded",
          "label": "已退款",
          "normalized": "refunded",
        },
        {
          "input": "partially_refunded",
          "label": "部分退款",
          "normalized": "partially_refunded",
        },
        {
          "input": "partial_refunded",
          "label": "部分退款",
          "normalized": "partially_refunded",
        },
      ]
    `);
  });
});
