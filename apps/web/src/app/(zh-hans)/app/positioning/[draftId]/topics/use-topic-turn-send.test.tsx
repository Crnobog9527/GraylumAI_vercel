/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The sidebar balance moves when a topic turn settles (opening, chat, adoption turns alike): the hook's send must say so.
const h = vi.hoisted(() => ({ invalidate: vi.fn(), runTurn: vi.fn(), readTurnView: vi.fn() }));
vi.mock('@/trpc/client', () => ({ trpc: { useUtils: () => ({ credits: { getBalance: { invalidate: h.invalidate } } }) } }));
vi.mock('@/lib/turn-stream', () => ({ runTurn: h.runTurn }));
vi.mock('../mentor-turn-path', () => ({ readTurnView: h.readTurnView }));

const request = { draftId: '00000000-0000-4000-8000-000000000001', requestId: '00000000-0000-4000-8000-000000000002', input: 'topics' };

async function sendOnce() {
  const { useTopicTurnPath } = await import('./use-topic-turn-path');
  let send: ((r: typeof request) => Promise<unknown>) | undefined;
  function Probe() { send = useTopicTurnPath('00000000-0000-4000-8000-000000000003').send; return null; }
  renderToStaticMarkup(<Probe />);
  return send!(request);
}

describe('a topic turn that settles refreshes the sidebar balance', () => {
  it('after a finished turn', async () => {
    h.invalidate.mockReset(); h.readTurnView.mockResolvedValue({ activeTurn: null, lastTurn: null, calls: [], messages: [] });
    h.runTurn.mockResolvedValue({ state: 'finished', last: { type: 'result', turnId: 9 } });
    await sendOnce();
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });
  it('after a failed turn too (a refused turn can still have moved the balance)', async () => {
    h.invalidate.mockReset(); h.readTurnView.mockResolvedValue({ activeTurn: null, lastTurn: null, calls: [], messages: [] });
    h.runTurn.mockResolvedValue({ state: 'finished', last: { type: 'error', code: 'TURN_FAILED' } });
    await sendOnce();
    expect(h.invalidate).toHaveBeenCalledTimes(1);
  });
});
