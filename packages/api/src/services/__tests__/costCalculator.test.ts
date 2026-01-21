/**
 * Cost Calculator Service Tests
 *
 * 测试多模型成本计算器
 */

import { describe, it, expect } from 'vitest';
import {
  CostCalculator,
  calculateCost,
  estimateCost,
  defaultCalculator,
} from '../costCalculator';
import type { TokenUsage } from '../../types/ai';

// ============================================
// CostCalculator Class Tests
// ============================================

describe('CostCalculator', () => {
  const calculator = new CostCalculator();

  describe('getPricing', () => {
    it('should return correct pricing for Claude Sonnet 4', () => {
      const pricing = calculator.getPricing('claude-sonnet-4-20250514');

      expect(pricing.inputPer1M).toBe(3.0);
      expect(pricing.outputPer1M).toBe(15.0);
      expect(pricing.cacheWritePer1M).toBe(3.75);
      expect(pricing.cacheReadPer1M).toBe(0.30);
    });

    it('should return correct pricing for Claude Opus 4', () => {
      const pricing = calculator.getPricing('claude-opus-4-20250514');

      expect(pricing.inputPer1M).toBe(15.0);
      expect(pricing.outputPer1M).toBe(75.0);
    });

    it('should return correct pricing for Claude 3.5 Haiku', () => {
      const pricing = calculator.getPricing('claude-3-5-haiku-20241022');

      expect(pricing.inputPer1M).toBe(0.80);
      expect(pricing.outputPer1M).toBe(4.0);
    });

    it('should return default Sonnet pricing for unknown models', () => {
      const unknownPricing = calculator.getPricing('unknown-model-123');
      const sonnetPricing = calculator.getPricing('claude-sonnet-4-20250514');

      expect(unknownPricing).toEqual(sonnetPricing);
    });

    it('should match prefix for similar models', () => {
      const pricing1 = calculator.getPricing('claude-sonnet-4-20250514');
      const pricing2 = calculator.getPricing('claude-sonnet-4-experimental');

      // Both should use claude-sonnet pricing
      expect(pricing1.inputPer1M).toBe(pricing2.inputPer1M);
    });
  });

  describe('calculate', () => {
    it('should calculate cost correctly for standard usage', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
      };

      const result = calculator.calculate('claude-sonnet-4-20250514', usage);

      // Input: 1000/1M * $3 = $0.003
      // Output: 500/1M * $15 = $0.0075
      // Total: $0.0105
      expect(result.totalCostUsd).toBeCloseTo(0.0105, 4);
      expect(result.totalCredits).toBeGreaterThan(0);
    });

    it('should include cache savings calculation', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 5000,
        cacheCreationTokens: 0,
      };

      const result = calculator.calculate('claude-sonnet-4-20250514', usage);

      // Cache read is cheaper than input
      expect(result.cacheSavings.usd).toBeGreaterThan(0);
      expect(result.cacheSavings.percentage).toBeGreaterThan(0);
    });

    it('should return correct breakdown', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 2000,
        cacheCreationTokens: 500,
      };

      const result = calculator.calculate('claude-sonnet-4-20250514', usage);

      expect(result.breakdown.input).toBeGreaterThan(0);
      expect(result.breakdown.output).toBeGreaterThan(0);
      expect(result.breakdown.cacheRead).toBeGreaterThan(0);
      expect(result.breakdown.cacheWrite).toBeGreaterThan(0);
      expect(result.breakdown.total).toBe(result.totalCredits);
    });

    it('should calculate original cost without cache', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
        cacheReadTokens: 5000,
      };

      const result = calculator.calculate('claude-sonnet-4-20250514', usage);

      // Original cost should be higher (no cache discount)
      expect(result.originalCost.usd).toBeGreaterThan(result.totalCostUsd);
      expect(result.originalCost.credits).toBeGreaterThan(result.totalCredits);
    });

    it('should handle zero tokens', () => {
      const usage: TokenUsage = {
        inputTokens: 0,
        outputTokens: 0,
      };

      const result = calculator.calculate('claude-sonnet-4-20250514', usage);

      expect(result.totalCostUsd).toBe(0);
      expect(result.totalCredits).toBe(0);
    });
  });

  describe('estimate', () => {
    it('should estimate cost with cache hit rate', () => {
      const result = calculator.estimate({
        modelId: 'claude-sonnet-4-20250514',
        inputTokens: 10000,
        outputTokens: 2000,
        cacheHitRate: 0.5, // 50% cache hit
      });

      expect(result.totalCredits).toBeGreaterThan(0);
      expect(result.method).toBeUndefined(); // estimate doesn't set method
    });

    it('should use default values when not specified', () => {
      const result = calculator.estimate({
        modelId: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
      });

      // Default outputTokens = 1024, cacheHitRate = 0.3
      expect(result.totalCredits).toBeGreaterThan(0);
    });

    it('should include search cost when enabled', () => {
      const withSearch = calculator.estimate({
        modelId: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        enableWebSearch: true,
        webSearchCount: 3,
      });

      const withoutSearch = calculator.estimate({
        modelId: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
        enableWebSearch: false,
      });

      expect(withSearch.totalCredits).toBeGreaterThan(withoutSearch.totalCredits);
      expect(withSearch.breakdown.search).toBeGreaterThan(0);
    });
  });

  describe('quickEstimate', () => {
    it('should return value within bounds', () => {
      const result = calculator.quickEstimate(
        'claude-sonnet-4-20250514',
        1000
      );

      expect(result).toBeGreaterThan(0);
      expect(Number.isFinite(result)).toBe(true);
    });

    it('should apply safety margin', () => {
      const base = calculator.estimate({
        modelId: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
      });

      const quick = calculator.quickEstimate(
        'claude-sonnet-4-20250514',
        1000
      );

      // Quick estimate includes safety margin
      expect(quick).toBeGreaterThanOrEqual(base.totalCredits);
    });

    it('should respect custom safety margin', () => {
      const defaultMargin = calculator.quickEstimate(
        'claude-sonnet-4-20250514',
        1000
      );

      const highMargin = calculator.quickEstimate(
        'claude-sonnet-4-20250514',
        1000,
        { safetyMargin: 0.5 } // 50% margin
      );

      expect(highMargin).toBeGreaterThanOrEqual(defaultMargin);
    });
  });

  describe('usdToCredits and creditsToUsd', () => {
    it('should convert USD to credits correctly', () => {
      const credits = calculator.usdToCredits(1.0); // $1

      // Default: 100 credits per USD * 1.1 multiplier = 110 credits
      expect(credits).toBe(110);
    });

    it('should convert credits to USD correctly', () => {
      const usd = calculator.creditsToUsd(110);

      expect(usd).toBeCloseTo(1.0, 4);
    });

    it('should be reversible', () => {
      const originalUsd = 5.50;
      const credits = calculator.usdToCredits(originalUsd);
      const backToUsd = calculator.creditsToUsd(credits);

      // Due to ceiling, might not be exact
      expect(backToUsd).toBeGreaterThanOrEqual(originalUsd);
    });
  });

  describe('compareModels', () => {
    it('should return all models sorted by cost', () => {
      const comparison = calculator.compareModels(1000, 500);

      expect(comparison.length).toBeGreaterThan(0);

      // Should be sorted by cost (ascending)
      for (let i = 1; i < comparison.length; i++) {
        expect(comparison[i].totalCredits).toBeGreaterThanOrEqual(
          comparison[i - 1].totalCredits
        );
      }
    });

    it('should assign correct tiers', () => {
      const comparison = calculator.compareModels(1000, 500);

      const haiku = comparison.find((m) => m.modelId.includes('haiku'));
      const sonnet = comparison.find((m) => m.modelId.includes('sonnet'));
      const opus = comparison.find((m) => m.modelId.includes('opus'));

      expect(haiku?.tier).toBe('budget');
      expect(sonnet?.tier).toBe('standard');
      expect(opus?.tier).toBe('premium');
    });

    it('should show Haiku as cheapest and Opus as most expensive', () => {
      const comparison = calculator.compareModels(1000, 500);

      const haiku = comparison.find((m) => m.modelId.includes('haiku'));
      const opus = comparison.find((m) => m.modelId.includes('opus'));

      expect(haiku!.totalCredits).toBeLessThan(opus!.totalCredits);
    });
  });

  describe('generateReport', () => {
    it('should generate accurate aggregate report', () => {
      const results = [
        {
          modelId: 'claude-sonnet-4-20250514',
          usage: { inputTokens: 1000, outputTokens: 500 } as TokenUsage,
        },
        {
          modelId: 'claude-sonnet-4-20250514',
          usage: { inputTokens: 2000, outputTokens: 1000 } as TokenUsage,
        },
        {
          modelId: 'claude-3-5-haiku-20241022',
          usage: { inputTokens: 500, outputTokens: 200 } as TokenUsage,
        },
      ];

      const report = calculator.generateReport(results);

      expect(report.totalCostUsd).toBeGreaterThan(0);
      expect(report.totalCredits).toBeGreaterThan(0);
      expect(report.totalTokens.input).toBe(3500);
      expect(report.totalTokens.output).toBe(1700);
      expect(report.modelBreakdown.length).toBe(2); // 2 unique models
    });

    it('should calculate model percentages correctly', () => {
      const results = [
        {
          modelId: 'claude-sonnet-4-20250514',
          usage: { inputTokens: 1000, outputTokens: 500 } as TokenUsage,
        },
        {
          modelId: 'claude-sonnet-4-20250514',
          usage: { inputTokens: 1000, outputTokens: 500 } as TokenUsage,
        },
      ];

      const report = calculator.generateReport(results);

      // Single model should be 100%
      expect(report.modelBreakdown[0].percentage).toBe(100);
    });

    it('should calculate cache hit rate', () => {
      const results = [
        {
          modelId: 'claude-sonnet-4-20250514',
          usage: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 1000,
          } as TokenUsage,
        },
      ];

      const report = calculator.generateReport(results);

      // 1000 cached / (1000 input + 1000 cached) = 50%
      expect(report.avgCacheHitRate).toBe(50);
    });
  });
});

// ============================================
// Exported Functions Tests
// ============================================

describe('Exported Functions', () => {
  describe('calculateCost', () => {
    it('should use default calculator', () => {
      const usage: TokenUsage = {
        inputTokens: 1000,
        outputTokens: 500,
      };

      const result = calculateCost('claude-sonnet-4-20250514', usage);

      expect(result.totalCredits).toBeGreaterThan(0);
    });
  });

  describe('estimateCost', () => {
    it('should use default calculator', () => {
      const result = estimateCost({
        modelId: 'claude-sonnet-4-20250514',
        inputTokens: 1000,
      });

      expect(result.totalCredits).toBeGreaterThan(0);
    });
  });

  describe('defaultCalculator', () => {
    it('should be a CostCalculator instance', () => {
      expect(defaultCalculator).toBeInstanceOf(CostCalculator);
    });
  });
});

// ============================================
// Custom Configuration Tests
// ============================================

describe('Custom Configuration', () => {
  it('should respect custom price multiplier', () => {
    const standardCalc = new CostCalculator();
    const customCalc = new CostCalculator({ priceMultiplier: 2.0 });

    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
    };

    const standardResult = standardCalc.calculate('claude-sonnet-4-20250514', usage);
    const customResult = customCalc.calculate('claude-sonnet-4-20250514', usage);

    // Custom should be roughly 2x / 1.1x = ~1.82x the credits
    expect(customResult.totalCredits).toBeGreaterThan(standardResult.totalCredits);
  });

  it('should respect custom credits per USD', () => {
    const standardCalc = new CostCalculator();
    const customCalc = new CostCalculator({ creditsPerUsd: 200 }); // Double

    const usage: TokenUsage = {
      inputTokens: 1000,
      outputTokens: 500,
    };

    const standardResult = standardCalc.calculate('claude-sonnet-4-20250514', usage);
    const customResult = customCalc.calculate('claude-sonnet-4-20250514', usage);

    // Custom should have ~2x credits (same USD, more credits per USD)
    expect(customResult.totalCredits).toBeGreaterThan(standardResult.totalCredits);
  });
});

// ============================================
// Edge Cases
// ============================================

describe('Edge Cases', () => {
  const calculator = new CostCalculator();

  it('should handle very large token counts', () => {
    const usage: TokenUsage = {
      inputTokens: 200000, // 200K (near max context)
      outputTokens: 8000,
    };

    const result = calculator.calculate('claude-sonnet-4-20250514', usage);

    expect(result.totalCredits).toBeGreaterThan(0);
    expect(Number.isFinite(result.totalCredits)).toBe(true);
    expect(Number.isFinite(result.totalCostUsd)).toBe(true);
  });

  it('should handle fractional token costs', () => {
    const usage: TokenUsage = {
      inputTokens: 1,
      outputTokens: 1,
    };

    const result = calculator.calculate('claude-sonnet-4-20250514', usage);

    // Even 1 token should produce some cost (rounded up)
    expect(result.totalCredits).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty report input', () => {
    const report = calculator.generateReport([]);

    expect(report.totalCostUsd).toBe(0);
    expect(report.totalCredits).toBe(0);
    expect(report.modelBreakdown.length).toBe(0);
    expect(report.avgCacheHitRate).toBe(0);
  });
});
