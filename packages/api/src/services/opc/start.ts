/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from "zod";
import type {SupabaseClient} from '@supabase/supabase-js';
import {isEmailVerified} from '../../lib/auth';
import {readPositioningProfileEntitlement} from '../membershipEntitlements';
const uuid = z.string().uuid();
export const opcStart = z
  .object({
    requestId: uuid,
    registration: z.string().min(1).max(100),
    mode: z.enum(["mentor", "manual"]),
    businessId: uuid.nullable().optional(),
    businessName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export async function startWithPositioningProfileLimit<T>(
  value: unknown,
  user: SupabaseClient,
  admin: SupabaseClient,
  rpc: (name: string, args: Record<string, unknown>, actorId?: string) => Promise<T>,
): Promise<T> {
  const input = opcStart.parse(value);
  const auth = await user.auth.getUser();
  if (auth.error || !auth.data.user || !isEmailVerified(auth.data.user)) throw new Error('OPC_AUTH_REQUIRED');
  const entitlement = await readPositioningProfileEntitlement(admin, auth.data.user.id);
  return rpc('opc_start_b1', {
    p_request_id: input.requestId,
    p_registration: input.registration,
    p_mode: input.mode,
    p_business_id: input.businessId ?? null,
    p_business_name: input.businessName ?? null,
    p_membership_level: entitlement.level,
  }, auth.data.user.id);
}
export const opcTopicBind = z
  .object({ draftId: uuid, requestId: uuid, sourceVersionId: uuid })
  .strict();
