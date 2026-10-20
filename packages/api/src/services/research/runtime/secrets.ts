/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Supplier keys for the research tools (ADMIN-SECRETS §10 RT): read through getPlatformSecret just before each
// subcall. The admin Vault is the only source. A database failure is "unavailable"; the value is only passed to the
// adapter and is never logged, returned or stored.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { BillingRpc } from '../../bill2/service';
import { getPlatformSecret, PlatformSecretError } from '../../platformSecrets';
import type { ResearchVendor } from '../vendors/types';

/** The key, or null when the admin Vault slot is empty. Throws when the store cannot be read. */
export type SecretReader = (vendor: ResearchVendor) => Promise<string | null>;

export function platformSecretReader(admin: BillingRpc): SecretReader {
  // The platform reader bounds its read with an abort signal; a client without one still gets a plain query.
  const client = { rpc: (name: string, args: Record<string, unknown>) => {
    const query = admin.rpc(name, args);
    const bounded = query.abortSignal?.bind(query);
    return Object.assign(Promise.resolve(query).then(result => result), {
      abortSignal: (signal: AbortSignal) => bounded?.(signal) ?? query });
  } } as unknown as Pick<SupabaseClient, 'rpc'>;
  return async vendor => {
    try {
      return (await getPlatformSecret(client, vendor)).value;
    } catch (error) {
      if (error instanceof PlatformSecretError && error.code === 'PLATFORM_SECRET_NOT_CONFIGURED') return null;
      throw new Error('RESEARCH_KEY_UNAVAILABLE');
    }
  };
}
