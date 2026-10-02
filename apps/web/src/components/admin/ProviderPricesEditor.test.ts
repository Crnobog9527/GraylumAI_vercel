/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/trpc/client', () => ({ trpc: {} }));
const { parseProviderPricesDraft } = await import('./ProviderPricesEditor');

describe('provider prices editor draft', () => {
  it('parses JSON and refuses invalid text so nothing is sent', () => {
    expect(parseProviderPricesDraft('{"version":1,"entries":[]}')).toEqual({ version: 1, entries: [] });
    expect(parseProviderPricesDraft('{"version":1,')).toBeNull();
    expect(parseProviderPricesDraft('')).toBeNull();
  });
});
