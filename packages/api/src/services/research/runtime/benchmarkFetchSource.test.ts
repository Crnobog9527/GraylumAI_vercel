/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RT-6: the model never sees message ids, so {kind:"user_message"} without one names the message this reply answers.
import { expect, it, vi } from 'vitest';
import { benchmarkFetch } from './benchmarkFetch';
import { researchToolArgs } from '../tools/schemas';
import type { ResearchToolContext } from './toolContext';
import { DISABLED_RESEARCH_TOOLS, researchToolsConfigSchema } from '../vendors/config';

const executionId = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const scope = { userId: '44444444-4444-4444-8444-444444444444', sessionId: '55555555-5555-4555-8555-555555555555' };

function ctx(body: string | null) {
  const userMessage = vi.fn(async () => body);
  const fetchClaim = vi.fn();
  const config = researchToolsConfigSchema.parse(DISABLED_RESEARCH_TOOLS);
  const value = { scope, executionId, config, store: { authorization: { userMessage }, fetchClaim } } as unknown as ResearchToolContext;
  return { value, userMessage, fetchClaim };
}
const args = (source: unknown) => researchToolArgs.benchmark_fetch.parse({ accounts: [{ platform: 'tiktok', account: 'homeideas' }], source });

it('checks the current answer\'s own user message when the id is omitted', async () => {
  const c = ctx('这个号 https://www.tiktok.com/@HomeIdeas 你看看');
  // Authorised; with no priced route nothing is claimed and the account reads as incomplete.
  const result = JSON.parse(await benchmarkFetch(c.value, args({ kind: 'user_message' }), { left: 3, used: 0 }));
  expect(c.userMessage).toHaveBeenCalledWith(scope, executionId);
  expect(result).toMatchObject({ status: 'partial', reason: 'ACCOUNT_DATA_INCOMPLETE' });
  expect(c.fetchClaim).not.toHaveBeenCalled();
});

it('an explicit id is still checked as given, and a link outside that message is refused before any claim', async () => {
  const c = ctx('没有链接的消息');
  const result = JSON.parse(await benchmarkFetch(c.value, args({ kind: 'user_message', messageId: other }), { left: 3, used: 0 }));
  expect(c.userMessage).toHaveBeenCalledWith(scope, other);
  expect(result).toMatchObject({ status: 'not_confirmed', reason: 'NOT_CONFIRMED' });
  expect(c.fetchClaim).not.toHaveBeenCalled();
});

it('the current message without the requested profile link is refused, nothing claimed', async () => {
  const c = ctx('我想做家居号');
  const result = JSON.parse(await benchmarkFetch(c.value, args({ kind: 'user_message' }), { left: 3, used: 0 }));
  expect(result).toMatchObject({ status: 'not_confirmed', reason: 'NOT_CONFIRMED' });
  expect(c.fetchClaim).not.toHaveBeenCalled();
});
