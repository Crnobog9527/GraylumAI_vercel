/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isEmailVerified } from '../../lib/auth';
import { isSqlStagingRefusal } from '../turn/agent/contentSource';
import { StagingAccessError, stagingRpcFailure } from '../turn/settings/stagingErrors';
import { throwIfContentBindingRefused } from './contentBindingError';

const uuid = z.string().uuid();
/** Where a conversation lives: the positioning list, or one work item of a project. */
const startScope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('positioning_draft') }).strict(),
  z.object({ kind: z.literal('work_item'), projectId: uuid, workItemId: uuid }).strict(),
]);

/**
 * Opens (or, for the same request id, returns again) the conversation a page sends its turns in (runtime_start). The actor is
 * the verified user; SQL refusals keep their business code and anything else is classified as an operational failure.
 */
export async function runtimeStart(user: SupabaseClient, admin: SupabaseClient, requestId: string, scope: unknown) {
  const auth = await user.auth.getUser();
  if (auth.error || !auth.data.user || !isEmailVerified(auth.data.user)) throw new Error('RUNTIME_AUTH_REQUIRED');
  const result = await admin.rpc('runtime_start', { p_request_id: uuid.parse(requestId), p_payload: { scope: startScope.parse(scope) },
    p_actor_id: auth.data.user.id });
  if (result.error?.code === 'P0001' && result.error.message === 'OPC_BUSINESS_ARCHIVED') throw new StagingAccessError('OPC_BUSINESS_ARCHIVED');
  if (result.error) throwIfContentBindingRefused(result.error);
  if (result.error && isSqlStagingRefusal(result.error.message)) throw new StagingAccessError(result.error.message);
  if (result.error) {
    if (['P0001', 'PT400', '42501'].includes(result.error.code)) throw new Error('RUNTIME_ADMISSION_DENIED');
    stagingRpcFailure(result.error);
  }
  return result.data;
}
