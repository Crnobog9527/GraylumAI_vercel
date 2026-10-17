/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isEmailVerified } from '../../lib/auth';
import { reportBodyText } from '../../shared/reportData';
import { reportStrategy, storedReportData, type ReportStrategy } from './strategy';

const uuid = z.string().uuid();
export const reportDocumentInput = z.object({ executionId: uuid }).strict();
export const reportEditInput = reportDocumentInput.extend({
  requestId: uuid,
  expectedRevision: z.number().int().nonnegative(),
  // The limit counts the report text only; the unchanged data block rides along (Owner's choice B, REPORT-VISUAL).
  body: z.string().min(1).max(120000).refine(body => [...reportBodyText(body)].length <= 12000),
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
  REPORT_DATA_INVALID: 'CONFLICT',
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
      const actorId = auth.data.user.id;
      const rpc = async (name: 'read' | 'save' | 'finalize', reportData: unknown = null) => {
        const { data, error } = await admin.rpc('report_document', {
          p_actor_id: actorId,
          p_execution_id: input.executionId,
          p_action: name,
          p_request_id: input.requestId ?? null,
          p_expected_revision: input.expectedRevision ?? null,
          p_body: input.body ?? null,
          p_expected_body_hash: input.expectedBodyHash ?? null,
          // Only a report with a data block sends one, so reports without it never depend on 0300's parameter.
          ...(reportData ? { p_report_data: reportData } : {}),
        }).abortSignal(AbortSignal.timeout(10000));
        if (error) throw error;
        return data as DocumentRow;
      };
      let reportData: unknown = null;
      if (action === 'finalize') {
        // The data is checked from the very body being finalized; the database refuses it for any other body.
        const current = await rpc('read');
        if (!current.finalized && current.bodyHash === input.expectedBodyHash)
          reportData = storedReportData(await reportStrategy(admin, actorId, input.executionId, current), current.bodyHash);
      }
      const doc = await rpc(action, reportData);
      return answer(doc, await reportStrategy(admin, actorId, input.executionId, doc));
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

type DocumentRow = Omit<ReportDocument, 'strategy'>;

/** Only the documented fields reach the page. */
function answer(doc: DocumentRow, strategy: ReportStrategy): ReportDocument {
  return { executionId: doc.executionId, revision: doc.revision, body: doc.body, bodyHash: doc.bodyHash,
    manuallyEdited: doc.manuallyEdited, completeness: doc.completeness, candidate: doc.candidate, finalized: doc.finalized,
    versionId: doc.versionId, version: doc.version, next: doc.next, strategy };
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
  /** REPORT-VISUAL: the checked strategy data (null without a data block). */
  strategy: ReportStrategy;
};
