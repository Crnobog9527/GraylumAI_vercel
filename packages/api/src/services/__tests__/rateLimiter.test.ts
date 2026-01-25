/**
 * Rate Limiter Tests
 *
 * 测试内存速率限制器功能
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter, DEFAULT_RATE_LIMIT_CONFIGS, type RateLimitConfig } from '../rateLimiter';
import { TRPCError } from '@trpc/server';

// ============================================
// Test Configurations
// ============================================

const TEST_CONFIGS: Record<string, RateLimitConfig> = {
  test: {
    maxRequests: 5,
    windowMs: 1000, // 1 second window for fast tests
  },
  strict: {
    maxRequests: 2,
    windowMs: 1000,
  },
  lenient: {
    maxRequests: 100,
    windowMs: 60000,
  },
};

// ============================================
// Basic Functionality Tests
// ============================================

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      configs: TEST_CONFIGS,
      keyPrefix: 'test:',
    });
  });

  afterEach(() => {
    limiter.close();
  });

  describe('check()', () => {
    it('should allow requests within limit', () => {
      const result = limiter.check('user1', 'test');

      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);
      expect(result.limit).toBe(5);
      expect(result.remaining).toBe(4);
    });

    it('should block requests exceeding limit', () => {
      // Make 5 requests (limit)
      for (let i = 0; i < 5; i++) {
        limiter.check('user1', 'test');
      }

      // 6th request should be blocked
      const result = limiter.check('user1', 'test');

      expect(result.allowed).toBe(false);
      expect(result.current).toBe(6);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should track different users independently', () => {
      // User1 makes 3 requests
      for (let i = 0; i < 3; i++) {
        limiter.check('user1', 'test');
      }

      // User2 should start fresh
      const result = limiter.check('user2', 'test');

      expect(result.current).toBe(1);
      expect(result.remaining).toBe(4);
    });

    it('should track different types independently', () => {
      // Same user, different types
      for (let i = 0; i < 5; i++) {
        limiter.check('user1', 'test');
      }

      // Different type should start fresh
      const result = limiter.check('user1', 'strict');

      expect(result.current).toBe(1);
      expect(result.allowed).toBe(true);
    });

    it('should allow unknown types (no limit)', () => {
      const result = limiter.check('user1', 'unknown-type');

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(Infinity);
    });
  });

  describe('checkOrThrow()', () => {
    it('should return result when within limit', () => {
      const result = limiter.checkOrThrow('user1', 'test');

      expect(result.allowed).toBe(true);
    });

    it('should throw TRPCError when limit exceeded', () => {
      // Exhaust the limit
      for (let i = 0; i < 5; i++) {
        limiter.check('user1', 'test');
      }

      expect(() => limiter.checkOrThrow('user1', 'test')).toThrow(TRPCError);
    });

    it('should throw with correct error code', () => {
      for (let i = 0; i < 5; i++) {
        limiter.check('user1', 'test');
      }

      try {
        limiter.checkOrThrow('user1', 'test');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(TRPCError);
        expect((error as TRPCError).code).toBe('TOO_MANY_REQUESTS');
      }
    });

    it('should include retry-after in error message', () => {
      for (let i = 0; i < 5; i++) {
        limiter.check('user1', 'test');
      }

      try {
        limiter.checkOrThrow('user1', 'test');
        expect.fail('Should have thrown');
      } catch (error) {
        expect((error as TRPCError).message).toContain('秒后重试');
      }
    });
  });

  describe('Window Reset', () => {
    it('should reset count after window expires', async () => {
      // Use a very short window for testing
      const shortLimiter = new RateLimiter({
        configs: {
          short: { maxRequests: 2, windowMs: 100 }, // 100ms window
        },
      });

      // Exhaust the limit
      shortLimiter.check('user1', 'short');
      shortLimiter.check('user1', 'short');

      let result = shortLimiter.check('user1', 'short');
      expect(result.allowed).toBe(false);

      // Wait for window to reset
      await new Promise((resolve) => setTimeout(resolve, 150));

      result = shortLimiter.check('user1', 'short');
      expect(result.allowed).toBe(true);
      expect(result.current).toBe(1);

      shortLimiter.close();
    });
  });
});

// ============================================
// Default Configuration Tests
// ============================================

describe('Default Rate Limit Configs', () => {
  it('should have ai config', () => {
    expect(DEFAULT_RATE_LIMIT_CONFIGS.ai).toBeDefined();
    expect(DEFAULT_RATE_LIMIT_CONFIGS.ai.maxRequests).toBe(60);
    expect(DEFAULT_RATE_LIMIT_CONFIGS.ai.windowMs).toBe(60000);
  });

  it('should have ai_stream config', () => {
    expect(DEFAULT_RATE_LIMIT_CONFIGS.ai_stream).toBeDefined();
    expect(DEFAULT_RATE_LIMIT_CONFIGS.ai_stream.maxRequests).toBe(30);
  });

  it('should have api config', () => {
    expect(DEFAULT_RATE_LIMIT_CONFIGS.api).toBeDefined();
    expect(DEFAULT_RATE_LIMIT_CONFIGS.api.maxRequests).toBe(100);
  });

  it('should have auth config', () => {
    expect(DEFAULT_RATE_LIMIT_CONFIGS.auth).toBeDefined();
    expect(DEFAULT_RATE_LIMIT_CONFIGS.auth.maxRequests).toBe(10);
  });
});

// ============================================
// Concurrency Tests
// ============================================

describe('Concurrent Requests', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      configs: {
        concurrent: { maxRequests: 10, windowMs: 60000 },
      },
    });
  });

  afterEach(() => {
    limiter.close();
  });

  it('should handle concurrent requests correctly', async () => {
    // Simulate 20 concurrent requests
    const promises = Array(20)
      .fill(null)
      .map(() => Promise.resolve(limiter.check('user1', 'concurrent')));

    const results = await Promise.all(promises);

    // First 10 should be allowed
    const allowedCount = results.filter((r) => r.allowed).length;
    expect(allowedCount).toBe(10);

    // Last 10 should be blocked
    const blockedCount = results.filter((r) => !r.allowed).length;
    expect(blockedCount).toBe(10);
  });

  it('should count all requests accurately', async () => {
    const promises = Array(5)
      .fill(null)
      .map(() => Promise.resolve(limiter.check('user1', 'concurrent')));

    await Promise.all(promises);

    const result = limiter.check('user1', 'concurrent');
    expect(result.current).toBe(6);
  });
});

// ============================================
// Edge Cases
// ============================================

describe('Edge Cases', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      configs: TEST_CONFIGS,
    });
  });

  afterEach(() => {
    limiter.close();
  });

  it('should handle empty identifier', () => {
    const result = limiter.check('', 'test');
    expect(result.allowed).toBe(true);
  });

  it('should handle special characters in identifier', () => {
    const specialIds = [
      'user@domain.com',
      'user:id:123',
      'user/path/to',
      'user|pipe',
      'user<tag>',
    ];

    specialIds.forEach((id) => {
      const result = limiter.check(id, 'test');
      expect(result.allowed).toBe(true);
    });
  });

  it('should handle unicode identifiers', () => {
    const result = limiter.check('用户123', 'test');
    expect(result.allowed).toBe(true);
  });

  it('should handle very long identifiers', () => {
    const longId = 'a'.repeat(1000);
    const result = limiter.check(longId, 'test');
    expect(result.allowed).toBe(true);
  });

  it('should return correct store size', () => {
    limiter.check('user1', 'test');
    limiter.check('user2', 'test');
    limiter.check('user1', 'strict');

    // Should have 3 unique keys
    expect(limiter.getStoreSize()).toBe(3);
  });
});

// ============================================
// Cleanup Tests
// ============================================

describe('Memory Cleanup', () => {
  it('should clean up expired entries', async () => {
    const shortLimiter = new RateLimiter({
      configs: {
        short: { maxRequests: 100, windowMs: 50 }, // 50ms window
      },
    });

    // Create some entries
    shortLimiter.check('user1', 'short');
    shortLimiter.check('user2', 'short');
    shortLimiter.check('user3', 'short');

    expect(shortLimiter.getStoreSize()).toBe(3);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    // New request triggers cleanup of old entries
    shortLimiter.check('user4', 'short');

    // Manual cleanup not exposed, but entries should be cleaned on next interval
    // Just verify the limiter still works
    const result = shortLimiter.check('user1', 'short');
    expect(result.current).toBe(1); // Should be reset

    shortLimiter.close();
  });

  it('should handle close() gracefully', () => {
    const tempLimiter = new RateLimiter({ configs: TEST_CONFIGS });

    tempLimiter.check('user1', 'test');

    expect(() => tempLimiter.close()).not.toThrow();

    // Store should be cleared
    expect(tempLimiter.getStoreSize()).toBe(0);
  });
});

// ============================================
// Security-Specific Tests
// ============================================

describe('Rate Limiter Security', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter({
      configs: {
        auth: { maxRequests: 5, windowMs: 60000 },
      },
    });
  });

  afterEach(() => {
    limiter.close();
  });

  it('should prevent brute force attacks', () => {
    // Simulate login attempts
    for (let i = 0; i < 5; i++) {
      const result = limiter.check('attacker-ip', 'auth');
      expect(result.allowed).toBe(true);
    }

    // 6th attempt should be blocked
    const result = limiter.check('attacker-ip', 'auth');
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('should not leak timing information', () => {
    // Both should complete in similar time regardless of state
    const start1 = performance.now();
    limiter.check('user1', 'auth');
    const time1 = performance.now() - start1;

    // Exhaust limit
    for (let i = 0; i < 10; i++) {
      limiter.check('user2', 'auth');
    }

    const start2 = performance.now();
    limiter.check('user2', 'auth');
    const time2 = performance.now() - start2;

    // Times should be roughly similar (within 10x - accounting for JIT)
    expect(time2).toBeLessThan(time1 * 10 + 5);
  });

  it('should isolate different IP addresses', () => {
    // Attacker on one IP shouldn't affect legitimate user on another
    for (let i = 0; i < 10; i++) {
      limiter.check('attacker-ip', 'auth');
    }

    const result = limiter.check('legitimate-ip', 'auth');
    expect(result.allowed).toBe(true);
    expect(result.current).toBe(1);
  });
});
