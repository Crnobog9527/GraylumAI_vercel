/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { describe, expect, it } from 'vitest';
import { aggregateCacheStats } from '../promptCache';

describe('promptCache aggregateCacheStats', () => {
  it('counts per-request cache hits and misses instead of treating the batch as all-or-nothing', () => {
    const stats = aggregateCacheStats([
      { input_tokens: 1000, cached_tokens: 0 },
      { input_tokens: 1200, cached_tokens: 300, cache_creation_tokens: 50 },
      { input_tokens: 900, cached_tokens: 0 },
    ]);

    expect(stats).toEqual({
      totalRequests: 3,
      cacheHits: 1,
      cacheMisses: 2,
      hitRate: 33,
      tokensSaved: 300,
      costSaved: 270,
    });
  });
});
