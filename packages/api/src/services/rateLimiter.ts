/**
 * Rate Limiter Service
 *
 * 内存速率限制器，适用于单实例部署
 *
 * 生产环境分布式部署建议:
 * - 使用 Vercel KV (基于 Upstash Redis)
 * - 或使用 Upstash Rate Limit (@upstash/ratelimit)
 * - 或在独立的 Node.js 服务中使用 ioredis
 *
 * @see https://vercel.com/docs/storage/vercel-kv
 * @see https://github.com/upstash/ratelimit
 */

import { TRPCError } from '@trpc/server';

// ============================================
// 类型定义
// ============================================

export interface RateLimitConfig {
  /** 窗口时间内允许的最大请求数 */
  maxRequests: number;
  /** 时间窗口 (毫秒) */
  windowMs: number;
}

export interface RateLimitResult {
  /** 是否允许请求 */
  allowed: boolean;
  /** 当前请求数 */
  current: number;
  /** 最大允许请求数 */
  limit: number;
  /** 剩余请求数 */
  remaining: number;
  /** 窗口重置时间 (Unix 时间戳，毫秒) */
  resetTime: number;
  /** 重试等待时间 (秒) */
  retryAfter?: number;
}

export interface RateLimiterOptions {
  /** 速率限制配置 */
  configs: Record<string, RateLimitConfig>;
  /** 键前缀 */
  keyPrefix?: string;
}

// ============================================
// 内存存储实现
// ============================================

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

class MemoryStore {
  private store = new Map<string, RateLimitRecord>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 每分钟清理一次过期数据
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  increment(key: string, windowMs: number): RateLimitRecord {
    const now = Date.now();
    const record = this.store.get(key);

    if (!record || now > record.resetTime) {
      // 新窗口
      const newRecord: RateLimitRecord = {
        count: 1,
        resetTime: now + windowMs,
      };
      this.store.set(key, newRecord);
      return newRecord;
    }

    // 增加计数
    record.count += 1;
    return { count: record.count, resetTime: record.resetTime };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.store.entries()) {
      if (now > record.resetTime) {
        this.store.delete(key);
      }
    }
  }

  close(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }

  /** 获取当前存储大小 (用于监控) */
  get size(): number {
    return this.store.size;
  }
}

// ============================================
// 速率限制器主类
// ============================================

export class RateLimiter {
  private store: MemoryStore;
  private configs: Record<string, RateLimitConfig>;
  private keyPrefix: string;

  constructor(options: RateLimiterOptions) {
    this.configs = options.configs;
    this.keyPrefix = options.keyPrefix ?? 'ratelimit:';
    this.store = new MemoryStore();
  }

  /**
   * 检查速率限制
   *
   * @param identifier - 用户标识 (通常是 userId)
   * @param type - 限制类型 (如 'ai', 'ai_stream')
   * @returns 速率限制结果
   */
  check(identifier: string, type: string): RateLimitResult {
    const config = this.configs[type];

    if (!config) {
      // 未配置的类型，允许通过
      return {
        allowed: true,
        current: 0,
        limit: Infinity,
        remaining: Infinity,
        resetTime: 0,
      };
    }

    const key = `${this.keyPrefix}${type}:${identifier}`;
    const { count, resetTime } = this.store.increment(key, config.windowMs);

    const allowed = count <= config.maxRequests;
    const remaining = Math.max(0, config.maxRequests - count);
    const retryAfter = allowed ? undefined : Math.ceil((resetTime - Date.now()) / 1000);

    return {
      allowed,
      current: count,
      limit: config.maxRequests,
      remaining,
      resetTime,
      retryAfter,
    };
  }

  /**
   * 检查速率限制并抛出异常
   *
   * @param identifier - 用户标识
   * @param type - 限制类型
   * @throws TRPCError 当超过限制时
   */
  checkOrThrow(identifier: string, type: string): RateLimitResult {
    const result = this.check(identifier, type);

    if (!result.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `请求过于频繁，请在 ${result.retryAfter} 秒后重试`,
      });
    }

    return result;
  }

  /**
   * 获取当前存储大小 (用于监控)
   */
  getStoreSize(): number {
    return this.store.size;
  }

  /**
   * 关闭速率限制器
   */
  close(): void {
    this.store.close();
  }
}

// ============================================
// 默认配置
// ============================================

export const DEFAULT_RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  ai: {
    maxRequests: 60, // 每分钟最多 60 次 AI 请求
    windowMs: 60 * 1000,
  },
  ai_stream: {
    maxRequests: 30, // 流式请求限制更严格
    windowMs: 60 * 1000,
  },
  api: {
    maxRequests: 100, // 通用 API 限制
    windowMs: 60 * 1000,
  },
  auth: {
    maxRequests: 10, // 认证相关请求限制
    windowMs: 60 * 1000,
  },
};

// ============================================
// 单例实例
// ============================================

let rateLimiterInstance: RateLimiter | null = null;

/**
 * 获取或创建速率限制器实例
 */
export function getRateLimiter(): RateLimiter {
  if (!rateLimiterInstance) {
    rateLimiterInstance = new RateLimiter({
      configs: DEFAULT_RATE_LIMIT_CONFIGS,
      keyPrefix: 'graylum:ratelimit:',
    });
  }

  return rateLimiterInstance;
}

/**
 * 检查速率限制 (便捷函数)
 */
export function checkRateLimitWithRedis(
  userId: string,
  type: string = 'ai'
): void {
  const limiter = getRateLimiter();
  limiter.checkOrThrow(userId, type);
}

export default RateLimiter;
