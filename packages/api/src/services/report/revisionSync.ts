/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isEmailVerified } from '../../lib/auth';

/*
 * AGENT-CORE R14: sync an adopted review revision back to the confirmed fields (Master Plan 3.3).
 * The revision brings its own proposed field values; the host never derives them from the text,
 * so there is no model call and no charge here. The database owns every check (see 0223).
 */
const uuid = z.string().uuid();
const draft = z.object({ draftId: uuid });
/** stepId -> fieldId -> proposed value. Only fields the revision changes need to be present. */
const revisionFields = z.record(z.string().min(1).max(128), z.record(z.string().min(1).max(128), z.string().min(1).max(400)));
export const revisionProposeInput = draft.extend({
  requestId: uuid,
  sourceVersionId: uuid,
  body: z.string().min(1).refine(body => [...body].length <= 12000),
  fields: revisionFields,
}).strict();
export const revisionReadInput = draft.extend({ revisionId: uuid }).strict();
export const revisionLatestInput = draft.extend({ sourceVersionId: uuid }).strict();
export const revisionApplyInput = revisionReadInput.extend({
  requestId: uuid,
  expectedDiffHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const revisionDeclineInput = revisionReadInput.extend({ requestId: uuid }).strict();

const errors: Record<string, 'FORBIDDEN' | 'CONFLICT' | 'BAD_REQUEST'> = {
  REPORT_AUTH_REQUIRED: 'FORBIDDEN',
  REPORT_REVISION_DENIED: 'FORBIDDEN',
  CONTENT_ERASED: 'FORBIDDEN',
  REPORT_REVISION_UNSUPPORTED: 'BAD_REQUEST',
  REPORT_REVISION_INVALID: 'BAD_REQUEST',
  REPORT_REVISION_REQUIRED: 'BAD_REQUEST',
  REPORT_NOT_COMPLETE: 'BAD_REQUEST',
  REPORT_REVISION_STALE: 'CONFLICT',
  REPORT_REVISION_DECIDED: 'CONFLICT',
  REPORT_REQUEST_CONFLICT: 'CONFLICT',
  REPORT_SOURCE_CONFLICT: 'CONFLICT',
};

type Action = 'propose' | 'read' | 'latest' | 'apply' | 'decline';
type Call = {
  draftId: string; requestId?: string; revisionId?: string; sourceVersionId?: string;
  body?: string; fields?: Record<string, Record<string, string>>; expectedDiffHash?: string;
};

export function reportRevisionService(user: SupabaseClient, admin: SupabaseClient | null) {
  async function call(action: Action, input: Call) {
    try {
      if (!admin) throw new Error('REPORT_UNAVAILABLE');
      const auth = await user.auth.getUser();
      if (auth.error || !auth.data.user || !isEmailVerified(auth.data.user)) throw new Error('REPORT_AUTH_REQUIRED');
      const { data, error } = await admin.rpc('report_revision', {
        p_actor_id: auth.data.user.id,
        p_draft_id: input.draftId,
        p_action: action,
        p_request_id: input.requestId ?? null,
        p_revision_id: input.revisionId ?? null,
        p_source_version_id: input.sourceVersionId ?? null,
        p_body: input.body ?? null,
        p_fields: input.fields ?? null,
        p_expected_diff_hash: input.expectedDiffHash ?? null,
      }).abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      return data as ReportRevision | null;
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
      throw new TRPCError({ code: errors[message] ?? 'SERVICE_UNAVAILABLE',
        message: errors[message] ? message : 'REPORT_UNAVAILABLE', cause: error });
    }
  }
  return {
    propose: async (value: unknown) => (await call('propose', revisionProposeInput.parse(value)))!,
    read: async (value: unknown) => (await call('read', revisionReadInput.parse(value)))!,
    /** The latest revision proposed against a formal version, or null when there is none. */
    latest: (value: unknown) => call('latest', revisionLatestInput.parse(value)),
    apply: async (value: unknown) => (await call('apply', revisionApplyInput.parse(value)))!,
    decline: async (value: unknown) => (await call('decline', revisionDeclineInput.parse(value)))!,
  };
}

type FieldState = { value: string; status: string };
export type ReportRevisionDiff = {
  /** Fields whose value or status the revision changes. */
  changes: Array<{ stepId: string; stepTitle: string; fieldId: string; fieldTitle: string; before: FieldState; after: FieldState }>;
  /** Steps that depend on a changed step: confirmed together with it, values unchanged. A confirm UI must show them. */
  cascade: Array<{ stepId: string; stepTitle: string;
    fields: Array<{ fieldId: string; fieldTitle: string; before: FieldState; after: FieldState }> }>;
};
export type ReportRevision = {
  revisionId: string;
  draftId: string;
  sourceVersionId: string;
  body: string;
  bodyHash: string;
  diff: ReportRevisionDiff;
  diffHash: string;
  /** null while undecided. */
  decision: 'applied' | 'declined' | null;
  /** false: kept as report text only; topics and writing still use the original positioning. */
  fieldsSynced: boolean | null;
  versionId: string | null;
  version: number | null;
  next: { kind: 'first_week_topics'; draftId: string; sourceVersionId: string } | null;
};
