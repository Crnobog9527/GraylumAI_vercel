/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ list: {} as Record<string, unknown>, mutate: vi.fn() }));
vi.mock('@/trpc/client', () => ({ trpc: {
  useUtils: () => ({ adminStaleRounds: { list: { invalidate: vi.fn() } } }),
  adminStaleRounds: {
    list: { useQuery: () => state.list },
    compensate: { useMutation: () => ({ mutate: state.mutate, isPending: false }) },
  },
} }));

const { AdminStaleRounds, compensationMessage } = await import('./AdminStaleRounds');
const round = { kind: 'stale_charged_round', executionId: 'exec-1', runId: 'run-1', chargedCredits: 3, since: '2026-10-11T18:02:00Z' };

describe('admin stale-round compensation section', () => {
  beforeEach(() => { state.mutate.mockReset(); });

  it('says when nothing needs handling', () => {
    state.list = { isLoading: false, error: null, data: { findings: [], total: 0, truncated: false } };
    expect(renderToStaticMarkup(<AdminStaleRounds />)).toContain('目前没有需要处理的回合');
  });

  it('lists each reported round with its charge and a confirm-first action, and notes a truncated page', () => {
    state.list = { isLoading: false, error: null, data: { findings: [round], total: 120, truncated: true } };
    const html = renderToStaticMarkup(<AdminStaleRounds />);
    expect(html).toContain('已扣 3 积分');
    expect(html).toContain('run-1');
    expect(html).toContain('stale-round-compensate-run-1');
    expect(html).toContain('共 120 个回合');
    expect(state.mutate).not.toHaveBeenCalled();
  });

  it('shows a read failure instead of an empty list', () => {
    state.list = { isLoading: false, error: { message: 'STALE_ROUND_SCAN_FAILED' }, data: undefined };
    const html = renderToStaticMarkup(<AdminStaleRounds />);
    expect(html).toContain('读取失败');
    expect(html).not.toContain('目前没有需要处理的回合');
  });
});

describe('compensation outcome wording', () => {
  it.each([
    [{ state: 'compensated', compensatedCredits: 3 }, '已补偿 3 积分'],
    [{ state: 'already_compensated', compensatedCredits: 3 }, '没有重复退款'],
    [{ error: 'STALE_ROUND_NOT_ELIGIBLE' }, '没有退款'],
    [{ error: 'STALE_ROUND_NOT_FOUND' }, '找不到这一轮'],
    [{ error: 'INTERNAL_SERVER_ERROR' }, '结果未确认'],
  ] as const)('%j', (outcome, text) => {
    expect(compensationMessage(outcome)).toContain(text);
  });
});
