/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const state = { overview: undefined as unknown, error: null as unknown };
  const query = (data: () => unknown, error: () => unknown = () => null) => ({
    useQuery: () => ({ data: data(), error: error(), refetch: () => undefined }),
  });
  const mutation = { useMutation: () => ({ mutateAsync: async () => undefined, isPending: false }) };
  return { state, query, mutation };
});
vi.mock('@/trpc/client', () => ({
  trpc: { founder: { admin: {
    overview: h.query(() => h.state.overview, () => h.state.error), livestreams: h.query(() => []),
    markCommunity: h.mutation, reviewWall: h.mutation, setCommunityEntry: h.mutation, recordLivestream: h.mutation,
  } } },
}));

import { FounderAdmin } from './FounderAdmin';
import { communityText, founderAdminError, pendingRemovalRows, stateText, wallQueue, type FounderOverviewRow } from './founderAdminView';

const row = (over: Partial<FounderOverviewRow> & { state?: FounderOverviewRow['founder']['state'] }): FounderOverviewRow => ({
  userId: '00000000-0000-4000-8000-0000000000aa', email: 'f@example.test', foundedAt: '2026-10-01T00:00:00Z', accountOpen: true,
  founder: { state: over.state ?? 'active', periodEnd: null, deadline: null, endedAt: null, endedReason: null },
  community: { joinedAt: null, removedAt: null }, pendingRemoval: false, wall: null, ...over,
});

describe('founder admin view helpers', () => {
  it('lists only ended, joined, not-removed members as pending removal; frozen never', () => {
    const ended = row({ state: 'ended', pendingRemoval: true });
    const frozen = row({ state: 'frozen', pendingRemoval: true });
    expect(pendingRemovalRows([ended, frozen, row({ state: 'active' })])).toEqual([ended]);
  });
  it('labels state, community and errors in plain words', () => {
    const ended = row({ state: 'ended' });
    ended.founder.endedReason = 'refunded';
    expect(stateText(ended)).toBe('已结束（已退款）');
    expect(stateText(row({ state: 'frozen' }))).toContain('临时');
    expect(communityText(row({ community: { joinedAt: '2026-10-02T00:00:00Z', removedAt: null } }))).toBe('已入群（2026-10-02）');
    expect(founderAdminError({ message: 'FOUNDER_WALL_ENTRY_CHANGED' }, 'save')).toContain('重新审核');
    expect(founderAdminError(null, 'read')).toContain('暂时无法读取');
  });
  it('queues only consented pending cards', () => {
    const wall = { displayName: 'a', socialAccounts: [], productName: null, productUrl: null, intro: null,
      reviewState: 'pending' as const, updatedAt: 't', consented: true, listed: false };
    expect(wallQueue([row({ wall }), row({ wall: { ...wall, consented: false } }), row({})])).toHaveLength(1);
  });
});

describe('FounderAdmin', () => {
  it('renders empty states and the member list', () => {
    h.state.overview = [];
    const empty = renderToStaticMarkup(createElement(FounderAdmin));
    expect(empty).toContain('还没有创始会员');
    expect(empty).toContain('目前没有需要移出的人');
    expect(empty).toContain('还没有会员提交展示卡');
    h.state.overview = [row({ community: { joinedAt: '2026-10-02T00:00:00Z', removedAt: null } })];
    const full = renderToStaticMarkup(createElement(FounderAdmin));
    expect(full).toContain('f@example.test');
    expect(full).toContain('标记已移出');
  });
  it('shows a read error with retry', () => {
    h.state.overview = undefined;
    h.state.error = { message: 'x' };
    expect(renderToStaticMarkup(createElement(FounderAdmin))).toContain('暂时无法读取创始会员数据');
  });
});
