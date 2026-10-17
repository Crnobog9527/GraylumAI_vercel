/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Supplier keys for the research tools (ADMIN-SECRETS §7 step 4, §10 RT): read through getPlatformSecret just before
// each subcall. The admin value wins; while the transition lasts (§4.3, §4.4) an unfilled slot may use its listed
// environment variable, except in production, which never did. A database failure is "unavailable", never a silent
// switch to an environment key. The value is only passed to the adapter: never logged, returned or stored.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingRpc } from '../../bill2/service';
import { getPlatformSecret, PlatformSecretError } from '../../platformSecrets';
import type { ResearchVendor } from '../vendors/types';

/** The key, or null when neither the admin nor an allowed fallback has one. Throws when the store cannot be read. */
export type SecretReader = (vendor: ResearchVendor) => Promise<string | null>;

/** Vercel production (VERCEL_ENV or VERCEL_TARGET_ENV) never uses the environment fallback. */
export function isProductionDeployment(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.VERCEL_ENV === 'production' || env.VERCEL_TARGET_ENV === 'production';
}

export function platformSecretReader(admin: BillingRpc, env: Readonly<Record<string, string | undefined>> = process.env): SecretReader {
  // The platform reader bounds its read with an abort signal; a client without one still gets a plain query.
  const client = { rpc: (name: string, args: Record<string, unknown>) => {
    const query = admin.rpc(name, args);
    const bounded = query.abortSignal?.bind(query);
    return Object.assign(Promise.resolve(query).then(result => result), {
      abortSignal: (signal: AbortSignal) => bounded?.(signal) ?? query });
  } } as unknown as Pick<SupabaseClient, 'rpc'>;
  return async vendor => {
    try {
      return (await getPlatformSecret(client, vendor, { env: isProductionDeployment(env) ? {} : { ...env } })).value;
    } catch (error) {
      if (error instanceof PlatformSecretError && error.code === 'PLATFORM_SECRET_NOT_CONFIGURED') return null;
      throw new Error('RESEARCH_KEY_UNAVAILABLE');
    }
  };
}
