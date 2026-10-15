/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { topicRequestRefused } from './use-topic-opening';

it('remembers only the refused request of this workspace, and treats unreadable storage as not refused', () => {
  const items = new Map([['opc-topic-operation:s1:rejected:r1', '{}']]);
  const storage = { getItem: (key: string) => items.get(key) ?? null };
  expect(topicRequestRefused(storage, 'opc-topic-operation:s1', 'r1')).toBe(true);
  expect(topicRequestRefused(storage, 'opc-topic-operation:s1', 'r2')).toBe(false);
  expect(topicRequestRefused(storage, 'opc-topic-operation:s2', 'r1')).toBe(false);
  expect(topicRequestRefused(storage, '', 'r1')).toBe(false);
  expect(topicRequestRefused({ getItem: () => { throw new Error('denied'); } }, 'opc-topic-operation:s1', 'r1')).toBe(false);
});
