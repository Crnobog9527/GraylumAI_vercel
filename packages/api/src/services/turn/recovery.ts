/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TransportObservation } from './provider/fixtureAdapter';
import { openRouterAdapter } from './provider/openRouterAdapter';
import { openRouterEvidence, type OpenRouterIdentity } from './provider/openRouterEvidence';
import { withByok } from './provider/openRouterByok';
import { nominalActualFallback, nominalCost, nominalPricing } from '../../shared/nominalPricing';
import { logSwallowed, swallow } from '../../lib/swallow';
import { ceil12 } from './call';
import { openRouterAccount, readOpenRouterKeyOrUnset } from '../models/openRouterKey';
import { turnClients, turnDatabase, type RecoveryItem, type TurnDatabase } from './db';

/*
 * CORE-PATH-V2 V2-8 (2.2, 2.5.2, 3.3.2 item 7): the turns part of the minute runtime-recovery job. turn_recovery_claim leases up to
 * 50 turns in one short transaction (FOR UPDATE SKIP LOCKED: two instances never get the same turn); each is then recovered in
 * its own transaction by turn_recover, which re-checks under the turn's locks and calls turn_close, so a repeated or concurrent
 * run changes nothing twice. An unknown model cost is looked up by its provider id first; a final cost found is recorded as the
 * call's late receipt and the settlement pass counts it once. Nothing is ever sent again and nothing unknown is presumed free.
 */
export const RECOVERY_BATCH = 50;
export const RECOVERY_LOOKUP_MS = 2_000;
/** Time one turn_recover needs, kept free at the end of the budget. */
const RECOVER_STEP_MS = 1_000;

export type TurnRecoveryDeps = {
  db: Pick<TurnDatabase, 'claimRecovery' | 'recover' | 'record' | 'settleAbsent' | 'settleNoIdentity'>;
  /** OpenRouter generation lookup with the platform key; null when no key is configured (lookups are then skipped). */
  lookup: ((providerId: string, identity: OpenRouterIdentity, timeoutMs: number) => Promise<TransportObservation>) | null;
  /** The account of the platform key, as the call identity names it. */
  account: string | null;
  deadline: number; now?: () => number;
};
export type TurnRecoverySummary = {
  claimed: number; interrupted: number; expired: number; settled: number; pending: number; skipped: number;
  lookups: number; lateReceipts: number; absentSettled: number; failed: number;
};

/**
 * The provider's explicit "no such generation": HTTP 404 with the whole answer read. A timeout, a 5xx, a refused key, a rate limit or
 * a broken body is not evidence of anything and leaves the cost unknown (Owner 2026-11-03).
 */
export const lookupAbsent = (observation: TransportObservation) =>
  observation.httpStatus === 404 && observation.complete === true && observation.transportIssue === null;

/**
 * One unknown model cost: its final cost by provider id, recorded as the late receipt; anything less leaves it unknown. The one
 * other outcome is the provider's "no such generation" on a closed turn (action 'settle'): the database settles that call at zero
 * once the turn is 24 hours old, and answers "too_early" before that (the call then stays unknown and is looked up again).
 */
async function lookUp(deps: TurnRecoveryDeps, item: RecoveryItem, call: RecoveryItem['calls'][number]): Promise<'receipt' | 'absent' | null> {
  // No provider id (the supplier sent nothing before the deadline): nothing to look up; the database settles it at zero once the turn
  // is 24 hours old and answers "too_early" before that (0494, Owner 2026-11-03).
  if (call.providerId === null) {
    if (item.action !== 'settle') return null;
    const outcome = await deps.db.settleNoIdentity({ actorId: item.actorId, turnId: item.turnId, seq: call.seq });
    return outcome.settled ? 'absent' : null;
  }
  // Priced as a live receipt is (call.ts): the price table frozen at open, from the looked-up token counts; min(c, U) only when
  // the counts are missing. A turn that froze no price table is left unknown rather than priced by another rule.
  const pricing = nominalPricing.safeParse(call.pricing);
  if (!deps.lookup || !deps.account || !call.model) return null;
  const identity: OpenRouterIdentity = { provider: 'openrouter', account: deps.account, model: call.model, protocol: 'openrouter-chat-v1' };
  const observation = await deps.lookup(call.providerId, identity, RECOVERY_LOOKUP_MS);
  if (lookupAbsent(observation)) {
    if (item.action !== 'settle') return null;
    const outcome = await deps.db.settleAbsent({ actorId: item.actorId, turnId: item.turnId, seq: call.seq, providerId: call.providerId,
      httpStatus: 404, payloadHash: observation.sourceHash });
    return outcome.settled ? 'absent' : null;
  }
  if (!pricing.success) return null;
  const evidence = openRouterEvidence(observation, identity, 'lookup', call.providerId);
  if (!('final' in evidence) || !evidence.final || typeof evidence.cost !== 'string') return null;
  const actual = ceil12(evidence.cost);
  const usage = (evidence.usage ?? {}) as Record<string, unknown>;
  const count = (value: unknown) => typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
  const tokens = { promptTokens: count(usage.inputTokens), completionTokens: count(usage.outputTokens),
    reasoningTokens: count(usage.reasoningTokens) };
  const upper = ceil12(call.upperUsd.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  const nominal = nominalCost(pricing.data, tokens);
  await deps.db.record({ actorId: item.actorId, turnId: item.turnId, seq: call.seq, status: 'ok',
    nominalUsd: ceil12(nominal ?? nominalActualFallback(actual, upper)), actualUsd: actual,
    // nominalSource: actual_fallback when even the lookup has no token counts (BILL_PAYG_PLAN 3A), as the reports count it.
    // A BYOK lookup's cost is the fee plus the vendor's charge (BILL-BYOK), as a live receipt's; the split stays in usage.
    usage: withByok({ ...usage, source: 'lookup', nominalSource: nominal === null ? 'actual_fallback' : 'nominal' },
      'byok' in evidence ? evidence.byok : undefined), providerId: call.providerId,
    payloadHash: evidence.sourceHash, raw: evidence.rawBody || null });
  return 'receipt';
}

export async function recoverTurns(deps: TurnRecoveryDeps): Promise<TurnRecoverySummary> {
  const now = deps.now ?? Date.now;
  const summary: TurnRecoverySummary = { claimed: 0, interrupted: 0, expired: 0, settled: 0, pending: 0, skipped: 0, lookups: 0,
    lateReceipts: 0, absentSettled: 0, failed: 0 };
  while (now() + RECOVER_STEP_MS < deps.deadline) {
    const batch = await deps.db.claimRecovery(RECOVERY_BATCH);
    summary.claimed += batch.length;
    for (const item of batch) {
      // Out of time: the rest keep their lease and come back to the next run.
      if (now() + RECOVER_STEP_MS >= deps.deadline) return summary;
      try {
        if (item.action === 'settle' || item.action === 'lookup') for (const call of item.calls) {
          if (now() + RECOVERY_LOOKUP_MS + RECOVER_STEP_MS >= deps.deadline) break;
          summary.lookups++;
          // A failed lookup is not evidence: the cost stays unknown and is looked up again after the lease.
          const found = await swallow('turn_recovery_lookup_failed', lookUp(deps, item, call), null, { category: 'api' });
          if (found === 'receipt') summary.lateReceipts++;
          else if (found === 'absent') summary.absentSettled++;
        }
        // A paused turn's lookup only records what it finds; the turn stays paused (its resume, or the 24-hour expiry, closes it).
        if (item.action === 'lookup') continue;
        const result = await deps.db.recover({ actorId: item.actorId, turnId: item.turnId, action: item.action });
        if (result.skipped) { summary.skipped++; continue; }
        if (item.action === 'interrupt') summary.interrupted++;
        else if (item.action === 'expire') summary.expired++;
        else if (result.settlement === 'done') summary.settled++;
        // Closed with a cost still unknown: claimed again for the settlement pass.
        if (result.settlement === 'pending') summary.pending++;
      } catch (error) { logSwallowed('turn_recovery_turn_failed', error, { category: 'api' }); summary.failed++; }
    }
    if (batch.length < RECOVERY_BATCH) break;
  }
  return summary;
}

/** The scheduled job's wiring: the write client and the platform key, read fresh once per run (OR-1). */
export async function runTurnRecovery(admin: SupabaseClient, deadline: number, transport?: typeof fetch): Promise<TurnRecoverySummary> {
  const key = await swallow('turn_recovery_key_unavailable', readOpenRouterKeyOrUnset(admin, { fresh: true }), null, { category: 'api' });
  const adapter = key ? openRouterAdapter({ credential: async () => key, transport }) : null;
  return recoverTurns({ db: turnDatabase(turnClients(admin)), deadline, account: key ? openRouterAccount(key) : null,
    lookup: adapter ? (providerId, identity, timeoutMs) => adapter.lookup(providerId, identity, { timeoutMs }) : null });
}
