/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { reportModelErrorCode } from './modelErrors';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { REPORT_SETTING } from './contract';

export const reportCodes = new Set(['OPC_BUSINESS_ARCHIVED', 'REPORT_DISABLED', 'REPORT_MEMBERSHIP_REQUIRED', 'REPORT_ENTITLEMENTS_UNAVAILABLE',
  'REPORT_SOURCE_CONFLICT', 'REPORT_CONFIRMATION_REQUIRED', 'REPORT_FACTS_TOO_LARGE', 'REPORT_MANIFEST_REQUIRED',
  'REPORT_PAYG_REQUIRED', 'OPC_CAPTURE_PENDING', 'REPORT_EXECUTION_REQUIRED', 'REPORT_REQUEST_CONFLICT', 'REPORT_ALREADY_EXISTS',
  'REPORT_BENCHMARKS_REQUIRED',
  // 0295: the balance does not cover the report's fixed price plus its call's temporary hold.
  'REPORT_CREDITS', 'REPORT_PRICE_CHANGED', 'REPORT_PRICE_REQUIRED']);
export function reportError(error: unknown): never {
  const message = error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? error.message : null;
  const modelCode = reportModelErrorCode(message);
  throw new TRPCError({ code: ['REPORT_MEMBERSHIP_REQUIRED', 'OPC_BUSINESS_ARCHIVED'].includes(String(message)) ? 'FORBIDDEN' : 'BAD_REQUEST',
    cause: error, message: modelCode ?? (typeof message === 'string' && reportCodes.has(message) ? message : 'REPORT_UNAVAILABLE') });
}
/** The server switch: only a strict `{enabled:true}` setting enables NEW report admission. */
export async function reportEnabled(admin: SupabaseClient) {
  const setting = await admin.from('system_settings').select('value').eq('key', REPORT_SETTING).maybeSingle();
  if (setting.error) throw new Error('REPORT_UNAVAILABLE');
  const enabled: unknown = setting.data?.value;
  return z.object({ enabled: z.literal(true) }).strict().safeParse(enabled).success;
}
