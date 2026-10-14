/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../../lib/logger';
import { envFallbackValue, invalidatePlatformSecret } from './reader';
import { lastFour, PLATFORM_SECRET_ENV_FALLBACK, PLATFORM_SECRET_SLOTS, validPlatformSecret } from './slots';

/**
 * Admin side of ADMIN-SECRETS: write-only. Nothing here reads or returns a stored value; the
 * browser only ever sees the last four characters, who changed it and when.
 */
const slotSchema = z.enum(PLATFORM_SECRET_SLOTS);
const revisionSchema = z.number().int().min(0).max(9999999998);

export const platformSecretSetSchema = z.object({
  slot: slotSchema,
  value: z.string().max(2048).transform(value => value.trim()),
  expectedRevision: revisionSchema,
}).strict().superRefine((input, ctx) => {
  // A fixed message: the submitted value is never echoed back, not even in a validation error.
  if (!validPlatformSecret(input.slot, input.value)) {
    ctx.addIssue({ code: 'custom', path: ['value'], message: 'PLATFORM_SECRET_FORMAT_INVALID' });
  }
});
export const platformSecretClearSchema = z.object({ slot: slotSchema, expectedRevision: revisionSchema }).strict();

const statusSchema = z.array(z.object({
  slot: slotSchema,
  configured: z.boolean(),
  last4: z.string().length(4).nullable(),
  revision: z.number().int().min(0),
  updatedBy: z.string().uuid().nullable(),
  updatedAt: z.string().nullable(),
}).strict()).length(PLATFORM_SECRET_SLOTS.length);

function unavailable(): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'PLATFORM_SECRET_UNAVAILABLE' });
}

function mapWriteError(code: string | undefined, action: string): never {
  logger.warn('security', 'platform_secret_write_refused', { action, code: code ?? 'unknown' });
  if (code === 'PT409') throw new TRPCError({ code: 'CONFLICT', message: '密钥已被其他管理员修改，请刷新后再保存' });
  if (code === '42501') throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号无权修改密钥' });
  if (code === '23514') throw new TRPCError({ code: 'BAD_REQUEST', message: 'PLATFORM_SECRET_FORMAT_INVALID' });
  if (code === '55000') throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'PLATFORM_SECRET_VAULT_MISSING' });
  return unavailable();
}

/** Admin view: per slot, whether it is filled, its last four characters, who and when, and the
 * transition fallback (whether the environment variable exists and its last four characters). */
export async function platformSecretsView(db: SupabaseClient, env: Record<string, string | undefined> = process.env) {
  let rows: z.infer<typeof statusSchema>;
  try {
    const { data, error } = await db.rpc('platform_secret_status');
    if (error) return unavailable();
    rows = statusSchema.parse(data);
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    return unavailable();
  }
  const ids = [...new Set(rows.map(row => row.updatedBy).filter((id): id is string => id !== null))];
  let emails = new Map<string, string | null>();
  if (ids.length) {
    const people = await db.from('profiles').select('id,email').in('id', ids);
    if (people.error) return unavailable();
    emails = new Map((people.data ?? []).map(p => [p.id as string, (p.email as string | null) ?? null]));
  }
  return {
    slots: rows.map(row => {
      const envName = PLATFORM_SECRET_ENV_FALLBACK[row.slot];
      const envValue = envFallbackValue(row.slot, env);
      return {
        slot: row.slot,
        configured: row.configured,
        last4: row.last4,
        revision: row.revision,
        updatedAt: row.updatedAt,
        updatedByEmail: row.updatedBy ? emails.get(row.updatedBy) ?? null : null,
        envFallback: envName ? { name: envName, present: envValue !== null,
          last4: envValue ? lastFour(envValue) : null } : null,
        source: row.configured ? 'admin' as const : envValue ? 'env' as const : 'none' as const,
      };
    }),
  };
}

export async function setPlatformSecret(db: SupabaseClient, actorId: string,
  input: z.input<typeof platformSecretSetSchema>) {
  const { slot, value, expectedRevision } = platformSecretSetSchema.parse(input);
  let result;
  try {
    result = await db.rpc('platform_secret_set',
      { p_slot: slot, p_value: value, p_expected_revision: expectedRevision, p_actor: actorId });
  } catch { return unavailable(); }
  if (result.error) return mapWriteError(result.error.code, 'set');
  invalidatePlatformSecret(slot);
  logger.info('security', 'platform_secret_saved', { slot, actorId });
}

export async function clearPlatformSecret(db: SupabaseClient, actorId: string,
  input: z.input<typeof platformSecretClearSchema>) {
  const { slot, expectedRevision } = platformSecretClearSchema.parse(input);
  let result;
  try {
    result = await db.rpc('platform_secret_clear', { p_slot: slot, p_expected_revision: expectedRevision, p_actor: actorId });
  } catch { return unavailable(); }
  if (result.error) return mapWriteError(result.error.code, 'clear');
  invalidatePlatformSecret(slot);
  logger.info('security', 'platform_secret_cleared', { slot, actorId });
}
