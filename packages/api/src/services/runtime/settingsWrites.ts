/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Keep terminal version conflicts distinct from unavailable storage (PostgREST PT409). */
export async function writeRuntimeSetting(db: SupabaseClient, name: string, args: Record<string, unknown>) {
  let result;
  try { result = await db.rpc(name, args); }
  catch { throw unavailable(); }
  if (result.error?.code === 'PT409') {
    throw new TRPCError({ code: 'CONFLICT', message: '设置已被其他人修改，请重新读取后再保存' });
  }
  if (result.error || !result.data) throw unavailable();
  return result.data as unknown;
}
function unavailable() {
  return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: '无法读取或保存使用额度，请稍后再试' });
}
