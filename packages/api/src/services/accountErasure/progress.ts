/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash, randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { BillingRpc } from '../bill2/service';
import { checkRateLimitOrThrow } from '../redisRateLimiter';

const inputSchema = z.object({ requestId: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const progressSchema = z.object({
  stage: z.enum(['closed', 'erasing', 'billing_pending', 'completed']),
  confirmedAt: z.string().datetime({ offset: true }), updatedAt: z.string().datetime({ offset: true }), needsReview: z.boolean(),
}).strict();
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const unavailable = () => new TRPCError({ code: 'NOT_FOUND', message: '注销进度凭证无效或已过期' });

/** Only SQL can issue the first capability. A repeated or ambiguous write never returns a replacement token. */
export async function issueAccountErasureProgress(database: BillingRpc, profileId: string, requestId: string): Promise<string | null> {
  if (!z.string().uuid().safeParse(profileId).success || !z.string().uuid().safeParse(requestId).success) return null;
  const token = randomBytes(32).toString('base64url');
  try {
    const result = await database.rpc('account_erasure_progress_issue', {
      p_profile_id: profileId, p_request_id: requestId, p_token_hash: hash(token),
    });
    if (result.error) return null;
    const issued = z.object({ issued: z.boolean() }).strict().safeParse(result.data);
    return issued.success && issued.data.issued ? token : null;
  } catch { return null; }
}

/** Body-only public mutation: no account session or profile bootstrap, no token in a query URL or logs. */
export async function readAccountErasureProgress(database: BillingRpc, input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw unavailable();
  const tokenHash = hash(parsed.data.token);
  await checkRateLimitOrThrow(`account-erasure-progress:${tokenHash.slice(0, 32)}`, 'auth');
  try {
    const result = await database.rpc('account_erasure_progress_read', {
      p_request_id: parsed.data.requestId, p_token_hash: tokenHash,
    });
    if (result.error) throw unavailable();
    const progress = progressSchema.safeParse(result.data);
    if (!progress.success) throw unavailable();
    return progress.data;
  } catch { throw unavailable(); }
}
