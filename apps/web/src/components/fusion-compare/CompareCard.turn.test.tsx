/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ view: undefined as unknown }));
vi.mock('@/components/chat/MessageMarkdown', () => ({ MessageMarkdown: ({ text }: { text: string }) => <span>{text}</span> }));
vi.mock('@/trpc/client', () => {
  const mutation = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });
  return { trpc: { useUtils: () => ({ credits: {}, client: {} }), fusionCompare: {
    turnRead: { useQuery: () => ({ data: state.view, refetch: vi.fn() }) },
    turnAdopt: { useMutation: mutation } } } };
});
import { CompareCard } from './CompareCard';

const column = (n: number, over: Record<string, unknown> = {}) => ({ column: n, runId: String(n), modelId: `m${n}`, body: null,
  billing: { closed: false, state: 'held', reservedCredits: 5, chargedCredits: 0, netChargedCredits: 0 }, call: null, ...over });
const names = { m0: 'Sonnet', m1: 'GPT' };
const render = (view: unknown) => { state.view = view; return renderToStaticMarkup(<CompareCard compareId="c" names={names} onAdopted={() => {}} onQuote={() => {}} />); };

it('a running compare of the turn path says its columns are being written, offers no stop, and has no old route to read', () => {
  const html = render({ compareId: 'c', state: 'running', question: 'q', columns: [column(0), column(1)], adoption: null });
  expect(html).toContain('生成中');
  expect(html).not.toContain('停止');
  expect(html).not.toContain('排队中');
});

it('a finished compare shows each column\'s own charge, the total, the adopt button and still no stop', () => {
  const done = (n: number, credits: number) => column(n, { body: `answer ${n}`,
    billing: { closed: true, state: 'settled', reservedCredits: 5, chargedCredits: credits, netChargedCredits: credits },
    call: { callId: n + 1, state: 'ok', dispatched: true, settled: true, verdict: 'usable', inFlight: false } });
  const html = render({ compareId: 'c', state: 'finished', question: 'q', columns: [done(0, 2), done(1, 3)], adoption: null });
  expect(html).toContain('实际扣费 2 积分');
  expect(html).toContain('实际扣费 3 积分');
  expect(html).toContain('共扣 5 积分');
  expect(html).toContain('用这个回答继续');
  expect(html).not.toContain('停止');
  expect(html).not.toContain('手动停止');
});

it('an adopted column is marked', () => {
  const adopted = column(0, { body: 'a', billing: { closed: true, state: 'settled', reservedCredits: 5, chargedCredits: 1, netChargedCredits: 1 },
    call: { callId: 1, state: 'ok', dispatched: true, settled: true, verdict: 'usable', inFlight: false } });
  expect(render({ compareId: 'c', state: 'finished', question: 'q', columns: [adopted], adoption: { column: 0, seq: 1 } })).toContain('已用这个回答继续');
});
