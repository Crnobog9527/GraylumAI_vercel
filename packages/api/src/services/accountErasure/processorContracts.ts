/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

export const count = z.number().int().nonnegative().safe();
export const stageSchema = z.enum(['closed', 'erasing', 'billing_pending', 'completed']);
export const workSchema = z.object({
  requestId: z.string().uuid(), stage: stageSchema, runs: z.array(z.string().uuid()).max(20),
  nextRunId: z.string().uuid().nullable(), financialPending: count, manualReview: count,
}).strict();
export const batchSchema = z.object({
  processed: count, remaining: count, manualReview: count.optional(), nextRowId: z.string().uuid().nullable().optional(),
  reason: z.enum(['call_set_open', 'billing_pending', 'content_pending', 'binding_busy', 'no_runtime_binding']).optional(),
}).strict();
export const detachSchema = z.union([batchSchema, z.object({ detached: z.literal(true) }).strict()]);
export const financialSchema = z.object({
  id: z.string().uuid(), state: z.enum(['prepared', 'dispatched', 'unknown', 'cost_pending', 'settled', 'refunded']),
  executionId: z.string().uuid().nullable().optional(),
});
export const recoverySchema = z.object({
  executionId: z.string().uuid(), runId: z.string().uuid(),
  state: z.enum(['prepared', 'running', 'interrupted', 'waiting_credits', 'cost_pending', 'completed', 'cancelled']),
});
export const localSchema = z.object({
  remaining: count, manualReview: count, errors: z.array(z.string().regex(/^[A-Z0-9_]{1,64}$/)).max(100),
}).strict();
export const storageSchema = z.object({ complete: z.boolean(), remaining: count, manualReview: count }).strict();
export const storageReadySchema = z.object({ ready: z.boolean() }).strict();
export const beginSchema = z.object({
  ready: z.boolean(), alreadyDeleted: z.boolean(), started: z.boolean(), claimed: z.boolean(), requestId: z.string().uuid(),
}).strict();
export const resultSchema = z.object({ stage: stageSchema }).strict();

/** B1 returns table counts, or a transaction-barrier refusal; neither an empty object nor unknown keys prove cleanup. */
export function contentRemaining(value: unknown): { remaining: number; retry: boolean } {
  const object = z.record(z.string(), z.unknown()).parse(value);
  if (object.retry === true) {
    z.object({ retry: z.literal(true), reason: z.literal('transactions_pending') }).strict().parse(object);
    return { remaining: 1, retry: true };
  }
  const tables = new Set([
    'runtime_executions', 'runtime_history_dependencies', 'runtime_session_batches', 'runtime_session_history',
    'runtime_tool_calls', 'runtime_scope_material', 'runtime_sessions', 'ordinary_chat_requests', 'messages',
    'conversation_context_snapshots', 'conversations', 'artifact_chat_turns', 'artifact_chat_summaries',
    'artifact_generations', 'artifact_rounds', 'artifact_evidence', 'artifact_confirmations', 'artifact_candidates',
    'artifact_versions', 'artifact_requests', 'artifact_work_references', 'artifact_evidence_restrictions',
    'agent_slice_calls', 'agent_slice_links', 'agent_slice_executions', 'artifact_projects', 'research_operations', 'research_plans',
    'opc_turns', 'opc_plans', 'opc_items', 'opc_item_edits', 'opc_handoffs', 'opc_topic_openings',
    'opc_topic_workspaces', 'opc_topic_draft_versions', 'opc_library_requests', 'opc_content_versions',
    'opc_accounts', 'opc_businesses', 'opc_work_ui_deleted', 'opc_account_ui_deleted', 'opc_publication_ui_deleted',
    'agent_confirmed_preferences_deleted', 'agent_preference_requests_deleted', 'artifact_accounts_deleted',
  ]);
  const keys = Object.keys(object);
  if (!keys.length) throw new Error('ERASURE_INVALID_RESULT');
  let remaining = 0;
  for (const key of keys) {
    const table = key.endsWith('_skipped') ? key.slice(0, -8) : key;
    if (!tables.has(table)) throw new Error('ERASURE_INVALID_RESULT');
    const amount = count.parse(object[key]);
    if (key.endsWith('_skipped')) remaining += amount;
  }
  return { remaining, retry: remaining > 0 };
}
