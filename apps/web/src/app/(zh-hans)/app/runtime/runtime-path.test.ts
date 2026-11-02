/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { runtimePathChoice } from './runtime-path';

describe('which workspace a conversation opens in', () => {
  it('renders nothing until the conversation scope has been read', () => {
    expect(runtimePathChoice({ viewSettled: false })).toBe('loading');
    expect(runtimePathChoice({ viewSettled: false, scopeKind: 'work_item' })).toBe('loading');
  });
  it('opens a free conversation and a work item on the turn path', () => {
    expect(runtimePathChoice({ viewSettled: true, scopeKind: 'positioning_draft' })).toBe('turn');
    expect(runtimePathChoice({ viewSettled: true, scopeKind: 'work_item' })).toBe('work');
  });
  it('shows a failed or unknown read as unreadable, never as another workspace', () => {
    expect(runtimePathChoice({ viewSettled: true })).toBe('unreadable');
    expect(runtimePathChoice({ viewSettled: true, scopeKind: 'something_else' })).toBe('unreadable');
  });
});
