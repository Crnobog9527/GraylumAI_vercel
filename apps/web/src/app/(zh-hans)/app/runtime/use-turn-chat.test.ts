/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import type { ResearchCall } from '@/components/research/research-model';
import { withResearchRow } from './use-turn-chat';

const call = (state: ResearchCall['state'], credits: string | null = null): ResearchCall => ({ callId: 'c1', toolName: 'social_search', args: {},
  query: '早起', platform: 'douyin' as never, dataKind: 'keyword_posts', state, credits });

describe('research rows of a free chat turn', () => {
  it('one row per call: the end state replaces the running row, with the settled credits', () => {
    const running = withResearchRow([], call('running'));
    expect(running).toHaveLength(1);
    expect(running[0]).toMatchObject({ id: 'c1', kind: 'research', state: 'running' });
    const done = withResearchRow(running, call('succeeded', '0.30'));
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ state: 'done', credits: '0.3 积分' });
    expect(withResearchRow(done, { ...call('running'), callId: 'c2' })).toHaveLength(2);
  });
});
