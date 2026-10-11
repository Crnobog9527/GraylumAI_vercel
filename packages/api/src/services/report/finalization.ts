/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isEmailVerified } from '../../lib/auth';

const uuid = z.string().uuid();
export const reportDocumentInput = z.object({ executionId: uuid }).strict();
export const reportEditInput = reportDocumentInput.extend({
  requestId: uuid,
  expectedRevision: z.number().int().nonnegative(),
  body: z.string().min(1).refine(body => [...body].length <= 12000),
}).strict();
export const reportFinalizeInput = reportDocumentInput.extend({
  requestId: uuid,
  expectedRevision: z.number().int().nonnegative(),
  expectedBodyHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const errors: Record<string, 'FORBIDDEN' | 'CONFLICT' | 'BAD_REQUEST'> = {
  REPORT_SOURCE_CONFLICT: 'CONFLICT',
  REPORT_CONFIRMATION_REQUIRED: 'CONFLICT',
  REPORT_EXECUTION_REQUIRED: 'BAD_REQUEST',
  REPORT_NOT_COMPLETE: 'BAD_REQUEST',
  REPORT_BODY_INVALID: 'BAD_REQUEST',
  REPORT_EVIDENCE_CAPACITY: 'BAD_REQUEST',
  REPORT_VERSION_CONFLICT: 'CONFLICT',
  REPORT_REQUEST_CONFLICT: 'CONFLICT',
  REPORT_ALREADY_FINALIZED: 'CONFLICT',
  REPORT_AUTH_REQUIRED: 'FORBIDDEN',
  CONTENT_ERASED: 'FORBIDDEN',
};

/** No model admission or billing: the database owns source, version and publish checks. */
export function reportFinalizationService(user: SupabaseClient, admin: SupabaseClient | null) {
  async function call(action: 'read' | 'save' | 'finalize', input: {
    executionId: string; requestId?: string; expectedRevision?: number;
    body?: string; expectedBodyHash?: string;
  }) {
    try {
      if (!admin) throw new Error('REPORT_UNAVAILABLE');
      const auth = await user.auth.getUser();
      if (auth.error || !auth.data.user || !isEmailVerified(auth.data.user)) throw new Error('REPORT_AUTH_REQUIRED');
      const { data, error } = await admin.rpc('report_document', {
        p_actor_id: auth.data.user.id,
        p_execution_id: input.executionId,
        p_action: action,
        p_request_id: input.requestId ?? null,
        p_expected_revision: input.expectedRevision ?? null,
        p_body: input.body ?? null,
        p_expected_body_hash: input.expectedBodyHash ?? null,
      }).abortSignal(AbortSignal.timeout(10000));
      if (error) throw error;
      return data as ReportDocument;
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
      throw new TRPCError({ code: errors[message] ?? 'SERVICE_UNAVAILABLE',
        message: errors[message] ? message : 'REPORT_UNAVAILABLE', cause: error });
    }
  }
  return {
    read: (value: unknown) => call('read', reportDocumentInput.parse(value)),
    save: (value: unknown) => call('save', reportEditInput.parse(value)),
    finalize: (value: unknown) => call('finalize', reportFinalizeInput.parse(value)),
  };
}

export type ReportDocument = {
  executionId: string;
  revision: number;
  body: string;
  bodyHash: string;
  manuallyEdited: boolean;
  completeness: string | null;
  candidate: boolean;
  finalized: boolean;
  versionId: string | null;
  version: number | null;
  next: { kind: 'first_week_topics'; draftId: string; sourceVersionId: string } | null;
};
