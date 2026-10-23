/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * The attached organizer's response can be lost while its call is still billed:
 * the provider finished, but the original HTTP never stored the body, and a
 * generation lookup later recovered only the cost (a `lookup` receipt has no
 * content). Such a call stays `responded` without a stored response for good.
 * The organizer output is optional, so the turn then completes as not organized
 * instead of waiting for a body that cannot arrive (staging 2026-10-23: the turn
 * could neither finish nor be stopped for five minutes).
 */
export const ORGANIZER_OUTPUT_LOST = 'RUNTIME_ORGANIZER_OUTPUT_LOST';

type StoredResponse = { callId?: string; state?: string; rawBody?: string | null } | null | undefined;
type PendingResponse = Error & { response?: { saved: StoredResponse; sequence: number; requestHash: string } };

/** RUNTIME_RESPONSE_PENDING, carrying the call it waited for so the organizer can tell a lost body apart. */
export function responsePending(saved: StoredResponse, sequence: number, requestHash: string) {
  const error: PendingResponse = new Error('RUNTIME_RESPONSE_PENDING');
  error.response = { saved, sequence, requestHash };
  return error;
}

/**
 * One organizer round. `recover` handles its exchange failure: a call still in
 * flight (`dispatched` or `unknown`) gets one bounded receipt recovery first,
 * and a body stored by then is used as usual. A `responded` call without a body
 * is lost. Anything else rethrows the original error, so financial recovery and
 * retries keep their path. The SDK runner hides exchange errors behind its own
 * code, so `summary` reads the loss from this round, never from the error.
 */
export function organizerExchange(protocol: string, payg: boolean, runId: string,
  billing: { finalizeRun: (runId: string) => Promise<unknown>; recoverReceipts: (runId: string, options: { callId: string }) => Promise<unknown> },
  rpc: <T>(name: string, value: Record<string, unknown>) => Promise<T>, args: Record<string, unknown>) {
  const read = (sequence: number, requestHash: string) =>
    rpc<StoredResponse>('runtime_response', { ...args, p_sequence: sequence, p_request_hash: requestHash });
  let lost = false;
  return {
    recover: async (error: unknown) => {
      const pending = (error as PendingResponse | null)?.response;
      if (!pending) throw error;
      let saved = pending.saved;
      if (saved?.callId && ['dispatched', 'unknown'].includes(saved.state ?? '')) {
        await billing.recoverReceipts(runId, { callId: saved.callId }).catch(() => undefined);
        saved = await read(pending.sequence, pending.requestHash);
      }
      if (saved?.rawBody) {
        // BILL2 v2 finalizes the run once a response is read, as the ordinary exchange does.
        if (payg) await billing.finalizeRun(runId);
        const decoded = JSON.parse(saved.rawBody);
        return protocol === 'openrouter-chat-v1' ? { usage: { sdkResponse: decoded } } : decoded;
      }
      if (saved?.state !== 'responded') throw error;
      lost = true;
      throw new Error(ORGANIZER_OUTPUT_LOST);
    },
    /** The organizer summary, or `{ lost: true }` when its output can never be read. */
    async summary(run: () => Promise<string>): Promise<string | { lost: true }> {
      try {
        return await run();
      } catch (error) {
        if (lost) return { lost: true };
        throw error;
      }
    },
  };
}
