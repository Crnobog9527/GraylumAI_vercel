/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { decimal, DECIMAL_SCALE } from '../../bill2/decimal';
import { TurnStop } from '../call';
import { tombstoned, TurnDatabaseError } from '../db';
import type { SubcallReceipt, ToolCallDeps, ToolCallOutcome } from './types';

/*
 * CORE-PATH-V2 2.5.2 / 2.5.3: one tool call is one turn_calls row. A paid call (research) writes turn_call_begin before its
 * first supplier subcall and turn_call_record after its last one; its subcalls are counted in Node and their costs summed into
 * that one receipt, so a turn of three research calls is six writes however many subcalls they make. A free call (library
 * read, Skill load) writes the same two rows with a zero bound: it costs the user nothing, but the model call that reads its
 * result is one of the turn's M (2.5.3).
 */
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const format = (value: bigint) => {
  const whole = value / DECIMAL_SCALE, fraction = (value % DECIMAL_SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
};

/** The tool call could not start: its limit is used up (the model is told; nothing was written or sent). */
export class ToolLimitReached extends Error {
  constructor() { super('TURN_CALL_LIMIT'); }
}

export type Settlement =
  | { outcome: 'not_sent' }
  | { outcome: 'unknown' }
  | { outcome: 'delivered'; nominalUsd: string; actualUsd: string }
  | { outcome: 'no_data'; actualUsd: string };

const hasData = (receipt: SubcallReceipt) =>
  (receipt.result.outcome === 'ok' || receipt.result.outcome === 'partial') && receipt.result.items.length > 0;

/**
 * How the subcalls of one call settle (types.ts ToolCallOutcome). `multiplier` is the row's m: the user pays
 * ceil(q x n x m) with n = sum(cost_i x m_i / m), so a route with a smaller m than the row's is never overcharged.
 */
export function settleToolCall(receipts: readonly SubcallReceipt[], multiplier: string): Settlement {
  const sent = receipts.filter(receipt => receipt.result.outcome !== 'not_sent');
  if (!sent.length) return { outcome: 'not_sent' };
  // Any subcall that may have reached the supplier without a priced answer leaves the whole call unknown: the user pays 0
  // for it and its reserve waits for recovery (third-party tool rule, Owner 10-13). Never presumed free, never resent.
  if (sent.some(receipt => receipt.result.outcome === 'unknown' || receipt.costUsd === null)) return { outcome: 'unknown' };
  const actual = sent.reduce((sum, receipt) => sum + decimal(receipt.costUsd), 0n);
  if (!sent.some(hasData)) return { outcome: 'no_data', actualUsd: format(actual) };
  const m = decimal(multiplier);
  if (m === 0n) throw new Error('TURN_TOOL_MULTIPLIER_INVALID');
  // sum(cost_i x m_i) / m, rounded up at 12 digits (the user's base is never rounded down below its true amount).
  const weighted = sent.reduce((sum, receipt) => sum + decimal(receipt.costUsd) * decimal(receipt.multiplier), 0n);
  const nominal = (weighted + m - 1n) / m;
  return { outcome: 'delivered', nominalUsd: format(nominal), actualUsd: format(actual) };
}

export type PaidToolCall = { toolName: string; requestHash: string; upperUsd: string; multiplier: string };

/** Collects one call's subcall receipts while it runs. */
export type SubcallLedger = { add(receipt: SubcallReceipt): void; readonly receipts: readonly SubcallReceipt[] };

/**
 * One paid tool call: begin, run (which sends the subcalls and adds their receipts), settle, record. A pause or tombstone
 * found by begin stops the turn (TurnStop); a used-up limit throws ToolLimitReached before anything is written. `run` may
 * throw: whatever it already sent is still settled first (an unknown outcome is left for turn_close), then the error passes.
 */
export async function paidToolCall<T>(deps: ToolCallDeps, call: PaidToolCall,
  run: (ledger: SubcallLedger) => Promise<T>): Promise<{ value: T; outcome: ToolCallOutcome }> {
  const seq = deps.nextSeq();
  const base = { actorId: deps.actorId, turnId: deps.turnId, seq };
  let begun;
  try {
    begun = await deps.db.begin({ ...base, callKind: 'tool', modelId: null, toolName: call.toolName, paid: true,
      requestHash: call.requestHash, upperUsd: call.upperUsd, multiplier: call.multiplier });
  } catch (error) {
    if (error instanceof TurnDatabaseError && error.code === 'TURN_CALL_LIMIT') throw new ToolLimitReached();
    throw error;
  }
  const notSent = () => deps.db.record({ ...base, status: 'not_sent', nominalUsd: null, actualUsd: null, usage: {},
    providerId: null, payloadHash: call.requestHash, raw: null });
  if (begun.paused) throw new TurnStop('TURN_PAUSED_FOR_CREDITS');
  if (tombstoned(begun)) { await notSent(); throw new TurnStop('TURN_TOMBSTONED'); }

  const receipts: SubcallReceipt[] = [];
  let value: T, failure: unknown, failed = false;
  try { value = await run({ add: receipt => { receipts.push(receipt); }, receipts }); }
  catch (error) { failure = error; failed = true; }
  const settled = settleToolCall(receipts, call.multiplier);
  // The receipt keeps what each subcall was and returned (counts, outcome, cost); the items themselves go to the raw body.
  const usage = { subcalls: receipts.length, outcome: settled.outcome, vendors: [...new Set(receipts.map(r => r.result.vendor))],
    results: receipts.map(r => ({ route: r.result.route, outcome: r.result.outcome, reason: r.result.reason, items: r.result.items.length,
      units: r.result.usage.units, costUsd: r.costUsd })) };
  const raw = receipts.length ? JSON.stringify(receipts.map(r => r.result)) : null;
  const payloadHash = sha256(raw ?? call.requestHash);
  if (settled.outcome === 'not_sent') await notSent();
  else if (settled.outcome !== 'unknown') {
    const recorded = await deps.db.record({ ...base, status: settled.outcome === 'delivered' ? 'ok' : 'unusable',
      nominalUsd: settled.outcome === 'delivered' ? settled.nominalUsd : null, actualUsd: settled.actualUsd, usage, providerId: null,
      payloadHash, raw });
    if (tombstoned(recorded)) throw new TurnStop('TURN_TOMBSTONED');
  }
  if (failed) throw failure;
  return { value: value!, outcome: settled.outcome };
}

/**
 * One free tool call: begin with a zero bound, read, record n=0. The read's own failure records the row as not_sent (it
 * cost nothing and does not count against the limit) before the error passes.
 */
export async function freeToolCall<T>(deps: ToolCallDeps, call: { toolName: string; requestHash: string; multiplier: string },
  read: () => Promise<{ value: T; raw: string | null }>): Promise<T> {
  const seq = deps.nextSeq();
  const base = { actorId: deps.actorId, turnId: deps.turnId, seq };
  let begun;
  try {
    begun = await deps.db.begin({ ...base, callKind: 'tool', modelId: null, toolName: call.toolName, paid: false,
      requestHash: call.requestHash, upperUsd: '0', multiplier: call.multiplier });
  } catch (error) {
    if (error instanceof TurnDatabaseError && error.code === 'TURN_CALL_LIMIT') throw new ToolLimitReached();
    throw error;
  }
  const notSent = () => deps.db.record({ ...base, status: 'not_sent', nominalUsd: null, actualUsd: null, usage: {},
    providerId: null, payloadHash: call.requestHash, raw: null });
  if (begun.paused) throw new TurnStop('TURN_PAUSED_FOR_CREDITS');
  if (tombstoned(begun)) { await notSent(); throw new TurnStop('TURN_TOMBSTONED'); }
  let result;
  try { result = await read(); }
  catch (error) { await notSent(); throw error; }
  const recorded = await deps.db.record({ ...base, status: 'ok', nominalUsd: '0', actualUsd: '0', usage: { tool: call.toolName },
    providerId: null, payloadHash: sha256(result.raw ?? call.requestHash), raw: result.raw });
  if (tombstoned(recorded)) throw new TurnStop('TURN_TOMBSTONED');
  return result.value;
}
