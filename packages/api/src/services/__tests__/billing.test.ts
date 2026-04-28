/**
 * Billing Service Tests
 *
 * 测试三段式计费服务: 预扣 → 结算 → 退费
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  calculateTokenCost,
  calculateTokenCostWithPricing,
  estimateRequestCost,
  getModelPricing,
  BillingService,
  type BillingContext,
} from '../billing';
import { BILLING_CONSTANTS } from '../../types/billing';

// ============================================
// Mock Supabase Client
// ============================================

function createMockSupabase(options: {
  credits?: number;
  updatedAt?: string;
  insertedId?: string;
  shouldFailUpdate?: boolean;
}) {
  const {
    credits = 10000,
    updatedAt = new Date().toISOString(),
    insertedId = 'test-billing-id',
    shouldFailUpdate = false,
  } = options;

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
          return Promise.resolve({
            data: { credits, updated_at: updatedAt },
            error: null,
          });
        }
        if (table === 'billing_history') {
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
  } as unknown as BillingContext['supabase'];
}

// ============================================
// calculateTokenCost Tests
// ============================================

describe('calculateTokenCost', () => {
  it('should calculate cost correctly for Sonnet model', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 500,
    };

    const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

    // Sonnet: $3/1M input, $15/1M output
    // Input: 1000/1M * $3 = $0.003
    // Output: 500/1M * $15 = $0.0075
    // Total: $0.0105 * 100 (credits/usd) * 1.1 (multiplier) = ~1.155 credits
    expect(result.credits).toBeGreaterThan(0);
    expect(result.costUsd).toBeCloseTo(0.0105, 4);
    expect(result.breakdown.input).toBeGreaterThan(0);
    expect(result.breakdown.output).toBeGreaterThan(0);
  });

  it('should calculate cost correctly for Haiku model', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 500,
    };

    const result = calculateTokenCost('claude-3-5-haiku-20241022', usage);

    // Haiku: $0.80/1M input, $4/1M output
    // Input: 1000/1M * $0.80 = $0.0008
    // Output: 500/1M * $4 = $0.002
    // Total: $0.0028
    expect(result.costUsd).toBeCloseTo(0.0028, 4);
    expect(result.credits).toBeLessThan(
      calculateTokenCost('claude-sonnet-4-20250514', usage).credits
    );
  });

  it('should include cache costs when present', () => {
    const usageWithCache = {
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 2000,
      cacheCreationTokens: 500,
    };

    const usageWithoutCache = {
      inputTokens: 1000,
      outputTokens: 500,
    };

    const resultWithCache = calculateTokenCost('claude-sonnet-4-20250514', usageWithCache);
    const resultWithoutCache = calculateTokenCost('claude-sonnet-4-20250514', usageWithoutCache);

    expect(resultWithCache.breakdown.cacheRead).toBeGreaterThan(0);
    expect(resultWithCache.breakdown.cacheWrite).toBeGreaterThan(0);
    expect(resultWithCache.costUsd).toBeGreaterThan(resultWithoutCache.costUsd);
  });

  it('should handle zero tokens', () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
    };

    const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

    expect(result.credits).toBe(0);
    expect(result.costUsd).toBe(0);
  });

  it('should fall back to default pricing for unknown models', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 500,
    };

    const resultUnknown = calculateTokenCost('unknown-model', usage);
    const resultSonnet = calculateTokenCost('claude-sonnet-4-20250514', usage);

    // Unknown model should use Sonnet pricing as fallback
    expect(resultUnknown.credits).toBe(resultSonnet.credits);
  });
});

// ============================================
// estimateRequestCost Tests
// ============================================

describe('estimateRequestCost', () => {
  it('should return value within min/max bounds', () => {
    const result = estimateRequestCost('claude-sonnet-4-20250514', 100);

    expect(result).toBeGreaterThanOrEqual(BILLING_CONSTANTS.MIN_PRE_DEDUCT);
    expect(result).toBeLessThanOrEqual(BILLING_CONSTANTS.MAX_PRE_DEDUCT);
  });

  it('should include safety margin', () => {
    const inputTokens = 10000;
    const outputTokens = 4096;

    const baseResult = calculateTokenCost('claude-sonnet-4-20250514', {
      inputTokens,
      outputTokens,
    });

    const estimated = estimateRequestCost('claude-sonnet-4-20250514', inputTokens, outputTokens);

    // Should be at least base cost * (1 + safety margin)
    const expectedMin = Math.ceil(baseResult.credits * (1 + BILLING_CONSTANTS.SAFETY_MARGIN));
    expect(estimated).toBeGreaterThanOrEqual(Math.max(BILLING_CONSTANTS.MIN_PRE_DEDUCT, expectedMin));
  });

  it('should use default output tokens when not specified', () => {
    const result1 = estimateRequestCost('claude-sonnet-4-20250514', 1000);
    const result2 = estimateRequestCost('claude-sonnet-4-20250514', 1000, 4096);

    expect(result1).toBe(result2);
  });
});

describe('getModelPricing', () => {
  it('reads ai_models pricing fields as micro-dollars', async () => {
    const supabase = {
      from(table: string) {
        expect(table).toBe('ai_models');
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          single() {
            return Promise.resolve({
              data: {
                input_token_cost: 3_000_000,
                output_token_cost: 15_000_000,
                web_search_cost: 10_000_000,
              },
              error: null,
            });
          },
        };
      },
    } as unknown as BillingContext['supabase'];

    const pricing = await getModelPricing(supabase, 'unit-test-micro-dollar-model');

    expect(pricing.inputPer1M).toBe(3);
    expect(pricing.outputPer1M).toBe(15);
    expect(pricing.searchPer1K).toBe(10);
  });

  it('reads fresh ai_models pricing on each call instead of returning stale cached values', async () => {
    const rows = [
      {
        input_token_cost: 100,
        output_token_cost: 500,
        web_search_cost: 0,
      },
      {
        input_token_cost: 1_000_000,
        output_token_cost: 5_000_000,
        web_search_cost: 10_000_000,
      },
    ];

    let callCount = 0;
    const supabase = {
      from(table: string) {
        expect(table).toBe('ai_models');
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          single() {
            const data = rows[callCount] ?? rows[rows.length - 1];
            callCount += 1;
            return Promise.resolve({ data, error: null });
          },
        };
      },
    } as unknown as BillingContext['supabase'];

    const first = await getModelPricing(supabase, 'anthropic/claude-haiku-4.5');
    const second = await getModelPricing(supabase, 'anthropic/claude-haiku-4.5');

    expect(first.inputPer1M).toBe(0.0001);
    expect(first.outputPer1M).toBe(0.0005);
    expect(second.inputPer1M).toBe(1);
    expect(second.outputPer1M).toBe(5);
    expect(second.searchPer1K).toBe(10);
    expect(callCount).toBe(2);
  });
});

describe('calculateTokenCostWithPricing', () => {
  it('charges 3 credits for 50 input and 291 output tokens at $1/$5 per 1M', () => {
    const result = calculateTokenCostWithPricing(
      {
        inputTokens: 50,
        outputTokens: 291,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        inputPer1M: 1,
        outputPer1M: 5,
        searchPer1K: 10,
      },
    );

    expect(result.costUsd).toBeCloseTo(0.001505, 12);
    expect(result.credits).toBe(3);
  });
});

// ============================================
// BillingService Tests
// ============================================

describe('BillingService', () => {
  describe('getBalance', () => {
    it('should return user credits', async () => {
      const mockSupabase = createMockSupabase({ credits: 5000 });
      const service = new BillingService({
        supabase: mockSupabase,
        userId: 'test-user',
      });

      const balance = await service.getBalance();

      expect(balance).toBe(5000);
    });
  });

  describe('preDeduct', () => {
    it('should throw InsufficientCreditsError when balance is insufficient', async () => {
      const mockSupabase = createMockSupabase({ credits: 100 });
      const service = new BillingService({
        supabase: mockSupabase,
        userId: 'test-user',
      });

      await expect(service.preDeduct(500, 'test')).rejects.toThrow(
        '积分不足'
      );
    });
  });
});

// ============================================
// Edge Cases
// ============================================

describe('Edge Cases', () => {
  it('should handle very large token counts', () => {
    const usage = {
      inputTokens: 200000, // 200K context
      outputTokens: 8000,
    };

    const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

    expect(result.credits).toBeGreaterThan(0);
    expect(Number.isFinite(result.credits)).toBe(true);
  });

  it('should handle negative token counts gracefully', () => {
    const usage = {
      inputTokens: -100,
      outputTokens: 500,
    };

    const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

    // Should still calculate, even if negative (edge case protection)
    expect(Number.isFinite(result.credits)).toBe(true);
  });

  it('should maintain precision for small costs', () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 5,
    };

    const result = calculateTokenCost('claude-sonnet-4-20250514', usage);

    // Even small usage should produce non-zero cost
    expect(result.costUsd).toBeGreaterThan(0);
  });
});
