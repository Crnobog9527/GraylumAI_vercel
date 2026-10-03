/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ModelPriceView } from './modelReportPricing';

/** Price projections in the shape the admin report procedures return (test fixtures). */
export const unreadPrice: ModelPriceView = {
  status: 'unread', label: '未读取', route: null, fetchedAt: null, pricingHash: null, source: null,
  base: null, frozen: null, promptTokensUpper: null,
};

export const readyPrice: ModelPriceView = {
  status: 'ready', label: '已读取', route: 'example/fp8', fetchedAt: '2026-10-01T00:00:00.000Z',
  pricingHash: 'a'.repeat(64), source: 'openrouter', promptTokensUpper: 272000,
  base: { prompt: '1.25', completion: '10', input_cache_read: '0.125', web_search: '0.01' },
  frozen: {
    promptUsdPerMillion: '2.5', completionUsdPerMillion: '15', requestUsd: '0',
    explain: { prompt: '第 1 档输入', completion: '第 1 档输出' },
  },
};

export const refusedPrice: ModelPriceView = {
  ...readyPrice, status: 'UNKNOWN_PRICE_FIELD', label: '不可推导', frozen: null,
  base: { prompt: '1.25', completion: '10' },
};

export const mismatchedPrice: ModelPriceView = {
  ...unreadPrice, status: 'model_mismatch', label: '不可推导', fetchedAt: '2026-10-01T00:00:00.000Z',
};
