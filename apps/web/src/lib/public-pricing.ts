/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { cache } from 'react';
import { appRouter } from '@repo/api/src/root';
import { createTRPCContext } from '@repo/api/src/trpc';
import type { PublicCreditPackage } from '@/components/pricing/PricingExtras';

/** Public credit-pack catalog for the pricing page, read server-side like the plan catalog. */
async function loadPublicCreditPackagesUncached(): Promise<{ packages: PublicCreditPackage[]; failed: boolean }> {
  if (process.env.SECURITY_E2E_LOCAL_ONLY === 'true') return { packages: [], failed: true };
  try {
    const ctx = await createTRPCContext({ headers: new Headers() });
    const packages = await appRouter.createCaller(ctx).settings.getCreditPackages();
    return { packages, failed: false };
  } catch {
    return { packages: [], failed: true };
  }
}

export const getPublicCreditPackages = cache(loadPublicCreditPackagesUncached);
