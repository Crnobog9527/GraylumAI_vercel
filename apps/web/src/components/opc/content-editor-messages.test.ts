/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it, vi } from 'vitest';
vi.mock('@/trpc/client', () => ({ trpc: {} }));
import { SCRIPT_NEEDS_SOURCE } from './content-editor';

// CONTENT-CONVERSATION-2 (validation of #1996): typing a script before any was saved says what to do, never a code.
it('tells the user to save a script from the conversation first, in words', () => {
  expect(SCRIPT_NEEDS_SOURCE).toContain('存为口播稿');
  expect(SCRIPT_NEEDS_SOURCE).toContain('你的编辑仍保留');
  expect(SCRIPT_NEEDS_SOURCE).not.toMatch(/[A-Z_]{4,}/);
});
