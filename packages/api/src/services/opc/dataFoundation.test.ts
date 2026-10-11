/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { contentReaction, dataFoundationService, topicAdoptionWithSource } from './dataFoundation';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = { id: id(5), platform: 'x', account: 'main', title: '采用的标题', brief: '用户修改后的摘要', day: '2026-10-10' };
const base = { draftId: id(1), requestId: id(2), expectedVersion: 0, sourceVersionId: id(3), body: [item] };
const adoption = { ...base, accounts: [{ platform: 'x', account: 'main', expectedRevision: null }] };
describe('R9 data foundation contracts', () => {
  it('preserves the execution identity when saving a topic draft', async () => {
    const rpc = vi.fn().mockResolvedValue({ version: 1 });
    await dataFoundationService(rpc).topicDraft({ ...base, executionId: id(4) });
    expect(rpc).toHaveBeenCalledWith('opc_topic_draft_from_execution', expect.objectContaining({
      p_execution_id: id(4), p_request_id: id(2), p_body: [item],
    }));
  });
  it('does not accept a client-supplied actor or AI original text', () => {
    const rpc = vi.fn();
    for (const extra of [{ actorId: id(9) }, { originalProposal: 'forged' }]) {
      expect(() => dataFoundationService(rpc).adoptTopics({ ...adoption, ...extra })).toThrow();
    }
    expect(rpc).not.toHaveBeenCalled();
  });
  it('keeps exact per-item source bindings and adopted text separate', async () => {
    const rpc = vi.fn().mockResolvedValue({});
    const sources = [{ itemId: item.id, executionId: id(4) }];
    await dataFoundationService(rpc).adoptTopics({ ...adoption, sources });
    expect(rpc).toHaveBeenCalledWith('opc_adopt_topics_with_source', expect.objectContaining({
      p_sources: sources, p_body: [item],
    }));
  });
  it('requires explicit bindings to cover each adopted item exactly once', () => {
    for (const sources of [[], [{ itemId: id(8), executionId: id(4) }],
      [{ itemId: item.id, executionId: id(4) }, { itemId: item.id, executionId: id(7) }]]) {
      expect(topicAdoptionWithSource.safeParse({ ...adoption, sources }).success).toBe(false);
    }
  });
  it('sends legacy source resolution to SQL without guessing an execution', async () => {
    const rpc = vi.fn().mockResolvedValue({});
    await dataFoundationService(rpc).adoptTopics(adoption);
    expect(rpc).toHaveBeenCalledWith('opc_adopt_topics_with_source', expect.objectContaining({ p_sources: null }));
  });
  it.each(['rewrite', 'abandon'] as const)('records the explicit %s action with a stable request identity', async action => {
    const rpc = vi.fn().mockResolvedValue({ recorded: true });
    await dataFoundationService(rpc).recordReaction({ requestId: id(2), executionId: id(4), action, reason: '  原因  ' });
    expect(rpc).toHaveBeenCalledWith('opc_content_reaction', {
      p_request_id: id(2), p_execution_id: id(4), p_action: action, p_reason: '原因',
    });
  });
  it('rejects unsupported implicit feedback and oversized reasons', () => {
    const event = { requestId: id(2), executionId: id(4), action: 'rewrite' };
    expect(contentReaction.safeParse({ ...event, action: 'not_useful' }).success).toBe(false);
    expect(contentReaction.safeParse({ ...event, reason: 'a'.repeat(1001) }).success).toBe(false);
  });
  it('propagates ownership, deletion and replay conflicts instead of reporting success', async () => {
    const rpc = vi.fn().mockRejectedValue(new Error('CONTENT_ERASED'));
    await expect(dataFoundationService(rpc).recordReaction({
      requestId: id(2), executionId: id(4), action: 'abandon',
    })).rejects.toThrow('CONTENT_ERASED');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
