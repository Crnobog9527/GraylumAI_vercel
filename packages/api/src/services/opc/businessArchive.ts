/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TRPCError } from '@trpc/server';
import { stagingRpcFailure } from '../runtime/stagingErrors';

export const archiveBusinessInput = z.object({ businessId: z.string().uuid() }).strict();
const businessState = z.object({
  businessId: z.string().uuid(), name: z.string(), archivedAt: z.string().nullable(), isArchived: z.boolean(),
});
const businessList = z.array(businessState.extend({
  currentSourceVersionId: z.string().uuid().nullable(), createdAt: z.string(),
  drafts: z.array(z.object({
    draftId: z.string().uuid(), projectId: z.string().uuid(), roundId: z.string().uuid(), sessionId: z.string().uuid(),
  })),
}));
const refusals: Record<string, 'FORBIDDEN' | 'CONFLICT'> = {
  OPC_BUSINESS_DENIED: 'FORBIDDEN', OPC_BUSINESS_ARCHIVED: 'FORBIDDEN', OPC_BUSINESS_BUSY: 'CONFLICT',
};
async function businessRpc(admin: SupabaseClient, actorId: string, name: string, args = {}) {
  const { data, error } = await admin.rpc(name, { ...args, p_actor_id: actorId });
  if (error) {
    const code = refusals[error.message];
    if (code) throw new TRPCError({ code, message: error.message });
    stagingRpcFailure(error);
  }
  return data;
}
export async function listBusinesses(admin: SupabaseClient, actorId: string) {
  return businessList.parse(await businessRpc(admin, actorId, 'opc_businesses_list'));
}
export async function archiveBusiness(admin: SupabaseClient, actorId: string, businessId: string) {
  return businessState.parse(await businessRpc(admin, actorId, 'opc_business_archive', { p_business_id: businessId }));
}
