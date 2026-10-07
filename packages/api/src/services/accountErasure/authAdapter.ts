/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { ErasureAuthAdapter } from './processor';

type Client = { auth: { admin: Pick<SupabaseClient['auth']['admin'], 'getUserById' | 'deleteUser'> } };
const uuid = z.string().uuid();
const unknownResult = () => new Error('ERASURE_AUTH_UNKNOWN');

/** No client construction, credentials or automatic caller. The host must use the original
 * durable claim in processor.ts; this per-instance latch is NOT a cross-process claim.
 * A resumed durable intent may read but must never call remove, even with a fresh adapter. */
export function createErasureAuthAdapter(client: Client, profileId: string): ErasureAuthAdapter {
  uuid.parse(profileId);
  let attempted = false;
  const matches = (id: string) => id === profileId && uuid.safeParse(id).success;
  return {
    async getState(id) {
      if (!matches(id)) return 'unknown';
      try {
        const result = await client.auth.admin.getUserById(id);
        if (result.error) {
          // Bare HTTP 404, empty data and any other failure are not absence evidence.
          return result.error.status === 404 && result.error.code === 'user_not_found'
            && result.data?.user === null ? 'absent' : 'unknown';
        }
        return result.data?.user?.id === profileId ? 'present' : 'unknown';
      } catch { return 'unknown'; }
    },
    async remove(id) {
      if (!matches(id) || attempted) throw unknownResult();
      // Set before awaiting: rejection, timeout and concurrent callers cannot resend.
      attempted = true;
      try {
        const result = await client.auth.admin.deleteUser(id, false);
        if (result.error || result.data?.user?.id !== profileId) throw unknownResult();
        // Success is not absence proof. The coordinator must still read the original ID.
      } catch { throw unknownResult(); }
    },
  };
}
