/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { historyRoom, projectHistory, trimHistory, turnSession } from './history';

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
