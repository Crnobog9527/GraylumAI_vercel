/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { createAccountErasureHost } from './host';
import { createErasureAuthAdapter } from './authAdapter';
import { createErasureStorageTransport } from './storageTransport';

const claimSchema = z.discriminatedUnion('claimed', [
  z.object({ claimed: z.literal(false) }).strict(),
  z.object({ claimed: z.literal(true), profileId: z.string().uuid(), requestId: z.string().uuid() }).strict(),
]);
const proofSchema = z.object({ historyComplete: z.boolean(), quiescent: z.boolean() }).strict();
export type ErasureExecutorSummary = { processed: number; completed: number; pending: number; failed: number };

/** A lost claim response is not a failed transaction. Reconcile the same token
 * through existing service-only request reads; never dispatch another identity. */
async function claimWithObservation(client: SupabaseClient, token: string) {
  try {
    const response = await client.rpc('account_erasure_executor_claim', { p_token: token })
      .abortSignal(AbortSignal.timeout(2000));
    if (response.error) throw new Error('ERASURE_CLAIM_UNKNOWN');
    return claimSchema.parse(response.data);
  } catch {
    const observed = await client.from('account_erasure_requests').select('profile_id,request_id', { count: 'exact' })
      .eq('executor_token', token).limit(2).abortSignal(AbortSignal.timeout(2000));
    if (observed.error || observed.count !== 1) throw new Error('ERASURE_CLAIM_UNKNOWN');
    const [row] = z.array(z.object({ profile_id: z.string().uuid(), request_id: z.string().uuid() }).strict())
      .length(1).parse(observed.data);
    return claimSchema.parse({ claimed: true, profileId: row.profile_id, requestId: row.request_id });
  }
}

/** Called by the existing authenticated cron. Each RPC is a fresh transaction.
 * Claims never expire: after a crashed/unfinished worker, verify its external I/O
 * before releasing the original token. No retry identity or second queue is created. */
async function runOne(client: SupabaseClient, deadline: number, drainDeadline: number) {
  const summary: ErasureExecutorSummary = { processed: 0, completed: 0, pending: 0, failed: 0 };
  // One subject per claim cannot starve later subjects:
  // SQL selects least recently attempted requests and excludes unresolved claims.
  const token = randomUUID();
  try {
    const claim = await claimWithObservation(client, token);
    if (!claim.claimed) return summary;
    summary.processed++;
    const binding = { p_profile_id: claim.profileId, p_request_id: claim.requestId, p_token: token };
    const proof = async (_profileId: string, signal: AbortSignal) => {
      const response = await client.rpc('account_erasure_executor_proof', binding).abortSignal(signal);
      if (response.error) throw new Error('ERASURE_PROOF_UNKNOWN');
      const value = proofSchema.parse(response.data);
      if (!value.historyComplete || !value.quiescent) throw new Error('ERASURE_STORAGE_UNPROVEN');
    };
    const host = createAccountErasureHost({
      profileId: claim.profileId, requestId: claim.requestId, client, deadline,
      storage: createErasureStorageTransport(client), auth: createErasureAuthAdapter(client, claim.profileId),
      verifyRetainedHistory: proof, verifyQuiescence: proof, deferStorageProof: true, scopedManifest: true, executorToken: token,
    });
    const result = await host.run();
    if (result.stage === 'completed' && !result.retry) summary.completed++;
    else summary.pending++;
    const idle = host.isIdle() || await host.waitForIdle(Math.max(0, drainDeadline - Date.now()));
    const codes = idle ? result.errorCodes : [...result.errorCodes, 'ERASURE_EXECUTOR_IO_PENDING'];
    const saved = await client.rpc('account_erasure_executor_finish', {
      ...binding, p_codes: [...new Set(codes)].slice(0, 20), p_release: idle,
    }).abortSignal(AbortSignal.timeout(2000));
    if (saved.error || !z.object({ recorded: z.literal(true) }).strict().safeParse(saved.data).success) {
      summary.failed++;
    }
  } catch { summary.failed++; }
  return summary;
}

/** Use the five-minute cron schedule. Process bounded subjects until the cron deadline;
 * unresolved claims and storage/billing failures remain visible on every invocation. */
export async function runAccountErasureExecutor(client: SupabaseClient, deadline = Date.now() + 45_000) {
  const summary: ErasureExecutorSummary = { processed: 0, completed: 0, pending: 0, failed: 0 };
  for (let index = 0; index < 20 && Date.now() + 5_000 < deadline; index++) {
    const result = await runOne(client, Math.min(deadline - 3_000, Date.now() + 10_000), deadline - 3_000);
    summary.processed += result.processed;
    summary.completed += result.completed;
    summary.failed += result.failed;
    if (!result.processed || result.failed) break;
  }
  try {
    const result = await client.rpc('account_erasure_executor_pending', {}).abortSignal(AbortSignal.timeout(2000));
    if (result.error) throw new Error('ERASURE_PENDING_UNKNOWN');
    summary.pending = z.number().int().nonnegative().safe().parse(result.data);
  } catch { summary.failed++; }
  return summary;
}
