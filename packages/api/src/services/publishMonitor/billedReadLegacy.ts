/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { BillingRpc } from '../turn/provider/service';
import { frozenToolPolicy, toolResultEvidence, type ToolCallPolicy } from '../turn/provider/toolBilling';
import { toolSubcallBilling } from '../bill2/toolSubcall';
import type { ResearchCallResult } from '../research/vendors/types';

/**
 * V2-12 B8a: the BILL2 settlement of a billed-read run that a killed process left open BEFORE reads moved to turns (its run_id
 * is a bill2_runs id, there is no turn). Kept only so such a run is still settled and its hold released; no new run is ever
 * created this way. Deleted with the BILL2 tables in batch F.
 */
type Admin = SupabaseClient;
class LegacyRunError extends Error { constructor() { super('PUBLISH_MONITOR_BILLING_UNAVAILABLE'); } }
async function rpc<T>(admin: Pick<SupabaseClient, 'rpc'>, name: string, args: Record<string, unknown>, schema: z.ZodType<T>) {
  const result = await admin.rpc(name, args);
  if (result.error) throw new LegacyRunError();
  const parsed = schema.safeParse(result.data);
  if (!parsed.success) throw new LegacyRunError();
  return parsed.data;
}
const uuid = z.string().uuid();

/**
 * Closes and finalizes a run (delivered when at least one answer was used, otherwise cancelled), then marks it closed.
 * Resumable: a run that an earlier attempt already closed (the process died between close and finalize) keeps the
 * outcome it was closed with; only finalize and the closed marker are repeated.
 */
async function closeRun(admin: Pick<SupabaseClient, 'rpc'>, actorId: string, runId: string, delivered: boolean) {
  const view = await admin.rpc('bill2_read', { p_actor_id: actorId, p_run_id: runId });
  if (view.error) throw new LegacyRunError();
  const alreadyClosed = z.object({ closed: z.boolean() }).passthrough().safeParse(view.data);
  if (!alreadyClosed.success) throw new LegacyRunError();
  const result = delivered ? { kind: 'usable_result', evidenceRef: `publish-monitor:${runId}`,
    evidenceHash: createHash('sha256').update(`publish-monitor:${runId}`).digest('hex') } : null;
  if (!alreadyClosed.data.closed) {
    const closed = await admin.rpc('bill2_close', { p_actor_id: actorId, p_run_id: runId,
      p_outcome: delivered ? 'delivered' : 'cancelled', p_result: result });
    if (closed.error) throw new LegacyRunError();
  }
  const finalized = await admin.rpc('bill2_finalize', { p_actor_id: actorId, p_run_id: runId });
  if (finalized.error) throw new LegacyRunError();
  // Marked closed only once BILL2 says the run is settled or refunded. A run still waiting on a receipt (cost_pending:
  // a dispatched call whose receipt could not be recorded) stays listed, so the daily job replays the saved receipt.
  const state = z.object({ state: z.string() }).passthrough().safeParse(finalized.data);
  if (state.success && ['settled', 'refunded'].includes(state.data.state)) {
    await rpc(admin, 'publish_monitor_billed_closed', { p_run_id: runId }, z.unknown());
  }
}

/**
 * A run left open by a killed process, settled without a live claim (the connection, lease or account may be gone):
 * every call it sent without a receipt gets one — the saved receipt when the answer had been stored (the user pays
 * exactly what that answer cost, once; bill2_record ignores an identical replay), otherwise an unknown result (the user
 * pays nothing; the supplier cost is reconciled like any unknown tool result); every still-live attempt is freed; then
 * the run is closed and finalized.
 */
export async function settleLegacyRun(admin: Admin, actorId: string, runId: string, rawPolicies: unknown[]) {
  const policies = z.array(frozenToolPolicy).parse(rawPolicies) as ToolCallPolicy[];
  const rows = await rpc(admin, 'publish_monitor_billed_recovery', { p_run_id: runId },
    z.array(z.object({ operationId: uuid, callId: uuid.nullable(), model: z.string(), callPending: z.boolean(), live: z.boolean(),
      receipt: z.record(z.string(), z.unknown()).nullable() }).strict()));
  const billing = toolSubcallBilling({ admin: admin as unknown as BillingRpc, actorId: actorId, runId });
  let delivered = false;
  for (const row of rows) {
    if (row.callPending && row.callId) {
      if (row.receipt) {
        await billing.record(row.callId, row.receipt as ReturnType<typeof toolResultEvidence>);
        delivered ||= row.receipt.toolOutcome === 'delivered';
      } else {
        const policy = policies.find(candidate => candidate.model === row.model);
        if (!policy) throw new LegacyRunError();
        const unknown: ResearchCallResult = { vendor: 'tikhub', route: policy.model.slice('tikhub:'.length), outcome: 'unknown',
          reason: 'PROCESS_INTERRUPTED', httpStatus: null, supplierMayCharge: true, usage: { unit: 'call', units: null }, items: [],
          truncated: false, fetchedAt: new Date().toISOString() };
        await billing.record(row.callId, toolResultEvidence(row.callId, policy, unknown,
          createHash('sha256').update(row.callId).digest('hex')));
      }
    }
    if (row.live) await rpc(admin, 'publish_monitor_billed_abandon', { p_run_id: runId, p_operation_id: row.operationId }, z.boolean());
  }
  await closeRun(admin, actorId, runId, delivered);
}

