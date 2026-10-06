/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { refundTime } from './refundMoney';

const reference = z.string().trim().min(1).max(160);
const time = z.string().refine(value => refundTime(value) !== null);
export const refundConsumptionSchema = z.object({
  userId: reference,
  from: time,
  through: time,
  evidenceRef: reference,
  state: z.enum(['unused', 'consumed', 'unresolved']),
  completeAccountHistory: z.boolean(),
  settlementState: z.enum(['clear', 'pending', 'unknown']),
}).strict();
export type RefundConsumption = z.infer<typeof refundConsumptionSchema>;

const ledgerRowSchema = z.object({
  id: reference,
  user_id: reference,
  created_at: time,
  amount: z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/)]),
  type: z.string(),
  ledger_type: z.string().nullable(),
  reason_code: z.string().nullable(),
}).strict();
const evidenceSchema = z.object({
  userId: reference,
  paidAt: time,
  observedAt: time,
  evidenceRef: reference,
  // The caller must prove a complete account-wide read, not a source-filtered,
  // latest-N, truncated or failed query. PR-4B owns that read and its freshness.
  completeAccountHistory: z.boolean(),
  // Includes holds started BEFORE payment and unknown provider settlements.
  settlementState: z.enum(['clear', 'pending', 'unknown']),
  rows: z.array(ledgerRowSchema),
}).strict();

/** Pure read-only projection of server-owned evidence, never client request data.
 * No DB/provider calls or mutations. Missing coverage must not become zero usage.
 * Positive returns never cancel a historical consumption entry.
 */
export function assembleRefundConsumption(input: unknown): RefundConsumption | null {
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) return null;
  const value = parsed.data;
  const from = refundTime(value.paidAt)!;
  const through = refundTime(value.observedAt)!;
  if (from > through) return null;
  let consumed = false;
  let unresolved = !value.completeAccountHistory || value.settlementState !== 'clear';
  const ids = new Set<string>();
  for (const row of value.rows) {
    if (row.user_id !== value.userId || ids.has(row.id)) return null;
    ids.add(row.id);
    const at = refundTime(row.created_at)!;
    if (at > through) return null;
    if (at < from) continue;
    const amount = String(row.amount);
    const nonzero = /[1-9]/.test(amount);
    const negative = amount.startsWith('-') && nonzero;
    const spend = row.type === 'consumption' || row.type === 'deduction'
      || row.ledger_type === 'spend' || row.reason_code === 'bill2_spend';
    if (spend) {
      if (negative) consumed = true;
      else if (nonzero) unresolved = true; // Invalid sign, not evidence of no usage.
    } else if (negative && row.reason_code !== 'bill2_reserve') {
      // An unclassified debit could be consumption: do not guess it away.
      unresolved = true;
    }
  }
  return { userId: value.userId, from: value.paidAt, through: value.observedAt,
    evidenceRef: value.evidenceRef, completeAccountHistory: value.completeAccountHistory,
    settlementState: unresolved && value.settlementState === 'clear' ? 'unknown' : value.settlementState,
    state: consumed ? 'consumed' : unresolved ? 'unresolved' : 'unused' };
}
