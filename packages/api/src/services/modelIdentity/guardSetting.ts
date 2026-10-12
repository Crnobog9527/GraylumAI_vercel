/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';

/**
 * MODEL-IDENTITY-GUARD admin switch (migration 0216). On by default.
 * It controls the brand identity layers and page display only: provider model ids
 * are never sent to users whatever its value.
 */
export const MODEL_IDENTITY_GUARD_KEY = 'model_identity_guard';
const storedSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  revision: z.number().int().min(0).max(9999999999),
  updatedBy: z.string().uuid().nullable(),
  updatedAt: z.string().nullable(),
}).strict();
export const modelIdentityGuardUpdateSchema = z.object({
  enabled: z.boolean(),
  expectedRevision: z.number().int().min(0).max(9999999998),
}).strict();
export type ModelIdentityGuard = z.infer<typeof storedSchema>;

function unavailable(): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'MODEL_IDENTITY_GUARD_UNAVAILABLE' });
}

export async function readModelIdentityGuard(db: SupabaseClient): Promise<ModelIdentityGuard> {
  try {
    const { data, error } = await db.rpc('model_identity_guard_config');
    if (error) return unavailable();
    return storedSchema.parse(data);
  } catch { return unavailable(); }
}

/** For user-facing paths: any read failure keeps the protection on. */
export async function modelIdentityGuardEnabled(db: SupabaseClient): Promise<boolean> {
  try { return (await readModelIdentityGuard(db)).enabled; }
  catch {
    logger.error('security', 'model_identity_guard_read_failed_kept_on', {});
    return true;
  }
}

export async function setModelIdentityGuard(db: SupabaseClient, actorId: string,
  input: z.infer<typeof modelIdentityGuardUpdateSchema>) {
  const { enabled, expectedRevision } = modelIdentityGuardUpdateSchema.parse(input);
  let result;
  try {
    result = await db.rpc('model_identity_guard_set', {
      p_enabled: enabled, p_expected_revision: expectedRevision, p_actor: actorId,
    });
  } catch { return unavailable(); }
  if (result.error?.code === 'PT409') {
    throw new TRPCError({ code: 'CONFLICT', message: '设置已被其他人修改，请重新读取后再保存' });
  }
  if (result.error?.code === '42501') {
    throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号无权修改这个设置' });
  }
  if (result.error || !result.data) return unavailable();
  try { return storedSchema.parse(result.data); }
  catch { return unavailable(); }
}

/** Admin view: current state, who changed it last and the recent change history. */
export async function modelIdentityGuardView(db: SupabaseClient) {
  const config = await readModelIdentityGuard(db);
  try {
    const history = await db.from('user_activity_logs')
      .select('admin_id,details,created_at').eq('action', 'model_identity_guard_set')
      .order('created_at', { ascending: false }).limit(10);
    if (history.error) return unavailable();
    const ids = [...new Set([config.updatedBy, ...history.data.map(row => row.admin_id)]
      .filter((id): id is string => typeof id === 'string'))];
    const people = ids.length
      ? await db.from('profiles').select('id,email').in('id', ids)
      : { data: [] as Array<{ id: string; email: string | null }>, error: null };
    if (people.error) return unavailable();
    const email = (id: string | null) => people.data.find(p => p.id === id)?.email ?? null;
    return {
      config,
      updatedByEmail: email(config.updatedBy),
      history: history.data.map(row => ({
        enabled: (row.details as { enabled?: unknown } | null)?.enabled === true,
        operatorEmail: email(row.admin_id),
        at: row.created_at as string,
      })),
    };
  } catch { return unavailable(); }
}
