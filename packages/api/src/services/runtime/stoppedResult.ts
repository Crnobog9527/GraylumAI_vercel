/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { agentTurnBody, AGENT_TURN_FORMAT, questionCardSchema, questionToolCardSchema } from '../../shared/agentTurn';
import { stepEnvelope } from './nativeOutput';
import type { NativeTextSource } from './nativeProgress';
import { attachNativeSummary, fitNativeResult } from './resultCapacity';

export type StoppedResult = {
  kind: 'usable_result'; evidenceRef: string; evidenceHash: string; body: string;
  stopped: true; completeness: 'complete' | 'stopped' | 'length_limit';
  summary?: string; organized?: boolean; summaryOmitted?: boolean; envelopeCompact?: boolean;
};
export type StopProjectionInput = {
  executionId: string;
  /** Trusted frozen format, never inferred from client input or the result itself. */
  format: 'plain' | 'agent' | 'step';
  body: string; stopAt: number;
  /** Client source is optional for old clients; the expected source is receipt-derived. */
  source?: NativeTextSource;
  expectedSource: NativeTextSource;
  primaryComplete: boolean;
  attachedOrganizer: boolean;
  summary?: string;
};

/** Shared deterministic projection for live completion and receipt-only recovery.
 * Null is §4.2(e), not a usable empty result. No clock, provider call or database write. */
export function stoppedResult(input: StopProjectionInput): StoppedResult | null {
  if (!Number.isSafeInteger(input.stopAt) || input.stopAt < 0) throw new Error('RUNTIME_STOP_POSITION_INVALID');
  if (!input.source || input.source !== input.expectedSource || input.stopAt === 0) return null;
  let visible = input.body;
  let rebuild = (message: string) => message;
  let validateEnvelope: ((value: unknown) => { message: string }) | undefined;
  try {
    if (input.format === 'step') {
      const envelope = stepEnvelope.parse(JSON.parse(input.body));
      visible = envelope.message;
      rebuild = message => JSON.stringify(stepEnvelope.parse({ ...envelope, message }));
      validateEnvelope = value => stepEnvelope.parse(value);
    } else if (input.format === 'agent') {
      const envelope = JSON.parse(input.body);
      if (envelope?.format !== AGENT_TURN_FORMAT || typeof envelope.message !== 'string') return null;
      const card = envelope.card === null ? null
        : (envelope.card?.message === undefined ? questionCardSchema : questionToolCardSchema).parse(envelope.card);
      if (card && 'message' in card && card.message !== envelope.message) return null;
      visible = envelope.message;
      rebuild = message => agentTurnBody(message, message === visible ? card : null, 262144);
    }
    const message = Array.from(visible).slice(0, input.stopAt).join('').trimEnd();
    if (!message) return null;
    const truncated = message !== visible;
    const base: StoppedResult = {
      kind: 'usable_result', evidenceRef: input.executionId, evidenceHash: '0'.repeat(64),
      body: rebuild(message), stopped: true,
      completeness: input.primaryComplete && !truncated ? 'complete' : 'stopped',
    };
    let result: StoppedResult = fitNativeResult(base, {
      attachedOrganizer: input.attachedOrganizer, ...(validateEnvelope ? { validateEnvelope } : {}),
    });
    // Capacity truncation also invalidates a question card and its unseen options.
    if (input.format === 'agent' && result.body !== base.body) {
      const envelope = JSON.parse(result.body);
      result = { ...result, body: agentTurnBody(envelope.message, null, 262144) };
    }
    if (input.attachedOrganizer) {
      const summary = result.completeness === 'complete' ? input.summary ?? '' : '';
      result = summary.trim() ? attachNativeSummary(result, summary)
        : { ...result, summary: '', organized: false };
    }
    const evidence: Record<string, unknown> = { ...result };
    delete evidence.evidenceHash;
    result.evidenceHash = createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
    return result;
  } catch {
    // Invalid model envelopes must never become stored protocol fragments.
    return null;
  }
}
