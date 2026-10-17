/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { logger } from '../../lib/logger';

/**
 * EXPERT-CONSULT (Master Plan 2.1 item 51): a booking request for the Owner's one-to-one diagnosis.
 * Stored as a 'consult' ticket by service-role RPCs only (0281); the database decides eligibility
 * (a confirmed positioning) and keeps one request per account at a time. No price, no payment.
 */
type Rpc = Pick<SupabaseClient, 'rpc'>;
const uuid = z.string().uuid();
export const EXPERT_CONSULT_SOURCES = ['report', 'pricing', 'studio'] as const;
export const expertConsultInput = z.object({
  need: z.string().trim().min(10).max(2000),
  contact: z.string().trim().min(3).max(200),
  source: z.enum(EXPERT_CONSULT_SOURCES),
}).strict();
export type ExpertConsultInput = z.infer<typeof expertConsultInput>;

const pending = z.object({ ticketId: uuid, createdAt: z.string().min(1) }).strict();
const stateSchema = z.object({ eligible: z.boolean(), pending: pending.nullable() }).strict();
const resultSchema = pending.extend({ created: z.boolean() }).strict();
export type ExpertConsultState = z.infer<typeof stateSchema>;
export type ExpertConsultResult = z.infer<typeof resultSchema>;

export type ExpertConsultErrorCode = 'EXPERT_CONSULT_NOT_ELIGIBLE' | 'EXPERT_CONSULT_INVALID'
  | 'EXPERT_CONSULT_ACCOUNT_CLOSED' | 'EXPERT_CONSULT_UNAVAILABLE';
export class ExpertConsultError extends Error {
  constructor(readonly code: ExpertConsultErrorCode) { super(code); }
}
const known: ExpertConsultErrorCode[] = ['EXPERT_CONSULT_NOT_ELIGIBLE', 'EXPERT_CONSULT_INVALID', 'EXPERT_CONSULT_ACCOUNT_CLOSED'];
function failure(error: { message?: string } | null | undefined): ExpertConsultError {
  return new ExpertConsultError(known.find(code => error?.message?.includes(code)) ?? 'EXPERT_CONSULT_UNAVAILABLE');
}

export async function readExpertConsult(db: Rpc, profileId: string): Promise<ExpertConsultState> {
  const result = await db.rpc('expert_consult_state', { p_actor_id: uuid.parse(profileId) });
  if (result.error) throw failure(result.error);
  const parsed = stateSchema.safeParse(result.data);
  if (!parsed.success) throw failure(null);
  return parsed.data;
}

/**
 * Tells the Owner a new request arrived. The request itself is the durable record: an open, high-priority
 * '专家诊断预约' ticket in the admin ticket queue. PAY-NOTIFY's sender (#1031) is not on staging yet, so until
 * then the notice is a warn-level log, which the logger persists to application_logs (info is not kept);
 * once #1031 lands, send the e-mail here. Only the ticket id leaves the ticket — never the need or contact
 * details, which stay in the ticket and are erased with the account. Never fails the request.
 */
export type ExpertConsultNotifier = (request: { ticketId: string }) => Promise<void>;
export const notifyOwnerOfExpertConsult: ExpertConsultNotifier = async ({ ticketId }) => {
  logger.warn('api', 'expert_consult_requested', { ticketId });
};

export async function requestExpertConsult(db: Rpc, profileId: string, input: ExpertConsultInput,
  notify: ExpertConsultNotifier = notifyOwnerOfExpertConsult): Promise<ExpertConsultResult> {
  const { need, contact, source } = expertConsultInput.parse(input);
  const result = await db.rpc('expert_consult_request', {
    p_actor_id: uuid.parse(profileId), p_need: need, p_contact: contact, p_source: source,
  });
  if (result.error) throw failure(result.error);
  const parsed = resultSchema.safeParse(result.data);
  if (!parsed.success) throw failure(null);
  if (parsed.data.created) {
    await notify({ ticketId: parsed.data.ticketId }).catch(error => {
      logger.warn('api', 'expert_consult_notify_failed', { ticketId: parsed.data.ticketId,
        error: error instanceof Error ? error.name : 'unknown' });
    });
  }
  return parsed.data;
}
