/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import type { AgentInputItem, Session } from '@openai/agents';
import { NativeSession } from './nativeSession';
import { jsonbBytes, RESULT_BYTE_LIMIT } from './resultCapacity';
function fixture() {
  const saved: AgentInputItem[][] = [];
  const inner: Session = { getSessionId: async () => 'synthetic', getItems: async () => [],
    addItems: async items => { saved.push(items); }, popItem: async () => undefined, clearSession: async () => {} };
  return { saved, inner, session: new NativeSession(inner) };
}
it('buffers primary writes and synchronizes final plain and T2 bodies', async () => {
  for (const agentTurn of [true, false]) {
    const f = fixture();
    await f.session.addItems([{ role: 'user', content: 'question' },
      { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'long original' }] }]);
    expect(f.saved).toEqual([]);
    const body = agentTurn ? JSON.stringify({ message: 'saved', card: null }) : '{"message":"saved","done":true}';
    await f.session.finish(body, agentTurn);
    expect(f.saved[0]?.[1]).toEqual({ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: agentTurn ? 'saved' : body }] });
    await f.session.finish('ignored after commit', agentTurn);
    expect(f.saved).toHaveLength(1);
    await f.session.addItems([{ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'organizer' }] }]);
    expect(f.saved).toHaveLength(2);
  }
});
it('synchronizes card arguments and result and bounds companion prose without splitting pairs', async () => {
  const f = fixture();
  const card = { message: 'saved prefix', question: 'Q', options: ['A', 'B'], recommended: 0, recommendationReason: 'saved reason' };
  await f.session.addItems([
    { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'x'.repeat(3999) + '😀tail' }] },
    { type: 'function_call', callId: 'call', name: 'ask_question', arguments: '{"message":"original"}' },
    { type: 'function_call_result', status: 'completed', callId: 'call', name: 'ask_question', output: { type: 'text', text: '{"card":"question","message":"original"}' } },
  ]);
  await f.session.finish(JSON.stringify({ message: card.message, card }), true);
  expect(f.saved[0]?.[0]).toMatchObject({ content: [{ text: 'x'.repeat(3999) }] });
  expect(f.saved[0]?.[1]).toMatchObject({ arguments: JSON.stringify(card) });
  expect(f.saved[0]?.[2]).toMatchObject({ output: { text: JSON.stringify({ card: 'question', ...card }) } });
  for (const item of f.saved.flat()) expect(jsonbBytes(item)).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
});
it('drops oversized card companion and organizer prose but rejects oversized input', async () => {
  const f = fixture();
  await f.session.addItems([{ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'text',
    providerData: { data: 'x'.repeat(300000) } }] }]);
  await f.session.finish(JSON.stringify({ message: 'saved', card: { message: 'saved' } }), true);
  expect(f.saved).toEqual([[]]);
  await f.session.addItems([{ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'x'.repeat(300000) }] }]);
  expect(f.saved).toEqual([[], []]);
  await expect(f.session.addItems([{ role: 'user', content: 'x'.repeat(300000) }])).rejects.toThrow('RUNTIME_SESSION_CAPACITY');
});
it('retries a lost append acknowledgement with the exact projection', async () => {
  const f = fixture();
  let lost = true;
  f.inner.addItems = async items => {
    f.saved.push(items);
    if (lost) { lost = false; throw new Error('lost'); }
  };
  await f.session.addItems([{ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'original' }] }]);
  await expect(f.session.finish('saved', false)).rejects.toThrow('lost');
  await f.session.finish('changed after lost response', false);
  expect(f.saved[1]).toEqual(f.saved[0]);
});
