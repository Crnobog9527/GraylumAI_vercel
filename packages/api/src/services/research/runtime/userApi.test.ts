/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import {
  confirmResearchCard, createResearchRefresh, researchBenchmarks, researchCards, researchEvidence, researchToolCharges,
} from './userApi';
const actor = '00000000-0000-4000-8000-000000000001';
const id = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const db = (data: unknown, error: unknown = null) => ({ rpc: vi.fn().mockResolvedValue({ data, error }) });

describe('research user API', () => {
  it('binds confirmation to the authenticated actor and strips unexpected output fields', async () => {
    const client = db({ cardId: id, confirmationId: other, kind: 'keywords', items: ['猫'], secret: 'hidden' });
    expect(await confirmResearchCard(client, actor, { cardId: id, selected: ['a'], additions: ['猫'] }))
      .toEqual({ cardId: id, confirmationId: other, kind: 'keywords', items: ['猫'] });
    expect(client.rpc).toHaveBeenCalledWith('research_card_confirm', {
      a: actor, p_card: id, p: { selected: ['a'], additions: ['猫'] },
    });
  });
  it.each([21, 40])('reads and confirms keywords with %i Unicode code points', async length => {
    const text = '🐈'.repeat(length);
    const client = db([{ cardId: id, kind: 'keywords', options: [{ id: 'a', text }],
      minSelect: 1, maxSelect: 5, confirmationId: other, items: [text] }]);
    const cards = await researchCards(client, actor, id);
    expect(cards.items[0].options).toEqual([{ id: 'a', text }]);
    expect(cards.items[0].items).toEqual([text]);
    client.rpc.mockResolvedValue({ data: { cardId: id, confirmationId: other, kind: 'keywords', items: [text] }, error: null });
    for (const submission of [{ selected: ['a'], edits: { a: text } }, { selected: [], additions: [text] }]) {
      const confirmation = await confirmResearchCard(client, actor, { cardId: id, ...submission });
      expect(confirmation.items).toEqual([text]);
      expect(client.rpc).toHaveBeenLastCalledWith('research_card_confirm', {
        a: actor, p_card: id, p: submission,
      });
    }
  });
  it.each(['🐈'.repeat(41), '猫\u0000', '   '])('rejects invalid keyword input and persisted output: %j', async text => {
    const client = db(null);
    for (const submission of [{ edits: { a: text } }, { additions: [text] }]) {
      await expect(confirmResearchCard(client, actor, { cardId: id, selected: ['a'], ...submission })).rejects.toThrow();
    }
    expect(client.rpc).not.toHaveBeenCalled();
    client.rpc.mockResolvedValue({ data: [{ cardId: id, kind: 'keywords', options: [{ id: 'a', text }],
      minSelect: 1, maxSelect: 5, confirmationId: null, items: null }], error: null });
    await expect(researchCards(client, actor, id)).rejects.toMatchObject({ message: 'RESEARCH_UNAVAILABLE' });
    client.rpc.mockResolvedValue({ data: { cardId: id, confirmationId: other, kind: 'keywords', items: [text] }, error: null });
    await expect(confirmResearchCard(client, actor, { cardId: id, selected: ['a'] }))
      .rejects.toMatchObject({ message: 'RESEARCH_UNAVAILABLE' });
  });
  it('rejects malformed confirmations before sending anything', async () => {
    const client = db(null);
    await expect(confirmResearchCard(client, actor, { cardId: id, selected: ['bad id'] })).rejects.toThrow();
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it('creates a refresh grant with session/account scope', async () => {
    const client = db(other);
    expect(await createResearchRefresh(client, actor, { sessionId: id, platform: 'douyin', account: 'alice' }))
      .toEqual({ refreshId: other });
    expect(client.rpc).toHaveBeenCalledWith('research_refresh_create', {
      a: actor, s: id, p_platform: 'douyin', p_account: 'alice',
    });
  });
  it.each(['RESEARCH_SCOPE_DENIED', 'RESEARCH_CARD_INVALID', 'RESEARCH_CARD_ALREADY_CONFIRMED', 'RESEARCH_REFRESH_INVALID'])(
    'preserves only stable error %s (including ownership/deletion denial)', async message => {
      await expect(createResearchRefresh(db(null, { message }), actor, { sessionId: id, platform: 'x', account: 'a' }))
        .rejects.toMatchObject({ message });
    },
  );
  it('never exposes raw RPC or transport errors', async () => {
    const input = { sessionId: id, platform: 'x', account: 'a' };
    await expect(createResearchRefresh(db(null, { message: 'secret=123 RESEARCH_SCOPE_DENIED' }), actor, input))
      .rejects.toMatchObject({ message: 'RESEARCH_UNAVAILABLE' });
    const client = { rpc: vi.fn().mockRejectedValue(new Error('raw token')) };
    await expect(createResearchRefresh(client, actor, input)).rejects.toMatchObject({ message: 'RESEARCH_UNAVAILABLE' });
    await expect(createResearchRefresh(null, actor, input)).rejects.toMatchObject({ message: 'RESEARCH_UNAVAILABLE' });
  });
  it('projects user settlement only and preserves decimal precision', async () => {
    const client = db([{ callId: id, toolName: 'web_search', args: { query: 'cats' },
      source: 'tool_usage', credits: '0.123456789012345678', vendor: 'private', supplierCost: '99' }]);
    expect(await researchToolCharges(client, actor, other)).toEqual({ items: [{ callId: id,
      toolName: 'web_search', args: { query: 'cats' }, query: null, platform: null, dataKind: null,
      source: 'tool_usage', credits: '0.123456789012345678' }] });
    expect(client.rpc).toHaveBeenCalledWith('research_user_tool_charges', { a: actor, p_transaction: other });
  });
  it('does not fabricate old metadata or leak extra args', async () => {
    const client = db([{ callId: id, toolName: null, args: null, source: null, credits: null },
      { callId: other, toolName: 'web_search', args: { query: 'cats', vendor: 'private' }, source: 'tool_unknown', credits: '0' }]);
    const result = await researchToolCharges(client, actor, id);
    expect(result.items[0]).toEqual({ callId: id, toolName: null, args: null, query: null, platform: null, dataKind: null,
      source: null, credits: null });
    expect(result.items[1].args).toBeNull();
  });
  it('RT-3b PR-2: returns each subcall\'s own query, platform and dataKind; unknown values become null', async () => {
    const charges = db([
      { callId: id, toolName: 'benchmark_fetch', args: null, query: 'alice', platform: 'tiktok', dataKind: 'account_posts',
        source: 'tool_usage', credits: '1' },
      { callId: other, toolName: 'web_search', args: null, query: 'x'.repeat(5000), platform: 'myspace', dataKind: 'dump',
        source: 'tool_usage', credits: '1' }]);
    const items = (await researchToolCharges(charges, actor, id)).items;
    expect(items[0]).toMatchObject({ query: 'alice', platform: 'tiktok', dataKind: 'account_posts' });
    expect(items[1]).toMatchObject({ query: null, platform: null, dataKind: null });
    const row = { operationId: id, toolName: 'web_fetch', args: { url: 'https://example.com' }, state: 'succeeded',
      query: 'https://example.com', platform: 'web', dataKind: 'web_fetch', fetchedAt: null, itemCount: 1, truncated: false,
      sources: [], sessionId: other, sessionTitle: null, createdAt: '2026-10-15T00:00:00Z' };
    const evidence = await researchEvidence(db([row]), actor, { limit: 20 });
    expect(evidence.items[0]).toMatchObject({ query: 'https://example.com', platform: 'web', dataKind: 'web_fetch' });
  });
  it('paginates by time plus id and filters unsafe public links', async () => {
    const row = { operationId: id, toolName: 'web_search', args: { query: 'cats' }, state: 'succeeded',
      fetchedAt: '2026-10-15T00:00:00Z', itemCount: 2, truncated: true,
      sources: ['https://example.com/cats', 'javascript:alert(1)', 'http://127.0.0.1/secret'],
      sessionId: other, sessionTitle: 'Cats', createdAt: '2026-10-15T00:00:00Z', vendor: 'private' };
    const client = db([row, { ...row, operationId: other }]);
    const cursor = { createdAt: '2026-10-16T00:00:00Z', operationId: other };
    const result = await researchEvidence(client, actor, { limit: 1, cursor });
    expect(result.hasNextPage).toBe(true);
    expect(result.nextCursor).toEqual({ createdAt: row.createdAt, operationId: id });
    expect(result.items[0].sources).toEqual(['https://example.com/cats']);
    expect(result.items[0]).not.toHaveProperty('vendor');
    expect(client.rpc).toHaveBeenCalledWith('research_user_evidence', {
      a: actor, p_limit: 2, p_cursor_time: cursor.createdAt, p_cursor_id: other,
    });
  });
  it('reads cards for reconnect without exposing private fields', async () => {
    const client = db([{ cardId: id, kind: 'keywords', options: [{ id: 'a', text: '猫', secret: 'hidden' }],
      minSelect: 1, maxSelect: 5, confirmationId: null, items: null, actor_id: actor }]);
    const result = await researchCards(client, actor, other);
    expect(result.items[0]).not.toHaveProperty('actor_id');
    expect(result.items[0].options[0]).not.toHaveProperty('secret');
    expect(client.rpc).toHaveBeenCalledWith('research_user_cards', { a: actor, s: other });
  });
  it('denies foreign transactions and malformed server responses', async () => {
    await expect(researchToolCharges(db(null, { message: 'RESEARCH_SCOPE_DENIED' }), actor, other))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(researchToolCharges(db([{ provider: 'private' }]), actor, other))
      .rejects.toMatchObject({ message: 'RESEARCH_UNAVAILABLE' });
  });
  it('reads the session benchmark table with its evidence refs, keeping missing numbers null', async () => {
    const ref = (n: number) => `${id}#${n}`;
    const row = { platform: 'douyin', account: 'alpha', followers: 38200, medianViews: null, engagementRate: 0.0634,
      postsPerWeek: 4.2, lastPublishedAt: '2026-10-13T10:00:00+00:00', postsAnalyzed: 24, category: 'imitable',
      qualified: true, excluded: null, fetchedAt: '2026-10-15T08:00:00+00:00', cost: 9,
      refs: { followers: [ref(1)], medianViews: [], engagementRate: [ref(1), ref(2)], postsPerWeek: [ref(1)],
        lastPublishedAt: [ref(2)] } };
    const client = db([row]);
    const result = await researchBenchmarks(client, actor, other);
    expect(client.rpc).toHaveBeenCalledWith('research_user_benchmarks', { a: actor, s: other });
    const expected: Partial<typeof row> = { ...row };
    delete expected.cost;
    expect(result.items).toEqual([expected]);
    expect(result.items[0]!.medianViews).toBeNull();
    expect(result.items[0]!.refs.medianViews).toEqual([]);
  });
  it('denies another user\'s session benchmark table and rejects malformed rows', async () => {
    await expect(researchBenchmarks(db(null, { message: 'RESEARCH_SCOPE_DENIED' }), actor, other))
      .rejects.toMatchObject({ code: 'FORBIDDEN', message: 'RESEARCH_SCOPE_DENIED' });
    await expect(researchBenchmarks(db([{ platform: 'douyin', account: 'a', followers: -1 }]), actor, other))
      .rejects.toMatchObject({ message: 'RESEARCH_UNAVAILABLE' });
    const bad = { platform: 'douyin', account: 'a', followers: 1, medianViews: null, engagementRate: null, postsPerWeek: null,
      lastPublishedAt: null, postsAnalyzed: 0, category: null, qualified: false, excluded: 'NO_POSTS', fetchedAt: 'x',
      refs: { followers: ['not-a-ref'], medianViews: [], engagementRate: [], postsPerWeek: [], lastPublishedAt: [] } };
    await expect(researchBenchmarks(db([bad]), actor, other)).rejects.toMatchObject({ message: 'RESEARCH_UNAVAILABLE' });
    await expect(researchBenchmarks(db(null), actor, 'not-a-uuid')).rejects.toThrow();
  });
});
