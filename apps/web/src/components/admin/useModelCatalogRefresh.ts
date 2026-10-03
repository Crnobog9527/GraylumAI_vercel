/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useState } from 'react';
import { trpc } from '@/trpc/client';
import { getSafeErrorMessage, readValidationIssueMessages } from '@/lib/safe-error-message';
import type { PriceChange } from '@repo/api/src/shared/modelPricing';
import type { ModelCapacityView } from './modelReportPricing';

/** These procedures use BAD_REQUEST for their administrator-readable validation messages. */
export function reasoningErrorMessage(error: { message: string; data?: { code?: string } | null }, fallback: string): string {
  return error.data?.code === 'BAD_REQUEST'
    ? readValidationIssueMessages(error.message) ?? error.message
    : getSafeErrorMessage(error, fallback);
}

/**
 * The explicit "重新读取" of a saved model: reads the OpenRouter catalog and price snapshot
 * of its saved model ID (`modelReasoning.refreshCatalog`), which may also sync the capacity.
 * Shared by the "思考设置" dialog and the add / edit model form.
 */
export function useModelCatalogRefresh(modelId: string) {
  const utils = trpc.useUtils();
  const [priceChanges, setPriceChanges] = useState<PriceChange[] | null>(null);
  const [previousCapacity, setPreviousCapacity] = useState<ModelCapacityView | null>(null);
  const refresh = trpc.modelReasoning.refreshCatalog.useMutation({
    onSuccess: ({ priceChanges: changes, previousCapacity: previous, ...data }) => {
      utils.modelReasoning.get.setData({ modelId }, data);
      setPriceChanges(changes);
      setPreviousCapacity(previous);
      // The read bumps updated_at and may sync capacity; reload both so later saves on the page do not conflict.
      void utils.modelPricing.getMultipliers.invalidate();
      void utils.model.getAdminModelsDashboard.invalidate();
    },
  });
  const errorText = refresh.error ? reasoningErrorMessage(refresh.error, '暂时无法读取模型目录，请稍后重试') : null;
  return {
    read: () => refresh.mutate({ modelId }),
    isPending: refresh.isPending,
    errorText,
    priceChanges,
    previousCapacity,
  };
}
