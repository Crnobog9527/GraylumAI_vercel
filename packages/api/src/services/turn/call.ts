/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import type { CallIdentity, TransportObservation } from '../bill2/fixtureAdapter';
import { consumeOpenRouterNotStarted } from '../bill2/openRouterAdapter';
import { openRouterEvidence } from '../bill2/openRouterEvidence';
import { openRouterRejection } from '../bill2/openRouterRejection';
import { nominalActualFallback, nominalCost, type NominalPricing } from '../../shared/nominalPricing';
import { acquireSlot, type CounterStore } from './limiter';
import { tombstoned, type TurnDatabase } from './db';

/*
 * CORE-PATH-V2 2.5.2: one paid model call is three writes. turn_call_begin before anything is sent (no row, no request);
 * turn_call_identity as soon as the provider names the generation (recovery looks the cost up by it); turn_call_record with
 * the final receipt and the full response. Only attempts that certainly cost nothing are retried, as a new row (new seq):
 * not_sent (the request never left), at most two attempts per logical call. Anything else whose outcome is not a final receipt
 * stays dispatched/identified: never retried, never presumed free; turn_close marks it unknown and recovery settles it.
 * The SDK itself never retries (runner.ts maxRetries 0).
 */
export class TurnStop extends Error {
  constructor(readonly code: 'TURN_PAUSED_FOR_CREDITS' | 'TURN_TOMBSTONED' | 'TURN_CALL_UNKNOWN' | 'TURN_PROVIDER_402'
    | 'TURN_CALL_DENIED') { super(code); }
}

type Adapter = { prepareDispatch(input: unknown, identity: CallIdentity, onChunk?: (chunk: string) => void,
  onIdentity?: (id: string) => void): Promise<() => Promise<TransportObservation>> };
export type ModelCall = {
  modelId: string; identity: CallIdentity & { provider: 'openrouter'; protocol: 'openrouter-chat-v1' };
  pricing: NominalPricing; upperUsd: string; multiplier: string;
  /** Concurrent calls allowed for this model across instances (catalog). */
  concurrency: number;
};
export type CallDeps = {
  db: TurnDatabase; adapter: Adapter; slots: CounterStore; actorId: string; turnId: number;
  /** The next free call sequence of this turn (one per attempt). */
  nextSeq: () => number;
  sleep?: (ms: number) => Promise<void>;
};
const MAX_ATTEMPTS = 2, RETRY_DELAY_MS = 500;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
// numeric(20,12): a nominal cost with more digits is rounded up, never down.
export function ceil12(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length <= 12) return value;
  const kept = BigInt((whole ?? '0') + fraction.slice(0, 12)) + (/[1-9]/.test(fraction.slice(12)) ? 1n : 0n);
  const digits = kept.toString().padStart(13, '0');
  return `${digits.slice(0, -12)}.${digits.slice(-12)}`.replace(/\.?0+$/, '') || '0';
}

/** One logical model call. Returns the SDK completion to hand to the runner; throws TurnStop when the turn must stop. */
export async function modelCall(deps: CallDeps, call: ModelCall, body: string, onChunk?: (chunk: string) => void): Promise<string> {
  const requestHash = sha256(body);
  const input = { input: body, maxOutputTokens: call.identity.outputLimit, automaticRetry: false, hiddenTools: false };
  for (let attempt = 1; ; attempt++) {
    const seq = deps.nextSeq();
    const begun = await deps.db.begin({ actorId: deps.actorId, turnId: deps.turnId, seq, callKind: 'model', modelId: call.modelId,
      toolName: null, paid: null, requestHash, upperUsd: call.upperUsd, multiplier: call.multiplier });
    if (tombstoned(begun)) throw new TurnStop('TURN_TOMBSTONED');
    if (begun.paused) throw new TurnStop('TURN_PAUSED_FOR_CREDITS');
    const release = await acquireSlot(deps.slots, `model:${call.modelId}`, { limit: call.concurrency, sleep: deps.sleep });
    let identity: Promise<unknown> | undefined;
    const onIdentity = (providerId: string) => {
      identity ??= deps.db.identity({ actorId: deps.actorId, turnId: deps.turnId, seq, providerId }).catch(() => undefined);
    };
    let observation: TransportObservation;
    try {
      let send: () => Promise<TransportObservation>;
      try { send = await deps.adapter.prepareDispatch(input, call.identity, onChunk, onIdentity); }
      catch {
        // Refused locally before any byte left (shape whitelist, quote): certainly free, not worth a retry (the request is wrong).
        await deps.db.record({ actorId: deps.actorId, turnId: deps.turnId, seq, status: 'not_sent', nominalUsd: null, actualUsd: null,
          usage: {}, providerId: null, payloadHash: requestHash, raw: null });
        throw new TurnStop('TURN_CALL_DENIED');
      }
      try { observation = await send(); }
      catch (error) {
        // Proven unstarted (the time budget refused it before the transport): certainly free, retried once.
        if (consumeOpenRouterNotStarted(error, requestHash, send)) {
          await deps.db.record({ actorId: deps.actorId, turnId: deps.turnId, seq, status: 'not_sent', nominalUsd: null, actualUsd: null,
            usage: {}, providerId: null, payloadHash: requestHash, raw: null });
          if (attempt < MAX_ATTEMPTS) { await (deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms))))(RETRY_DELAY_MS); continue; }
          throw new TurnStop('TURN_CALL_UNKNOWN');
        }
        // Started and broke (disconnect, timeout): the outcome is unknown. Keep it for recovery; never send it again.
        await identity;
        throw new TurnStop('TURN_CALL_UNKNOWN');
      }
    } finally { await release(); }
    await identity;
    const rejection = openRouterRejection(observation, call.identity, requestHash);
    if (rejection && observation.httpStatus === 402) {
      // 402: the platform account could not pay; never charged (Owner item 53).
      await deps.db.record({ actorId: deps.actorId, turnId: deps.turnId, seq, status: 'no_charge_402', nominalUsd: null, actualUsd: null,
        usage: {}, providerId: rejection.providerId ?? null, payloadHash: sha256(observation.rawBody), raw: null });
      throw new TurnStop('TURN_PROVIDER_402');
    }
    const evidence = openRouterEvidence(observation, call.identity, 'response');
    const usage = (evidence.usage ?? null) as Record<string, unknown> | null;
    const completion = usage?.sdkResponse;
    if (!evidence.final || typeof evidence.cost !== 'string' || !usage) {
      // A usable answer whose cost is not final yet is still delivered; the call stays open for recovery to settle.
      if (completion) return JSON.stringify(completion);
      throw new TurnStop('TURN_CALL_UNKNOWN');
    }
    // The receipt keeps token counts as exact decimal strings.
    const count = (value: unknown) => typeof value === 'number' ? value
      : typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value) : undefined;
    const tokens = { promptTokens: count(usage.inputTokens), completionTokens: count(usage.outputTokens),
      reasoningTokens: count(usage.reasoningTokens) };
    const nominal = ceil12(nominalCost(call.pricing, tokens) ?? nominalActualFallback(evidence.cost, call.upperUsd));
    // The usage row keeps the token counts; the completion itself is the raw body, stored once.
    const receiptUsage = Object.fromEntries(Object.entries(usage).filter(([key]) => key !== 'sdkResponse'));
    const recorded = await deps.db.record({ actorId: deps.actorId, turnId: deps.turnId, seq, status: 'ok', nominalUsd: nominal,
      actualUsd: evidence.cost, usage: receiptUsage, providerId: evidence.providerId ?? null,
      payloadHash: evidence.sourceHash, raw: evidence.rawBody || null });
    if (tombstoned(recorded)) throw new TurnStop('TURN_TOMBSTONED');
    return JSON.stringify(completion);
  }
}
