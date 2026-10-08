/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createErasureAttachmentManifest } from './manifest';
import { processAccountErasure, type ErasureAuthAdapter, type ErasureProcessResult } from './processor';
import { createErasureStorageAdapter, type ErasureStorageTransport } from './storage';

const uuid = z.string().uuid();
const requestSchema = z.object({
  profile_id: uuid, request_id: uuid,
  stage: z.enum(['closed', 'erasing', 'billing_pending', 'completed']),
  last_error_code: z.string().regex(/^[A-Z0-9_]{1,64}$/).nullable(),
}).strict();
type Proof = (profileId: string, signal: AbortSignal) => Promise<void>;

/** Unwired, injected single-subject composition. No credentials, SDK construction or caller.
 * The same service client reads the service-only request and all subjects' raw references.
 * Proof providers are trusted local dependencies, never client input. Quiescence must hold
 * until all injected I/O settles; checking a timestamp/empty table is not such proof.
 * The per-instance latch is NOT a distributed lease. No actual execution entry is supplied. */
export function createAccountErasureHost(input: {
  profileId: string; requestId: string; client: Pick<SupabaseClient, 'from' | 'rpc'>;
  storage: ErasureStorageTransport; auth: ErasureAuthAdapter;
  verifyRetainedHistory?: Proof; verifyQuiescence?: Proof;
  operationTimeoutMs?: number;
}) {
  let active = false;
  return { async run(): Promise<ErasureProcessResult> {
    const denied = (code: string, previous: string | null = null): ErasureProcessResult => ({
      stage: 'erasing', retry: true, remaining: 1, manualReview: 0,
      errorCodes: [...new Set([...(previous ? [previous] : []), code])],
    });
    if (active) return denied('ERASURE_HOST_BUSY');
    const timeout = input.operationTimeoutMs ?? 2000;
    if (!uuid.safeParse(input.profileId).success || !uuid.safeParse(input.requestId).success
      || !Number.isInteger(timeout) || timeout < 1 || timeout > 5000) return denied('ERASURE_INVALID_INPUT');
    active = true;
    let sealed = false;
    let pending = 0;
    let previous: string | null = null;
    // A returned timeout does not imply underlying I/O stopped. Block local re-entry
    // until it settles, and seal all later writes from an abandoned storage operation.
    const track = async <T>(operation: () => PromiseLike<T>): Promise<T> => {
      if (sealed) throw new Error('ERASURE_HOST_CLOSED');
      pending++;
      try { return await operation(); }
      finally { pending--; if (sealed && pending === 0) active = false; }
    };
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const admission = async () => {
      const result = await input.client.from('account_erasure_requests')
        .select('profile_id,request_id,stage,last_error_code', { count: 'exact' })
        .eq('profile_id', input.profileId).limit(2).abortSignal(controller.signal);
      if (result.error || result.count !== 1) throw new Error('ERASURE_REQUEST_UNKNOWN');
      const rows = z.array(requestSchema).length(1).parse(result.data);
      const row = rows[0];
      if (row.profile_id !== input.profileId || row.request_id !== input.requestId || row.stage === 'completed') {
        throw new Error('ERASURE_REQUEST_UNKNOWN');
      }
      previous = row.last_error_code;
      if (!input.verifyRetainedHistory || !input.verifyQuiescence) throw new Error('ERASURE_HISTORY_UNKNOWN');
      await input.verifyRetainedHistory(input.profileId, controller.signal);
      if (controller.signal.aborted) throw new Error('ERASURE_HOST_TIMEOUT');
      await input.verifyQuiescence(input.profileId, controller.signal);
    };
    try {
      await Promise.race([track(admission), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('ERASURE_HOST_TIMEOUT')); }, timeout);
      })]);
      clearTimeout(timer);
      if (controller.signal.aborted) throw new Error('ERASURE_HOST_TIMEOUT');
      const manifest = createErasureAttachmentManifest({ client: input.client, limits: { timeoutMs: timeout },
        verifyRetainedHistory: async (profileId, signal) => {
          await track(() => input.verifyRetainedHistory!(profileId, signal));
          await track(() => input.verifyQuiescence!(profileId, signal));
        },
      });
      const storage = createErasureStorageAdapter({ manifest, storage: {
        listPrefix: args => track(() => input.storage.listPrefix(args)),
        getState: args => track(() => input.storage.getState(args)),
        remove: args => track(() => input.storage.remove(args)),
      }, limits: { requestTimeoutMs: timeout, totalTimeoutMs: timeout } });
      const result = await processAccountErasure({ profileId: input.profileId,
        database: { rpc: (name, args) => track(async () => {
          const response = await input.client.rpc(name, args);
          if (name === 'account_erasure_work_batch' && !response.error
            && response.data?.requestId !== input.requestId) throw new Error('ERASURE_IDENTITY_CHANGED');
          return response;
        }) },
        storageAdapter: storage,
        authAdapter: { getState: id => track(() => input.auth.getState(id)), remove: id => track(() => input.auth.remove(id)) },
        budget: { operationTimeoutMs: timeout },
      });
      // Do not use note_error here: a stale read/late host must not overwrite a
      // newer AUTH_BAN_FAILED or billing diagnostic. Keep original error priority in output.
      if (previous && result.stage !== 'completed') result.errorCodes = [...new Set([previous, ...result.errorCodes])];
      return result;
    } catch {
      return denied(controller.signal.aborted ? 'ERASURE_HOST_TIMEOUT' : 'ERASURE_HOST_UNVERIFIED', previous);
    } finally {
      clearTimeout(timer); controller.abort(); sealed = true;
      if (pending === 0) active = false;
    }
  } };
}
