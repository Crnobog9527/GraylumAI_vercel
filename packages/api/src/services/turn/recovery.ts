/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TransportObservation } from '../bill2/fixtureAdapter';
import { openRouterAdapter } from '../bill2/openRouterAdapter';
import { openRouterEvidence, type OpenRouterIdentity } from '../bill2/openRouterEvidence';
import { nominalActualFallback, nominalCost, nominalPricing } from '../../shared/nominalPricing';
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
  db: Pick<TurnDatabase, 'claimRecovery' | 'recover' | 'record'>;
  /** OpenRouter generation lookup with the platform key; null when no key is configured (lookups are then skipped). */
  lookup: ((providerId: string, identity: OpenRouterIdentity, timeoutMs: number) => Promise<TransportObservation>) | null;
  /** The account of the platform key, as the call identity names it. */
  account: string | null;
  deadline: number; now?: () => number;
};
export type TurnRecoverySummary = {
  claimed: number; interrupted: number; expired: number; settled: number; pending: number; skipped: number;
  lookups: number; lateReceipts: number; failed: number;
};

/** One unknown model cost: its final cost by provider id, recorded as the late receipt; anything less leaves it unknown. */
async function lookUp(deps: TurnRecoveryDeps, item: RecoveryItem, call: RecoveryItem['calls'][number]): Promise<boolean> {
  // Priced as a live receipt is (call.ts): the price table frozen at open, from the looked-up token counts; min(c, U) only when
  // the counts are missing. A turn that froze no price table is left unknown rather than priced by another rule.
  const pricing = nominalPricing.safeParse(call.pricing);
  if (!deps.lookup || !deps.account || !call.model || !pricing.success) return false;
  const identity: OpenRouterIdentity = { provider: 'openrouter', account: deps.account, model: call.model, protocol: 'openrouter-chat-v1' };
  const observation = await deps.lookup(call.providerId, identity, RECOVERY_LOOKUP_MS);
  const evidence = openRouterEvidence(observation, identity, 'lookup', call.providerId);
  if (!('final' in evidence) || !evidence.final || typeof evidence.cost !== 'string') return false;
  const actual = ceil12(evidence.cost);
  const usage = (evidence.usage ?? {}) as Record<string, unknown>;
  const count = (value: unknown) => typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
  const tokens = { promptTokens: count(usage.inputTokens), completionTokens: count(usage.outputTokens),
    reasoningTokens: count(usage.reasoningTokens) };
  const upper = ceil12(call.upperUsd.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  await deps.db.record({ actorId: item.actorId, turnId: item.turnId, seq: call.seq, status: 'ok',
    nominalUsd: ceil12(nominalCost(pricing.data, tokens) ?? nominalActualFallback(actual, upper)), actualUsd: actual,
    usage: { ...usage, source: 'lookup' }, providerId: call.providerId,
    payloadHash: evidence.sourceHash, raw: evidence.rawBody || null });
  return true;
}

export async function recoverTurns(deps: TurnRecoveryDeps): Promise<TurnRecoverySummary> {
  const now = deps.now ?? Date.now;
  const summary: TurnRecoverySummary = { claimed: 0, interrupted: 0, expired: 0, settled: 0, pending: 0, skipped: 0, lookups: 0,
    lateReceipts: 0, failed: 0 };
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
          if (await lookUp(deps, item, call).catch(() => false)) summary.lateReceipts++;
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
      } catch { summary.failed++; }
    }
    if (batch.length < RECOVERY_BATCH) break;
  }
  return summary;
}

/** The scheduled job's wiring: the write client and the platform key, read fresh once per run (OR-1). */
export async function runTurnRecovery(admin: SupabaseClient, deadline: number, transport?: typeof fetch): Promise<TurnRecoverySummary> {
  const key = await readOpenRouterKeyOrUnset(admin, { fresh: true }).catch(() => null);
  const adapter = key ? openRouterAdapter({ credential: async () => key, transport }) : null;
  return recoverTurns({ db: turnDatabase(turnClients(admin)), deadline, account: key ? openRouterAccount(key) : null,
    lookup: adapter ? (providerId, identity, timeoutMs) => adapter.lookup(providerId, identity, { timeoutMs }) : null });
}
