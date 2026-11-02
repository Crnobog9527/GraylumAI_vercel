/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { projectHistory, trimHistory, turnSession } from './history';

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
