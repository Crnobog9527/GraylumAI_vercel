/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { announceTurnClosed, onTurnClosed } from './turn-closed-channel';

describe('a turn closed in another tab', () => {
  it('tells a listening tab once per close, and nothing after it stopped listening', async () => {
    const heard = vi.fn();
    const stop = onTurnClosed(heard);
    announceTurnClosed();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(heard).toHaveBeenCalledTimes(1);
    stop();
    announceTurnClosed();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(heard).toHaveBeenCalledTimes(1);
  });
  it('does nothing where BroadcastChannel does not exist', () => {
    vi.stubGlobal('BroadcastChannel', undefined);
    expect(() => announceTurnClosed()).not.toThrow();
    expect(onTurnClosed(() => {})()).toBeUndefined();
    vi.unstubAllGlobals();
  });
});
