/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import type { AgentInputItem, Session } from '@openai/agents';
import { recoverOpenRouterHistory } from './historyRecovery';
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


it.each([false, true])('preserves valid SDK tool-call history copies (rewrite=%s)', async rewrite => {
  const f = fixture();
  const originalCard = { message: 'long original message', question: 'Q', options: ['A', 'B'],
    recommended: 0, recommendationReason: 'long original reason' };
  // Whitespace deliberately differs from JSON.stringify to prove untouched call bytes stay untouched.
  const arguments_ = JSON.stringify(originalCard, null, 1);
  const call = { id: 'call', type: 'function', function: { name: 'ask_question', arguments: arguments_ } };
  const history: AgentInputItem[] = [
    { role: 'user', content: 'Latest user turn' },
    { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Companion prose',
      providerData: { role: 'assistant', refusal: null, tool_calls: [call] } }] },
    { type: 'function_call', callId: 'call', name: 'ask_question', arguments: arguments_, providerData: call },
    { type: 'function_call_result', callId: 'call', name: 'ask_question', status: 'completed',
      output: { type: 'text', text: JSON.stringify({ card: 'question', ...originalCard }) } },
  ];
  const receiptBytes = JSON.stringify(history);
  expect(recoverOpenRouterHistory(history, new Set(['ask_question']))).toEqual(history);
  await f.session.addItems(history);
  const card = rewrite ? { ...originalCard, message: 'long', recommendationReason: 'long' } : originalCard;
  await f.session.finish(JSON.stringify({ message: card.message, card }), true, rewrite);
  const stored = f.saved.flat();
  expect(recoverOpenRouterHistory(stored, new Set(['ask_question']))).toEqual(stored);
  expect(JSON.stringify(history)).toBe(receiptBytes);
  if (!rewrite) expect(JSON.stringify(stored)).toBe(receiptBytes);
  else {
    const args = JSON.stringify(card);
    expect(stored[1]).toMatchObject({ content: [{ providerData: { tool_calls: [
      { id: 'call', function: { name: 'ask_question', arguments: args } },
    ] } }] });
    expect(stored[2]).toMatchObject({ arguments: args, providerData: { function: { arguments: args } } });
    expect(stored[3]).toMatchObject({ output: { text: JSON.stringify({ card: 'question', ...card }) } });
  }
});

it.each([false, true])('projects oversized tool-free reasoning without altering receipt or public text (signed=%s)', async signed => {
  const f = fixture(), text = '文'.repeat(32768), thinking = '思'.repeat(32768);
  const details = [{ type: 'reasoning.text', text: thinking, index: 0,
    format: signed ? 'anthropic-claude-v1' : 'unknown', ...(signed ? { signature: 'synthetic-signature' } : {}) }];
  const item: AgentInputItem = { type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, providerData: { role: 'assistant', reasoning: thinking, reasoning_details: details } }] };
  const before = JSON.stringify(item);
  expect(jsonbBytes(item)).toBeGreaterThan(RESULT_BYTE_LIMIT);
  await f.session.addItems([item]);
  await f.session.finish(text, false);
  expect(f.saved[0]?.[0]).toMatchObject({ content: [{ text, providerData: { role: 'assistant' } }] });
  expect(JSON.stringify(f.saved)).not.toContain('reasoning');
  expect(recoverOpenRouterHistory(f.saved.flat(), new Set())).toEqual(f.saved.flat());
  expect(jsonbBytes(f.saved[0]?.[0])).toBeLessThanOrEqual(RESULT_BYTE_LIMIT);
  expect(JSON.stringify(item)).toBe(before);
});
it('keeps small reasoning byte-identical and refuses unknown oversized metadata', async () => {
  const f = fixture();
  const item: AgentInputItem = { role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'answer', providerData: { reasoning: 'small' } }] };
  await f.session.addItems([item]);
  await f.session.finish('answer', false);
  expect(f.saved[0]?.[0]).toEqual(item);
  const bad = fixture();
  await bad.session.addItems([{ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer',
    providerData: { reasoning: 'x'.repeat(300000), plugins: [{ id: 'unknown' }] } }] }]);
  await expect(bad.session.finish('answer', false)).rejects.toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
  expect(bad.saved).toEqual([]);
});

it('projects oversized standalone reasoning but never discards a tool continuation', async () => {
  const f = fixture();
  await f.session.addItems([{ type: 'reasoning', content: [], rawContent: [{ type: 'reasoning_text', text: '思'.repeat(100000) }] }]);
  await f.session.finish('answer', false);
  expect(f.saved[0]?.[0]).toEqual({ type: 'reasoning', content: [], rawContent: [] });
  const bad = fixture();
  const call = { id: 'call', type: 'function', function: { name: 'ask_question', arguments: '{}' } };
  await bad.session.addItems([{ role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'answer',
    providerData: { reasoning: 'x'.repeat(300000), tool_calls: [call] } }] }]);
  await expect(bad.session.finish('answer', false)).rejects.toThrow('RUNTIME_PROVIDER_HISTORY_DENIED');
  expect(bad.saved).toEqual([]);
});
