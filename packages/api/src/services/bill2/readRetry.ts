/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type { RuntimeBudget } from '../runtime/budget';
import type { BillingRpc } from './service';

// Audited reads only: no dispatch, recovery claim, receipt write, finalize or runtime_response
// (whose authorization chain takes material row locks). No caller-supplied RPC names widen this list.
export const isBillingRead = (name: string) => name === 'bill2_read' || name === 'runtime_receipt_saved';
const transientCodes = new Set(['57014', 'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003',
  '08000', '08001', '08003', '08006', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);

export function transientDatabaseFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown } };
  if (typeof value.code === 'string' && value.code) return transientCodes.has(value.code);
  if (value.name === 'TimeoutError' || value.name === 'AbortError') return true;
  if (value.cause?.code && transientCodes.has(String(value.cause.code))) return true;
  // postgrest-js returns native fetch errors as data errors with an empty code, not thrown Errors.
  return typeof value.message === 'string' && /^(?:TypeError: fetch failed|FetchError: |TimeoutError: |AbortError: )/.test(value.message);
}

export class BillingDatabaseUnavailable extends Error {
  readonly transient: boolean;
  constructor(error: unknown) {
    super('BILL2_DATABASE_UNAVAILABLE');
    this.transient = transientDatabaseFailure(error);
  }
}

/** Two attempts share the original 10s read deadline AND the original invocation deadline.
 * A full native deadline timeout leaves no retry time. A faster server/transport failure may retry once. */
export async function readBillingRpc(database: BillingRpc, name: string, args: Record<string, unknown>, budget?: RuntimeBudget) {
  if (!isBillingRead(name)) throw new Error('BILL2_READ_RETRY_DENIED');
  const remaining = Math.floor(budget?.remainingPersistence() ?? 10_000);
  if (remaining <= 0) return { data: null, error: new DOMException('deadline', 'TimeoutError') };
  const timeout = Math.min(10_000, remaining), deadline = performance.now() + timeout;
  const signal = AbortSignal.timeout(timeout);
  for (let attempt = 0; ; attempt++) {
    let result: { data: unknown; error: unknown };
    try {
      const query = database.rpc(name, args);
      result = await (query.abortSignal ? query.abortSignal(signal) : query);
    } catch (error) { result = { data: null, error }; }
    if (!result.error || attempt === 1 || signal.aborted || performance.now() >= deadline || (budget?.remainingPersistence() ?? 1) <= 0
      || !transientDatabaseFailure(result.error)) return result;
  }
}
