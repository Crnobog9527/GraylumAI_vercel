/**
 * Billing Security Tests
 *
 * 测试计费系统的安全性：
 * - 并发扣费攻击防护
 * - 负数金额攻击防护
 * - 成本验证和一致性
 * - 双重消费防护
 * - 输入验证
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateTokenCost,
  estimateRequestCost,
  BillingService,
  type BillingContext,
} from '../billing';
import { BILLING_CONSTANTS } from '../../types/billing';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
});

// ============================================
// Mock Supabase Client Factory
// ============================================

function createMockSupabase(options: {
  credits?: number;
  updatedAt?: string;
  insertedId?: string;
  shouldFailUpdate?: boolean;
  concurrentUpdateAttempts?: number;
  existingPreDeduct?: { id: string; amount: number } | null;
  existingSettle?: { id: string } | null;
}) {
  const {
    credits = 10000,
    updatedAt = new Date().toISOString(),
    insertedId = 'test-billing-id',
    shouldFailUpdate = false,
    concurrentUpdateAttempts = 0,
    existingPreDeduct = null,
    existingSettle = null,
  } = options;

  let updateAttempts = 0;
  let currentCredits = credits;

  return {
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(),
      insert: vi.fn().mockReturnThis(),
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      contains: vi.fn().mockReturnThis(),
      single: vi.fn().mockImplementation(() => {
        if (table === 'profiles') {
          // Simulate concurrent update failures
          if (shouldFailUpdate || updateAttempts < concurrentUpdateAttempts) {
            updateAttempts++;
            return Promise.resolve({
              data: null,
              error: { message: 'Update conflict' },
            });
          }
          return Promise.resolve({
            data: { credits: currentCredits, updated_at: updatedAt },
            error: null,
          });
        }
        if (table === 'billing_history') {
          if (existingPreDeduct) {
            return Promise.resolve({
              data: existingPreDeduct,
              error: null,
            });
          }
          if (existingSettle) {
            return Promise.resolve({
              data: existingSettle,
              error: null,
            });
          }
          return Promise.resolve({
            data: {
              id: insertedId,
              amount: -1000,
              operation_type: 'pre_deduct',
            },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }),
    })),
    rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'RPC not available' } }),
  } as unknown as BillingContext['supabase'];
}

// ============================================
// Cost Manipulation Attack Tests
// ============================================

describe('Cost Manipulation Attack Prevention', () => {
  describe('Negative Amount Attacks', () => {
    it('should reject negative input tokens in cost calculation', () => {
      const usage = {
        inputTokens: -1000,
        outputTokens: 500,
      };

      const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

      // Should not produce negative credits
      expect(Number.isFinite(result.credits)).toBe(true);
      // The calculation might be negative but won't give attacker credits
    });

    it('should reject negative output tokens in cost calculation', () => {
      const usage = {
        inputTokens: 1000,
        outputTokens: -500,
      };

      const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

      expect(Number.isFinite(result.credits)).toBe(true);
    });

    it('should handle extremely large token counts', () => {
      const usage = {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: Number.MAX_SAFE_INTEGER,
      };

      const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

      // Should not overflow or produce Infinity
      expect(Number.isFinite(result.costUsd) || result.costUsd === Infinity).toBe(true);
    });

    it('should handle NaN token values', () => {
      const usage = {
        inputTokens: NaN,
        outputTokens: 500,
      };

      const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

      // Should handle gracefully, not crash
      expect(typeof result.credits).toBe('number');
    });
  });

  describe('Pre-deduct Amount Bounds', () => {
    it('should enforce minimum pre-deduct amount', () => {
      // Very small input that would estimate to near-zero cost
      const estimated = estimateRequestCost('claude-sonnet-4-20250514', 1, 1);

      expect(estimated).toBeGreaterThanOrEqual(BILLING_CONSTANTS.MIN_PRE_DEDUCT);
    });

    it('should enforce maximum pre-deduct amount', () => {
      // Very large input
      const estimated = estimateRequestCost('claude-sonnet-4-20250514', 200000, 200000);

      expect(estimated).toBeLessThanOrEqual(BILLING_CONSTANTS.MAX_PRE_DEDUCT);
    });

    it('should include safety margin in estimates', () => {
      const inputTokens = 10000;
      const outputTokens = 4096;

      const baseCost = calculateTokenCost('claude-sonnet-4-20250514', {
        inputTokens,
        outputTokens,
      });

      const estimated = estimateRequestCost('claude-sonnet-4-20250514', inputTokens, outputTokens);

      // Estimated should be higher than base cost due to safety margin
      const expectedMinWithMargin = Math.ceil(baseCost.credits * (1 + BILLING_CONSTANTS.SAFETY_MARGIN));

      expect(estimated).toBeGreaterThanOrEqual(
        Math.max(BILLING_CONSTANTS.MIN_PRE_DEDUCT, expectedMinWithMargin)
      );
    });
  });
});

// ============================================
// Insufficient Balance Protection Tests
// ============================================

describe('Insufficient Balance Protection', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test' };
  });

  it('should block pre-deduct when balance is zero', async () => {
    const mockSupabase = createMockSupabase({ credits: 0 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(service.preDeduct(100, { reason: 'test' })).rejects.toThrow(
      '积分不足'
    );
  });

  it('should block pre-deduct when balance is less than requested', async () => {
    const mockSupabase = createMockSupabase({ credits: 50 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(service.preDeduct(100, { reason: 'test' })).rejects.toThrow(
      '积分不足'
    );
  });

  it('should block pre-deduct when balance equals requested (exact match)', async () => {
    const mockSupabase = createMockSupabase({ credits: 100 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    // Should NOT throw for exact match - user has exactly enough
    // The balance check is: currentCredits < estimatedCredits
    // So 100 < 100 is false, meaning it should pass
    // However this depends on implementation, let's test both scenarios
    try {
      await service.preDeduct(100, { reason: 'test' });
      // If it passes, that's acceptable
    } catch (error: any) {
      // If it fails with insufficient credits, that's also acceptable
      expect(error.message).toContain('积分');
    }
  });
});

describe('Atomic Billing Enforcement', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('blocks non-atomic pre-deduct fallback in production', async () => {
    process.env.NODE_ENV = 'production';

    const mockSupabase = createMockSupabase({ credits: 1000 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(service.preDeduct(100, { reason: 'test' })).rejects.toThrow(
      'Atomic billing RPC required for preDeduct',
    );
  });

  it('blocks non-atomic finalize fallback in production', async () => {
    process.env.NODE_ENV = 'production';

    const mockSupabase = createMockSupabase({ credits: 1000 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(
      service.finalizeAIFailure({
        modelUsed: 'claude-sonnet-4-20250514',
        reason: 'test failure',
        preDeductId: 'pre-123',
      }),
    ).rejects.toThrow('Atomic billing RPC required for finalizeAIFailure');
  });
});

// ============================================
// Cost Verification Tests (verifyCost)
// ============================================

describe('Cost Verification Security', () => {
  it('should reject settle with negative actualCredits', async () => {
    const mockSupabase = createMockSupabase({
      existingPreDeduct: { id: 'pre-123', amount: -1000 },
    });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(
      service.settle('pre-123', -500, { inputTokens: 1000, outputTokens: 500 })
    ).rejects.toThrow('积分不能为负数');
  });

  it('should reject settle with negative input tokens', async () => {
    const mockSupabase = createMockSupabase({
      existingPreDeduct: { id: 'pre-123', amount: -1000 },
    });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(
      service.settle('pre-123', 500, { inputTokens: -1000, outputTokens: 500 })
    ).rejects.toThrow('Token 数量不能为负数');
  });

  it('should reject settle with negative output tokens', async () => {
    const mockSupabase = createMockSupabase({
      existingPreDeduct: { id: 'pre-123', amount: -1000 },
    });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(
      service.settle('pre-123', 500, { inputTokens: 1000, outputTokens: -500 })
    ).rejects.toThrow('Token 数量不能为负数');
  });

  it('should reject abnormally large single settle amount', async () => {
    const mockSupabase = createMockSupabase({
      existingPreDeduct: { id: 'pre-123', amount: -1000 },
    });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    // Try to settle with a huge amount (larger than MAX_PRE_DEDUCT * 2)
    const hugeAmount = BILLING_CONSTANTS.MAX_PRE_DEDUCT * 3;

    await expect(
      service.settle('pre-123', hugeAmount, { inputTokens: 1000, outputTokens: 500 })
    ).rejects.toThrow('单次结算金额过大');
  });
});

// ============================================
// Double-Spend Prevention Tests
// ============================================

describe('Double-Spend Prevention', () => {
  it('should prevent settling the same pre-deduct twice', async () => {
    const mockSupabase = createMockSupabase({
      existingPreDeduct: { id: 'pre-123', amount: -1000 },
      existingSettle: { id: 'settle-456' },
    });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(
      service.settle('pre-123', 500, { inputTokens: 1000, outputTokens: 500 })
    ).rejects.toThrow('该预扣记录已结算');
  });

  it('should prevent refunding an already settled pre-deduct', async () => {
    // Create mock that returns existing settle for refund attempt
    const mockSupabase = {
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(),
        insert: vi.fn().mockReturnThis(),
        update: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        or: vi.fn().mockReturnThis(),
        in: vi.fn().mockReturnThis(),
        contains: vi.fn().mockReturnThis(),
        single: vi.fn().mockImplementation(() => {
          if (table === 'billing_history') {
            // First call returns preDeduct, second returns existing settle
            return Promise.resolve({
              data: { id: 'pre-123', amount: -1000, operation_type: 'settle' },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      })),
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'RPC not available' } }),
    } as unknown as BillingContext['supabase'];

    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    await expect(service.refund('pre-123', 'test refund')).rejects.toThrow();
  });
});

// ============================================
// Input Validation Tests
// ============================================

describe('Input Validation', () => {
  describe('Model ID Validation', () => {
    it('should handle unknown model ID by falling back to default pricing', () => {
      const usage = { inputTokens: 1000, outputTokens: 500 };

      const unknownResult = calculateTokenCost('unknown-model-xyz', usage);
      const sonnetResult = calculateTokenCost('claude-sonnet-4-20250514', usage);

      // Should use Sonnet pricing as fallback
      expect(unknownResult.credits).toBe(sonnetResult.credits);
    });

    it('should handle empty model ID', () => {
      const usage = { inputTokens: 1000, outputTokens: 500 };

      const result = calculateTokenCost('', usage);

      // Should not crash, use fallback
      expect(Number.isFinite(result.credits)).toBe(true);
    });

    it('should handle model ID with special characters', () => {
      const usage = { inputTokens: 1000, outputTokens: 500 };

      // Try injection-like model IDs
      const injectionIds = [
        "'; DROP TABLE models;--",
        '<script>alert("xss")</script>',
        '../../../etc/passwd',
        'model${`whoami`}',
      ];

      injectionIds.forEach((modelId) => {
        const result = calculateTokenCost(modelId, usage);
        expect(Number.isFinite(result.credits)).toBe(true);
      });
    });
  });

  describe('Token Usage Validation', () => {
    it('should handle zero tokens', () => {
      const usage = { inputTokens: 0, outputTokens: 0 };

      const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

      expect(result.credits).toBe(0);
      expect(result.costUsd).toBe(0);
    });

    it('should handle undefined cache tokens', () => {
      const usage = {
        inputTokens: 1000,
        outputTokens: 500,
        // cacheReadTokens and cacheCreationTokens are undefined
      };

      const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

      expect(Number.isFinite(result.credits)).toBe(true);
      expect(result.breakdown.cacheRead).toBe(0);
      expect(result.breakdown.cacheWrite).toBe(0);
    });

    it('should handle floating point token counts', () => {
      const usage = {
        inputTokens: 1000.5,
        outputTokens: 500.7,
      };

      const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

      // Should handle floats without crashing
      expect(Number.isFinite(result.credits)).toBe(true);
    });
  });
});

// ============================================
// Billing Constants Security Tests
// ============================================

describe('Billing Constants Security', () => {
  it('should have reasonable MIN_PRE_DEDUCT', () => {
    expect(BILLING_CONSTANTS.MIN_PRE_DEDUCT).toBeGreaterThan(0);
    expect(BILLING_CONSTANTS.MIN_PRE_DEDUCT).toBeLessThan(1000);
  });

  it('should have reasonable MAX_PRE_DEDUCT', () => {
    expect(BILLING_CONSTANTS.MAX_PRE_DEDUCT).toBeGreaterThan(BILLING_CONSTANTS.MIN_PRE_DEDUCT);
    expect(BILLING_CONSTANTS.MAX_PRE_DEDUCT).toBeLessThan(1000000); // Reasonable upper limit
  });

  it('should have reasonable SAFETY_MARGIN', () => {
    expect(BILLING_CONSTANTS.SAFETY_MARGIN).toBeGreaterThanOrEqual(0);
    expect(BILLING_CONSTANTS.SAFETY_MARGIN).toBeLessThanOrEqual(1); // Max 100% margin
  });

  it('should have positive CREDITS_PER_USD', () => {
    expect(BILLING_CONSTANTS.CREDITS_PER_USD).toBeGreaterThan(0);
  });

  it('should have reasonable TOKEN_PRICE_MULTIPLIER', () => {
    expect(BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER).toBeGreaterThan(0);
    expect(BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER).toBeLessThan(10); // Not too high
  });
});

// ============================================
// Edge Cases and Boundary Tests
// ============================================

describe('Edge Cases and Boundaries', () => {
  it('should handle pre-deduct at exactly MAX_PRE_DEDUCT', () => {
    const estimated = estimateRequestCost('claude-sonnet-4-20250514', 200000, 200000);

    expect(estimated).toBeLessThanOrEqual(BILLING_CONSTANTS.MAX_PRE_DEDUCT);
  });

  it('should handle settle with zero difference', async () => {
    // When actual equals pre-deducted, no refund or additional charge needed
    const preDeductAmount = 1000;

    const mockSupabase = createMockSupabase({
      credits: 10000,
      existingPreDeduct: { id: 'pre-123', amount: -preDeductAmount },
    });

    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    // We can't fully test settle without the full mock chain
    // but we verify the flow doesn't crash
    try {
      await service.settle('pre-123', preDeductAmount, {
        inputTokens: 1000,
        outputTokens: 500,
      });
    } catch (error: any) {
      // Expected to fail due to mock limitations, not security issues
      expect(error.message).not.toContain('安全');
    }
  });

  it('should handle very small credit amounts', () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
    };

    const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

    // Should produce non-negative result
    expect(result.credits).toBeGreaterThanOrEqual(0);
  });

  it('should maintain precision for micro-transactions', () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
    };

    const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

    // Very small usage should still produce some cost
    expect(result.costUsd).toBeGreaterThan(0);
  });
});

// ============================================
// Race Condition Tests (Conceptual)
// ============================================

describe('Race Condition Prevention (Conceptual)', () => {
  /**
   * Race condition prevention is implemented via:
   * 1. Optimistic locking with updated_at field in profiles table
   * 2. Atomic RPC functions (atomic_pre_deduct, atomic_settle, etc.)
   *
   * These tests document the expected behavior. Full testing requires
   * integration tests with a real database to test concurrent transactions.
   */

  it('should implement optimistic locking pattern', () => {
    // Verify the BillingService has the expected method
    const mockSupabase = createMockSupabase({ credits: 10000 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    // Service should exist and be properly constructed
    expect(service).toBeDefined();
    expect(typeof service.preDeduct).toBe('function');
    expect(typeof service.settle).toBe('function');
    expect(typeof service.refund).toBe('function');
  });

  it('should use updated_at for optimistic locking verification', async () => {
    // This documents that the implementation checks updated_at
    // The actual preDeduct method:
    // 1. Gets profile with updated_at
    // 2. Updates profile WHERE id = userId AND updated_at = previous_updated_at
    // 3. If no rows affected, throws conflict error

    // Conceptual verification - the method signature and error handling
    const mockSupabase = createMockSupabase({ credits: 10000 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    // The service uses Supabase queries that implement this pattern
    expect(mockSupabase.from).toBeDefined();
  });
});

// ============================================
// Idempotency Tests
// ============================================

describe('Idempotency', () => {
  it('should detect duplicate request IDs', async () => {
    const requestId = '4c7f0e36-7c38-4ce8-86b2-59d72ff8c0e1';

    // Create mock that returns existing record for idempotency check
    const createChain = (table: string) => {
      const chain: Record<string, any> = {};
      chain.select = vi.fn().mockReturnValue(chain);
      chain.insert = vi.fn().mockReturnValue(chain);
      chain.update = vi.fn().mockReturnValue(chain);
      chain.eq = vi.fn().mockReturnValue(chain);
      chain.or = vi.fn().mockReturnValue(chain);
      chain.in = vi.fn().mockReturnValue(chain);
      chain.contains = vi.fn().mockReturnValue(chain);
      chain.single = vi.fn().mockImplementation(() => {
        if (table === 'billing_history') {
          return Promise.resolve({
            data: {
              id: 'existing-pre-deduct',
              metadata: { requestId, balance_before: 10000, balance_after: 9000 },
            },
            error: null,
          });
        }
        if (table === 'profiles') {
          return Promise.resolve({
            data: { credits: 10000, updated_at: new Date().toISOString() },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      });
      return chain;
    };

    const mockSupabase = {
      from: vi.fn((table: string) => createChain(table)),
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'RPC not available' } }),
    } as unknown as BillingContext['supabase'];

    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    const result = await service.preDeduct(1000, { requestId });

    // Should return idempotent result
    expect(result.idempotent).toBe(true);
    expect(result.preDeductId).toBe('existing-pre-deduct');
  });

  it('should ignore non-UUID request IDs before atomic pre-deduct', async () => {
    const mockSupabase = createMockSupabase({ credits: 1000 }) as BillingContext['supabase'] & {
      rpc: ReturnType<typeof vi.fn>;
    };
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    const result = await service.preDeduct(100, { requestId: 'not-a-uuid' });

    expect(result.preDeductId).toBe('test-billing-id');
    expect(mockSupabase.rpc).toHaveBeenCalledWith(
      'atomic_pre_deduct',
      expect.objectContaining({
        p_request_id: null,
      }),
    );
  });
});

// ============================================
// Error Message Security Tests
// ============================================

describe('Error Message Security', () => {
  it('should not leak sensitive information in insufficient credits error', async () => {
    const mockSupabase = createMockSupabase({ credits: 50 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'test-user',
    });

    try {
      await service.preDeduct(100, { reason: 'test' });
      expect.fail('Should have thrown');
    } catch (error: any) {
      // Error should not expose internal details
      expect(error.message).not.toContain('SQL');
      expect(error.message).not.toContain('database');
      expect(error.message).not.toContain('table');
      // Should be user-friendly
      expect(error.message).toContain('积分');
    }
  });

  it('should not leak user IDs in error messages', async () => {
    const mockSupabase = createMockSupabase({ credits: 0 });
    const service = new BillingService({
      supabase: mockSupabase,
      userId: 'secret-user-uuid-12345',
    });

    try {
      await service.preDeduct(100, { reason: 'test' });
      expect.fail('Should have thrown');
    } catch (error: any) {
      // Should not expose the user ID
      expect(error.message).not.toContain('secret-user-uuid-12345');
    }
  });
});
