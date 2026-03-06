/**
 * Cost Calculator
 *
 * 成本计算服务
 * 精确计算 AI 调用成本，支持多模型、缓存优化
 */

import type { TokenUsage, CostBreakdown } from '../types/ai';
import { BILLING_CONSTANTS, MODEL_PRICING, type SupportedModelId } from '../types/billing';

// ============================================
// 类型定义
// ============================================

export interface ModelPricingConfig {
  inputPer1M: number;     // 输入 Token 每百万价格 (美元)
  outputPer1M: number;    // 输出 Token 每百万价格 (美元)
  cacheWritePer1M?: number; // 缓存写入每百万价格
  cacheReadPer1M?: number;  // 缓存读取每百万价格
  searchPerRequest?: number; // 每次搜索价格
}

export interface CostCalculationResult {
  /** 总成本 (美元) */
  totalCostUsd: number;
  /** 总积分 */
  totalCredits: number;
  /** 成本明细 */
  breakdown: CostBreakdown;
  /** 缓存节省 */
  cacheSavings: {
    usd: number;
    credits: number;
    percentage: number;
  };
  /** 原始成本 (不含缓存优化) */
  originalCost: {
    usd: number;
    credits: number;
  };
}

export interface EstimationParams {
  modelId: string;
  inputTokens: number;
  outputTokens?: number;
  enableWebSearch?: boolean;
  webSearchCount?: number;
  cacheHitRate?: number; // 预估缓存命中率 0-1
}

// ============================================
// 常量
// ============================================

/**
 * 默认预估参数
 */
const DEFAULT_ESTIMATION = {
  outputTokens: 1024,
  cacheHitRate: 0.3, // 30% 缓存命中率
  webSearchCost: 0.003, // $0.003/次搜索
};

/**
 * 扩展的模型定价表
 */
const EXTENDED_MODEL_PRICING: Record<string, ModelPricingConfig> = {
  // Claude 4 系列
  'claude-sonnet-4-20250514': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.30,
  },
  'claude-opus-4-20250514': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheWritePer1M: 18.75,
    cacheReadPer1M: 1.50,
  },
  // Claude 3.5 系列
  'claude-3-5-haiku-20241022': {
    inputPer1M: 0.80,
    outputPer1M: 4.0,
    cacheWritePer1M: 1.0,
    cacheReadPer1M: 0.08,
  },
  'claude-3-5-sonnet-20241022': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.30,
  },
  // Claude 3 系列 (兼容)
  'claude-3-opus-20240229': {
    inputPer1M: 15.0,
    outputPer1M: 75.0,
    cacheWritePer1M: 18.75,
    cacheReadPer1M: 1.50,
  },
  'claude-3-sonnet-20240229': {
    inputPer1M: 3.0,
    outputPer1M: 15.0,
    cacheWritePer1M: 3.75,
    cacheReadPer1M: 0.30,
  },
  'claude-3-haiku-20240307': {
    inputPer1M: 0.25,
    outputPer1M: 1.25,
    cacheWritePer1M: 0.30,
    cacheReadPer1M: 0.03,
  },
};

// ============================================
// Cost Calculator 类
// ============================================

export class CostCalculator {
  private priceMultiplier: number;
  private creditsPerUsd: number;

  constructor(config?: {
    priceMultiplier?: number;
    creditsPerUsd?: number;
  }) {
    this.priceMultiplier = config?.priceMultiplier ?? BILLING_CONSTANTS.TOKEN_PRICE_MULTIPLIER;
    this.creditsPerUsd = config?.creditsPerUsd ?? BILLING_CONSTANTS.CREDITS_PER_USD;
  }

  /**
   * 获取模型定价
   */
  getPricing(modelId: string): ModelPricingConfig {
    // 尝试精确匹配
    if (EXTENDED_MODEL_PRICING[modelId]) {
      return EXTENDED_MODEL_PRICING[modelId];
    }

    // 尝试前缀匹配
    for (const [key, pricing] of Object.entries(EXTENDED_MODEL_PRICING)) {
      if (modelId.startsWith(key.split('-').slice(0, 2).join('-'))) {
        return pricing;
      }
    }

    // 默认使用 Sonnet 定价
    return EXTENDED_MODEL_PRICING['claude-sonnet-4-20250514'];
  }

  /**
   * 计算实际成本
   */
  calculate(modelId: string, usage: TokenUsage): CostCalculationResult {
    const pricing = this.getPricing(modelId);

    // 计算各项成本 (美元)
    const inputCostUsd = (usage.inputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCostUsd = (usage.outputTokens / 1_000_000) * pricing.outputPer1M;

    const cacheWriteCostUsd = pricing.cacheWritePer1M
      ? ((usage.cacheCreationTokens ?? 0) / 1_000_000) * pricing.cacheWritePer1M
      : 0;

    const cacheReadCostUsd = pricing.cacheReadPer1M
      ? ((usage.cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheReadPer1M
      : 0;

    // 总成本
    const totalCostUsd = inputCostUsd + outputCostUsd + cacheWriteCostUsd + cacheReadCostUsd;

    // 计算缓存节省
    // 如果没有缓存，这些 Token 需要按正常输入价格计算
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    const normalInputCostForCached = (cacheReadTokens / 1_000_000) * pricing.inputPer1M;
    const cacheSavingsUsd = normalInputCostForCached - cacheReadCostUsd;

    // 原始成本 (假设没有缓存)
    const originalCostUsd = inputCostUsd + outputCostUsd + normalInputCostForCached;

    // 转换为积分
    const totalCredits = this.usdToCredits(totalCostUsd);
    const originalCredits = this.usdToCredits(originalCostUsd);
    const cacheSavingsCredits = originalCredits - totalCredits;

    // 成本明细
    const breakdown: CostBreakdown = {
      input: this.usdToCredits(inputCostUsd),
      output: this.usdToCredits(outputCostUsd),
      cacheWrite: this.usdToCredits(cacheWriteCostUsd),
      cacheRead: this.usdToCredits(cacheReadCostUsd),
      search: 0,
      total: totalCredits,
    };

    return {
      totalCostUsd,
      totalCredits,
      breakdown,
      cacheSavings: {
        usd: cacheSavingsUsd,
        credits: cacheSavingsCredits,
        percentage: originalCostUsd > 0
          ? Math.round((cacheSavingsUsd / originalCostUsd) * 100)
          : 0,
      },
      originalCost: {
        usd: originalCostUsd,
        credits: originalCredits,
      },
    };
  }

  /**
   * 估算成本 (用于预扣)
   */
  estimate(params: EstimationParams): CostCalculationResult {
    const pricing = this.getPricing(params.modelId);
    const outputTokens = params.outputTokens ?? DEFAULT_ESTIMATION.outputTokens;
    const cacheHitRate = params.cacheHitRate ?? DEFAULT_ESTIMATION.cacheHitRate;

    // 估算缓存命中 Token
    const cacheReadTokens = Math.floor(params.inputTokens * cacheHitRate);
    const normalInputTokens = params.inputTokens - cacheReadTokens;

    // 构造估算的 usage
    const estimatedUsage: TokenUsage = {
      inputTokens: normalInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0, // 首次请求可能会有缓存创建
    };

    // 计算估算成本
    const result = this.calculate(params.modelId, estimatedUsage);

    // 添加搜索成本
    if (params.enableWebSearch && params.webSearchCount) {
      const searchCostUsd = params.webSearchCount * DEFAULT_ESTIMATION.webSearchCost;
      const searchCredits = this.usdToCredits(searchCostUsd);

      result.totalCostUsd += searchCostUsd;
      result.totalCredits += searchCredits;
      result.breakdown.search = searchCredits;
      result.breakdown.total += searchCredits;
    }

    return result;
  }

  /**
   * 快速估算 (返回建议预扣金额)
   */
  quickEstimate(
    modelId: string,
    inputTokens: number,
    options: {
      outputTokens?: number;
      safetyMargin?: number;
    } = {}
  ): number {
    const result = this.estimate({
      modelId,
      inputTokens,
      outputTokens: options.outputTokens,
    });

    const safetyMargin = options.safetyMargin ?? BILLING_CONSTANTS.SAFETY_MARGIN;
    const withMargin = Math.ceil(result.totalCredits * (1 + safetyMargin));

    // 确保在最小和最大预扣范围内
    return Math.max(
      BILLING_CONSTANTS.MIN_PRE_DEDUCT,
      Math.min(BILLING_CONSTANTS.MAX_PRE_DEDUCT, withMargin)
    );
  }

  /**
   * 美元转积分
   */
  usdToCredits(usd: number): number {
    return Math.ceil(usd * this.creditsPerUsd * this.priceMultiplier);
  }

  /**
   * 积分转美元
   */
  creditsToUsd(credits: number): number {
    return credits / (this.creditsPerUsd * this.priceMultiplier);
  }

  /**
   * 获取模型成本对比
   */
  compareModels(
    inputTokens: number,
    outputTokens: number = 1024
  ): Array<{
    modelId: string;
    totalCredits: number;
    totalCostUsd: number;
    tier: 'budget' | 'standard' | 'premium';
  }> {
    const models = Object.keys(EXTENDED_MODEL_PRICING);
    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };

    return models.map((modelId) => {
      const result = this.calculate(modelId, usage);

      // 确定层级
      let tier: 'budget' | 'standard' | 'premium';
      if (modelId.includes('haiku')) {
        tier = 'budget';
      } else if (modelId.includes('opus')) {
        tier = 'premium';
      } else {
        tier = 'standard';
      }

      return {
        modelId,
        totalCredits: result.totalCredits,
        totalCostUsd: result.totalCostUsd,
        tier,
      };
    }).sort((a, b) => a.totalCredits - b.totalCredits);
  }

  /**
   * 生成成本报告
   */
  generateReport(
    results: Array<{
      modelId: string;
      usage: TokenUsage;
    }>
  ): {
    totalCostUsd: number;
    totalCredits: number;
    totalTokens: {
      input: number;
      output: number;
      cached: number;
    };
    cacheSavingsUsd: number;
    cacheSavingsCredits: number;
    avgCacheHitRate: number;
    modelBreakdown: Array<{
      modelId: string;
      requests: number;
      totalCredits: number;
      percentage: number;
    }>;
  } {
    let totalCostUsd = 0;
    let totalCredits = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCachedTokens = 0;
    let totalCacheSavingsUsd = 0;
    let totalCacheSavingsCredits = 0;

    const modelMap = new Map<string, { requests: number; credits: number }>();

    for (const { modelId, usage } of results) {
      const result = this.calculate(modelId, usage);

      totalCostUsd += result.totalCostUsd;
      totalCredits += result.totalCredits;
      totalInputTokens += usage.inputTokens;
      totalOutputTokens += usage.outputTokens;
      totalCachedTokens += usage.cacheReadTokens ?? 0;
      totalCacheSavingsUsd += result.cacheSavings.usd;
      totalCacheSavingsCredits += result.cacheSavings.credits;

      const existing = modelMap.get(modelId) ?? { requests: 0, credits: 0 };
      modelMap.set(modelId, {
        requests: existing.requests + 1,
        credits: existing.credits + result.totalCredits,
      });
    }

    // 计算平均缓存命中率
    const totalInputWithCache = totalInputTokens + totalCachedTokens;
    const avgCacheHitRate = totalInputWithCache > 0
      ? totalCachedTokens / totalInputWithCache
      : 0;

    // 模型分布
    const modelBreakdown = Array.from(modelMap.entries()).map(([modelId, data]) => ({
      modelId,
      requests: data.requests,
      totalCredits: data.credits,
      percentage: totalCredits > 0
        ? Math.round((data.credits / totalCredits) * 100)
        : 0,
    }));

    return {
      totalCostUsd,
      totalCredits,
      totalTokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        cached: totalCachedTokens,
      },
      cacheSavingsUsd: totalCacheSavingsUsd,
      cacheSavingsCredits: totalCacheSavingsCredits,
      avgCacheHitRate: Math.round(avgCacheHitRate * 100),
      modelBreakdown,
    };
  }
}

/**
 * 默认实例
 */
export const defaultCalculator = new CostCalculator();

/**
 * 快速计算成本
 */
export function calculateCost(
  modelId: string,
  usage: TokenUsage
): CostCalculationResult {
  return defaultCalculator.calculate(modelId, usage);
}

/**
 * 快速估算成本
 */
export function estimateCost(params: EstimationParams): CostCalculationResult {
  return defaultCalculator.estimate(params);
}

export default CostCalculator;
