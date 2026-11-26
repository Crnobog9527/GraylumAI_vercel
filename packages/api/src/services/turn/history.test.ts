/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EARLIER_REPLY_MARK, historyRoom, projectHistory, trimHistory, trimKeepingUserWords, turnSession } from './history';
import { fitToolTurn } from './tools/capacity';

const message = (seq: number, role: 'user' | 'assistant', content: string) =>
  ({ seq, role, content, contentHash: createHash('sha256').update(content).digest('hex') });
const conversation = (n: number) => Array.from({ length: n }, (_, i) => message(i + 1, i % 2 ? 'assistant' : 'user', `message ${i + 1}`));

describe('history projection (CORE-PATH-V2 2.6, 2.9 rule 5)', () => {
  it('projects each message from itself alone: the same message is the same bytes in every later turn', () => {
    const earlier = projectHistory(conversation(4)), later = projectHistory(conversation(10));
    expect(JSON.stringify(later.slice(0, 4))).toBe(JSON.stringify(earlier));
    expect(later[1]).toEqual({ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'message 2' }] });
  });

  it('trims the oldest messages first, so the cut only moves forward as the conversation grows', () => {
    const budget = Buffer.byteLength(JSON.stringify(projectHistory(conversation(4))));
    const cuts = [6, 8, 12, 20].map(n => {
      const all = projectHistory(conversation(n)), kept = trimHistory(all, budget);
      expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(budget);
      expect(kept[0]?.role).toBe('user');
      return all.length - kept.length;
    });
    expect(cuts).toEqual([...cuts].sort((a, b) => a - b));
    expect(trimHistory(projectHistory(conversation(3)), 0)).toEqual([]);
  });

  it('the session hands the SDK the history and keeps nothing the SDK writes', async () => {
    const session = turnSession(projectHistory(conversation(2)));
    await session.addItems([{ type: 'message', role: 'user', content: 'x' }] as never);
    expect(await session.getItems()).toHaveLength(2);
  });
});

describe('the room history may take next to the tool reserve (D-6: a coach turn lost the whole conversation)', () => {
  // Turn 6574 on staging: a 150 kB ceiling, about 14 kB of instructions, 3 kB of tool definitions, and the reserves of a Pro chat
  // with research on: one library read 24,576 + own posts 24,000 + research 24,576 + a strategy read 52,000.
  const base = { inputLimit: 150_000, instructionBytes: 14_000, currentBytes: 100 };
  const plan = (elasticBytes?: number) => ({ reserveBytes: 24_576 + 24_000 + 24_576 + 52_000, ...(elasticBytes ? { elasticBytes } : {}) });

  it('the strategy room is elastic: the last exchange survives where the whole reserve left no byte for it', () => {
    expect(historyRoom({ ...base, tools: { plan: plan(), definitionBytes: 3000 } })).toBe(0);
    const room = historyRoom({ ...base, tools: { plan: plan(52_000), definitionBytes: 3000 } });
    expect(room).toBeGreaterThan(40_000);
    const exchange = projectHistory([message(1, 'user', '帮我复盘'), message(2, 'assistant', '你名下有两个品牌账号，想复盘哪一个？'.repeat(20))]);
    expect(trimHistory(exchange, 0)).toEqual([]);
    expect(trimHistory(exchange, room)).toEqual(exchange);
  });

  it('without tools the room is the ceiling minus the instructions, the message and the reply slack', () => {
    expect(historyRoom(base)).toBe(150_000 - 14_000 - 100 - 8192);
    expect(historyRoom({ ...base, inputLimit: 10_000 })).toBe(0);
  });
});

describe('history next to a real strategy read stays inside the 150 kB ceiling (D-6 review)', () => {
  const inputLimit = 150_000, instructions = 'i'.repeat(14_000), definitionBytes = 3000, current = '帮我复盘';
  const plan = { reserveBytes: 24_576 + 24_000 + 24_576 + 52_000, elasticBytes: 52_000 };
  const long = Array.from({ length: 40 }, (_, i) => message(i + 1, i % 2 ? 'assistant' : 'user', `m${i + 1} ` + '字'.repeat(1500)));
  const total = (history: ReturnType<typeof projectHistory>, extra: unknown[] = []) =>
    Buffer.byteLength(instructions) + definitionBytes + Buffer.byteLength(JSON.stringify([...history, { role: 'user', content: current }, ...extra]));

  it('the request at the start of the turn is below the ceiling minus the reply slack, whatever the history holds', () => {
    const room = historyRoom({ inputLimit, instructionBytes: Buffer.byteLength(instructions), currentBytes: Buffer.byteLength(current),
      tools: { plan, definitionBytes } });
    const history = trimHistory(projectHistory(long), room);
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThan(long.length);
    expect(total(history)).toBeLessThanOrEqual(inputLimit - 8192);
  });

  it('when the strategy is really read, the oldest history goes first and the request stays within the budget the runner enforces', () => {
    const room = historyRoom({ inputLimit, instructionBytes: Buffer.byteLength(instructions), currentBytes: Buffer.byteLength(current),
      tools: { plan, definitionBytes } });
    const history = trimHistory(projectHistory(long), room);
    // The turn really reads its own posts, the strategy and a Skill: the results the reserve was kept for (24,000 + 52,000 + 24,576).
    const results = [24_000, 52_000, 24_576].map(size => ({ type: 'function_call_result', output: 's'.repeat(size) }));
    const items = [...history, { type: 'message', role: 'user', content: current }, ...results];
    // chat.ts: fitToolTurn(items, instructions, history.length, inputLimit - 8192 - definitionBytes)
    const kept = fitToolTurn(items, instructions, history.length, inputLimit - 8192 - definitionBytes);
    expect(kept.length).toBeLessThan(items.length);
    // This turn's own items are all kept; what goes is history, oldest first, and the kept history still starts with a user message.
    expect(kept.slice(-4)).toEqual(items.slice(-4));
    expect(kept.length - 4).toBeLessThan(history.length);
    if (kept.length > 4) expect((kept[0] as { role: string }).role).toBe('user');
    expect(Buffer.byteLength(instructions) + definitionBytes + Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(inputLimit - 8192);
    // Without the eviction the same request would have gone over the budget.
    expect(Buffer.byteLength(instructions) + definitionBytes + Buffer.byteLength(JSON.stringify(items))).toBeGreaterThan(inputLimit - 8192);
  });
});

describe('the positioning mentor keeps the user\'s own words longest (Owner\'s new-account run, 2026-11-26: questions asked again)', () => {
  // The shape of a staging positioning conversation: short answers, long coach replies; about 11 kB of room after the Skill,
  // the checklist, the rules and the Skill-file reserve (estimated from the prompt sizes of staging sessions, turns 7 to 13).
  const room = 11_000;
  const answers = Array.from({ length: 13 }, (_, i) => `回答 ${i + 1}：` + '我在美国上班，每周能发 3 条，暂不变现。'.repeat(3));
  const replies = Array.from({ length: 13 }, (_, i) => `回复 ${i + 1}。` + '我们先把这一步需要的信息说清楚，再看下一步。'.repeat(18) +
    ` 问题 ${i + 1}：你最想让这个账号带来什么？`);
  const chat = (turns: number) => projectHistory(Array.from({ length: turns }, (_, i) => [
    message(i * 2 + 1, 'user', answers[i]!), message(i * 2 + 2, 'assistant', replies[i]!)]).flat());
  const text = (item: ReturnType<typeof projectHistory>[number]) =>
    item.role === 'user' ? item.content : item.content.map(part => part.text).join('');

  it('before: trimHistory drops the earliest answers once the conversation outgrows the room', () => {
    const kept = trimHistory(chat(13), room).map(text);
    expect(kept.some(item => item.startsWith('回答 1：'))).toBe(false);
  });

  it('every answer is still there verbatim; the newest replies stay whole, older ones keep their ending (where the question is)', () => {
    const all = chat(13), kept = trimKeepingUserWords(all, room);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(room);
    expect(kept[0]!.role).toBe('user');
    expect(kept.filter(item => item.role === 'user').map(text)).toEqual(answers);
    expect(text(kept.at(-1)!)).toBe(replies[12]);
    const older = kept.filter(item => item.role === 'assistant' && text(item).startsWith(EARLIER_REPLY_MARK)).map(text);
    expect(older.length).toBeGreaterThan(0);
    for (const reply of older) expect(replies.some(original => original.endsWith(reply.slice(EARLIER_REPLY_MARK.length)))).toBe(true);
    expect(older.every(reply => reply.includes('你最想让这个账号带来什么？'))).toBe(true);
  });

  it('a history that fits is unchanged, and an older reply is the same bytes in every later turn', () => {
    const small = chat(2);
    expect(trimKeepingUserWords(small, room)).toEqual(small);
    // A reply shortened in an earlier turn is shortened to exactly the same bytes in a later one.
    const shortenedBy = (items: ReturnType<typeof projectHistory>) => new Map(items.map(text)
      .filter(item => item.startsWith(EARLIER_REPLY_MARK)).map(item => [/问题 (\d+)：/.exec(item)![1], item]));
    const earlier = shortenedBy(trimKeepingUserWords(chat(10), room)), later = shortenedBy(trimKeepingUserWords(chat(13), room));
    const both = [...earlier.keys()].filter(key => later.has(key));
    expect(both.length).toBeGreaterThan(0);
    for (const key of both) expect(later.get(key)).toBe(earlier.get(key));
  });

  it('when even the shortened history does not fit, the oldest replies go before any answer', () => {
    const kept = trimKeepingUserWords(chat(13), 7_000);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(7_000);
    expect(kept.filter(item => item.role === 'user').map(text)).toEqual(answers);
    expect(text(kept.at(-1)!)).toBe(replies[12]);
  });

  it('when even the answers alone do not fit, the oldest messages go first and nothing exceeds the room', () => {
    const tight = 2_000, kept = trimKeepingUserWords(chat(13), tight);
    expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(tight);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept[0]!.role).toBe('user');
    expect(text(kept.at(-1)!).endsWith('你最想让这个账号带来什么？')).toBe(true);
    expect(trimKeepingUserWords(chat(3), 0)).toEqual([]);
  });
});
