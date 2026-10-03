/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, expect, it, vi } from 'vitest';
import { allowAllModeration } from './moderation';
afterEach(() => vi.unstubAllGlobals());
it('allows arbitrary input and output without accessing the network', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  for (const text of ['', '任意内容', '<script>untrusted</script>']) {
    expect(await allowAllModeration.checkInput({
      actorId: 'actor', sessionId: 'session', requestId: 'request', text, opening: false,
    })).toEqual({ action: 'allow' });
    expect(await allowAllModeration.checkOutput({
      actorId: 'actor', executionId: 'execution', body: text, summary: text,
    })).toEqual({ action: 'allow' });
  }
  expect(fetch).not.toHaveBeenCalled();
});
