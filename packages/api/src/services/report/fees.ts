/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';

/** The report's fixed price (0299, Owner 2026-10-17 "报告固定价 500 积分"): an administrator-editable scalar setting. */
export const REPORT_PRICE_KEY = 'report_fixed_price_credits';
export const DEFAULT_REPORT_PRICE = 500;

/** The price the button shows; the database reads the same row when it holds it, so the two cannot differ. */
export async function reportPrice(admin: SupabaseClient): Promise<number> {
  const row = await admin.from('system_settings').select('value').eq('key', REPORT_PRICE_KEY).maybeSingle();
  if (row.error) throw new Error('REPORT_UNAVAILABLE');
  if (!row.data) return DEFAULT_REPORT_PRICE;
  const parsed = z.coerce.number().int().min(1).max(999999).safeParse(row.data.value);
  if (!parsed.success) throw new Error('REPORT_UNAVAILABLE');
  return parsed.data;
}

export const reportFee = z.object({ credits: z.number().int().positive(), state: z.enum(['held', 'charged', 'refunded']),
  chargedCredits: z.number().int().nonnegative().nullable(), reason: z.string().nullable(), settledAt: z.string().nullable() });
export type ReportFee = z.infer<typeof reportFee>;

/** Daily backstop of the billing reconciliation: settles held report prices whose execution has ended. */
export async function settleDueReportFees(admin: SupabaseClient): Promise<{ success: boolean; settled: number }> {
  const result = await admin.rpc('report_fee_settle_due', { p_limit: 200 });
  if (result.error) return { success: false, settled: 0 };
  return { success: true, settled: Number(result.data) || 0 };
}
