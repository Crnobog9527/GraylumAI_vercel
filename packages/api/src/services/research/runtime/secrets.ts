/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Supplier keys for the research tools. UNFINISHED placeholder until ADMIN-SECRETS (#975, migration 0259): business
// keys will be entered in the admin page and read from Vault through getPlatformSecret(slot). Until then a staging or
// local deployment may read them from environment variables; production never does (it gets no key, so every research
// call stays `unavailable` and nothing is sent or charged).
import type { ResearchVendor } from '../vendors/types';

const ENV_NAMES: Readonly<Record<ResearchVendor, string>> = Object.freeze({
  tikhub: 'TIKHUB_API_KEY', parallel: 'PARALLEL_API_KEY', firecrawl: 'FIRECRAWL_API_KEY',
});

export type SecretReader = (vendor: ResearchVendor) => Promise<string | null>;

/** Vercel production (VERCEL_ENV or VERCEL_TARGET_ENV) never uses the environment fallback. */
export function isProductionDeployment(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.VERCEL_ENV === 'production' || env.VERCEL_TARGET_ENV === 'production';
}

/** The placeholder reader: environment variable outside production, otherwise no key. Never logs the value. */
export function environmentSecretReader(env: Readonly<Record<string, string | undefined>> = process.env): SecretReader {
  return async vendor => {
    if (isProductionDeployment(env)) return null;
    const value = env[ENV_NAMES[vendor]]?.trim();
    return value ? value : null;
  };
}
