/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { trpc } from '@/trpc/client';
import type { MultiplierInfo } from './ModelFrozenPriceSummary';

/** This model's effective multiplier m and the site credits per USD q (#565), or null until read. */
export function useModelPriceUnits(modelId: string | null): MultiplierInfo | null {
  const multipliers = trpc.modelPricing.getMultipliers.useQuery(undefined, { enabled: Boolean(modelId) });
  if (!multipliers.data) return null;
  const row = multipliers.data.models.find(model => model.id === modelId);
  return { multiplier: row?.effective ?? null, creditsPerUsd: multipliers.data.site?.creditsPerUsd ?? null };
}
