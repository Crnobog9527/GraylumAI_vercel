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

const { AdminStaleRounds, compensationMessage, reviewCaution } = await import('./AdminStaleRounds');
const evidence = { model: 'anthropic/claude-sonnet-5.5', streamed: false, executionState: 'interrupted', unavailableReason: null,
  calls: 1, outputTokens: 46, savedReplyChars: 0, lastActivityAt: '2026-10-11T18:02:31Z', lastFinishReason: 'stop' };
const round = { kind: 'stale_charged_round', executionId: 'exec-1', runId: 'run-1', actorId: 'actor-1', userEmail: 'user@example.com',
  chargedCredits: 3, since: '2026-10-11T18:02:00Z', evidence };

describe('admin stale-round compensation section', () => {
  beforeEach(() => { state.mutate.mockReset(); });

  it('says when nothing needs handling', () => {
    state.list = { isLoading: false, error: null, data: { findings: [], total: 0, truncated: false } };
    const html = renderToStaticMarkup(<AdminStaleRounds />);
    expect(html).toContain('目前没有需要处理的回合');
    expect(html).toContain('超出内容容量（用户材料过长）的回合不应补偿');
  });

  it('lists each reported round with its charge and a confirm-first action, and notes a truncated page', () => {
    state.list = { isLoading: false, error: null, data: { findings: [round], total: 120, truncated: true } };
    const html = renderToStaticMarkup(<AdminStaleRounds />);
    expect(html).toContain('已扣 3 积分');
    // The operator can match the round to that user's feedback.
    expect(html).toContain('用户 user@example.com · 账号 actor-1');
    expect(html).toContain('run-1');
    expect(html).toContain('stale-round-compensate-run-1');
    expect(html).toContain('共 120 个回合');
    expect(html).toContain('anthropic/claude-sonnet-5.5');
    expect(html).toContain('模型输出 46 token');
    expect(html).toContain('已保存回复 0 字');
    expect(html).toContain('最后一次调用结束原因 stop');
    // The known limit is always in front of the operator (content beyond capacity is never refunded).
    expect(html).toContain('超出内容容量');
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
    [{ state: 'compensated', compensatedCredits: 3, auditRecorded: false }, '日志没有记录成功'],
    [{ state: 'already_compensated', compensatedCredits: 3 }, '没有重复退款'],
    [{ error: 'STALE_ROUND_NOT_ELIGIBLE' }, '没有退款'],
    [{ error: 'STALE_ROUND_NOT_FOUND' }, '找不到这一轮'],
    [{ error: 'INTERNAL_SERVER_ERROR' }, '结果未确认'],
  ] as const)('%j', (outcome, text) => {
    expect(compensationMessage(outcome)).toContain(text);
  });
});

describe('review caution', () => {
  it.each([
    [{ ...evidence }, null],
    [{ ...evidence, streamed: true, outputTokens: 0 }, null],
    [{ ...evidence, streamed: true, outputTokens: 120 }, '可能已看到部分回答'],
    [{ ...evidence, savedReplyChars: 300 }, '一般不应补偿'],
    [{ ...evidence, lastFinishReason: 'tool_calls' }, '也可能是用户材料超出容量'],
  ] as const)('%j', (facts, text) => {
    const caution = reviewCaution(facts);
    if (text === null) expect(caution).toBeNull(); else expect(caution).toContain(text);
  });
});
