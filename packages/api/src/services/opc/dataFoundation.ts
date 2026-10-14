/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { opcAdoptTopics, opcTopicDraft } from '../../shared/opcRequests';

const uuid = z.string().uuid();

// Origin text is loaded from the owned execution in SQL, never supplied by the client.
export const topicAdoptionWithSource = opcAdoptTopics.extend({
  sources: z.array(z.object({ itemId: uuid, executionId: uuid }).strict()).max(28).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.sources) return; // Old clients require unambiguous server-side source resolution.
  const items = new Set(value.body.map(item => item.id));
  const sources = new Set(value.sources.map(source => source.itemId));
  if (sources.size !== value.sources.length || sources.size !== items.size ||
      value.sources.some(source => !items.has(source.itemId))) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'OPC_TOPIC_SOURCE_INVALID' });
  }
});

// Explicit user actions only. The host must not classify conversation text by keywords.
export const contentReaction = z.object({
  requestId: uuid,
  executionId: uuid,
  action: z.enum(['rewrite', 'abandon']),
  reason: z.string().trim().max(1000).optional(),
}).strict();

// Topic brief (简报) adopted from an AI execution. The server checks `original` is a verbatim
// excerpt of that execution and records it beside the text the user actually saved.
export const briefAdoption = z.object({
  requestId: uuid,
  workItemId: uuid,
  expectedRevision: z.number().int().positive(),
  executionId: uuid,
  original: z.string().trim().min(1).max(20000),
  brief: z.string().trim().min(1).max(2000),
}).strict();

type ActorRpc<T> = (name: string, args: Record<string, unknown>) => Promise<T>;

// Reuse the OPC service authentication and bounded error mapping.
// The supplied RPC must authenticate the actor; SQL checks ownership and source visibility.
export function dataFoundationService<T>(rpc: ActorRpc<T>) {
  async function topicRpc(name: string, args: Record<string, unknown>) {
    try { return await rpc(name, args); }
    catch (error) {
      // Existing topic clients clear their frozen pending operation for this permanent refusal.
      if (error instanceof Error && ['OPC_DATA_SOURCE_DENIED', 'OPC_TOPIC_SOURCE_INVALID',
        'OPC_TOPIC_SOURCE_REQUIRED'].includes(error.message)) throw new Error('OPC_SOURCE_DENIED');
      throw error;
    }
  }
  return {
    topicDraft(value: unknown) {
      const v = opcTopicDraft.parse(value);
      return topicRpc('opc_topic_draft_from_execution', {
        p_draft_id: v.draftId,
        p_request_id: v.requestId,
        p_expected_version: v.expectedVersion,
        p_source_version_id: v.sourceVersionId,
        p_execution_id: v.executionId,
        p_body: v.body,
      });
    },
    adoptTopics(value: unknown) {
      const v = topicAdoptionWithSource.parse(value);
      return topicRpc('opc_adopt_topics_with_source', {
        p_draft_id: v.draftId,
        p_request_id: v.requestId,
        p_expected_version: v.expectedVersion,
        p_source_version_id: v.sourceVersionId,
        p_body: v.body,
        p_accounts: v.accounts,
        p_sources: v.sources ?? null,
        p_source_draft_version_id: v.sourceDraftVersionId ?? null,
      });
    },
    adoptBrief(value: unknown) {
      const v = briefAdoption.parse(value);
      return rpc('opc_brief_adoption', {
        p_request_id: v.requestId,
        p_work_item_id: v.workItemId,
        p_expected_revision: v.expectedRevision,
        p_execution_id: v.executionId,
        p_original: v.original,
        p_brief: v.brief,
      });
    },
    recordReaction(value: unknown) {
      const v = contentReaction.parse(value);
      return rpc('opc_content_reaction', {
        p_request_id: v.requestId,
        p_execution_id: v.executionId,
        p_action: v.action,
        p_reason: v.reason || null,
      });
    },
  };
}
