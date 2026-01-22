/**
 * Rate Limiter Service
 *
 * 支持内存和 Redis 两种存储后端的速率限制器
 * 生产环境推荐使用 Redis 以支持分布式部署
 */

import { TRPCError } from '@trpc/server';
import Redis from 'ioredis';

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
  /** Redis 连接配置 (可选，不提供则使用内存存储) */
  redis?: {
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    url?: string;
  };
  /** 速率限制配置 */
  configs: Record<string, RateLimitConfig>;
  /** 键前缀 */
  keyPrefix?: string;
}

// ============================================
// 抽象存储接口
// ============================================

interface RateLimitStore {
  /** 增加计数并检查是否超限 */
  increment(key: string, windowMs: number): Promise<{ count: number; resetTime: number }>;
  /** 清理过期数据 */
  cleanup?(): Promise<void>;
  /** 关闭连接 */
  close?(): Promise<void>;
}

// ============================================
// 内存存储实现
// ============================================

class MemoryStore implements RateLimitStore {
  private store = new Map<string, { count: number; resetTime: number }>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // 每分钟清理一次过期数据
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetTime: number }> {
    const now = Date.now();
    const record = this.store.get(key);

    if (!record || now > record.resetTime) {
      // 新窗口
      const newRecord = {
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

  async cleanup(): Promise<void> {
    const now = Date.now();
    for (const [key, record] of this.store.entries()) {
      if (now > record.resetTime) {
        this.store.delete(key);
      }
    }
  }

  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

// ============================================
// Redis 存储实现
// ============================================

class RedisStore implements RateLimitStore {
  private client: Redis;
  private keyPrefix: string;

  constructor(options: RateLimiterOptions['redis'], keyPrefix: string = 'ratelimit:') {
    this.keyPrefix = keyPrefix;

    if (options?.url) {
      this.client = new Redis(options.url);
    } else {
      this.client = new Redis({
        host: options?.host ?? 'localhost',
        port: options?.port ?? 6379,
        password: options?.password,
        db: options?.db ?? 0,
        lazyConnect: true,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
          if (times > 3) return null;
          return Math.min(times * 100, 3000);
        },
      });
    }

    // 错误处理
    this.client.on('error', (err) => {
      console.error('[RateLimiter] Redis connection error:', err.message);
    });
  }

  /**
   * 使用 Lua 脚本实现原子性的计数器递增
   * 滑动窗口算法
   */
  private readonly incrementScript = `
    local key = KEYS[1]
    local window_ms = tonumber(ARGV[1])
    local now = tonumber(ARGV[2])

    -- 获取当前记录
    local data = redis.call('GET', key)

    if data then
      local record = cjson.decode(data)
      if now > record.resetTime then
        -- 窗口已过期，重置
        record = { count = 1, resetTime = now + window_ms }
      else
        -- 增加计数
        record.count = record.count + 1
      end
      redis.call('SET', key, cjson.encode(record))
      redis.call('PEXPIRE', key, window_ms)
      return cjson.encode(record)
    else
      -- 新记录
      local record = { count = 1, resetTime = now + window_ms }
      redis.call('SET', key, cjson.encode(record))
      redis.call('PEXPIRE', key, window_ms)
      return cjson.encode(record)
    end
  `;

  async increment(key: string, windowMs: number): Promise<{ count: number; resetTime: number }> {
    const fullKey = this.keyPrefix + key;
    const now = Date.now();

    try {
      const result = await this.client.eval(
        this.incrementScript,
        1,
        fullKey,
        windowMs.toString(),
        now.toString()
      ) as string;

      return JSON.parse(result);
    } catch (error) {
      // Redis 不可用时，降级到允许请求 (fail-open)
      console.warn('[RateLimiter] Redis error, allowing request:', error);
      return { count: 1, resetTime: now + windowMs };
    }
  }

  async close(): Promise<void> {
    await this.client.quit();
  }
}

// ============================================
// 速率限制器主类
// ============================================

export class RateLimiter {
  private store: RateLimitStore;
  private configs: Record<string, RateLimitConfig>;
  private keyPrefix: string;

  constructor(options: RateLimiterOptions) {
    this.configs = options.configs;
    this.keyPrefix = options.keyPrefix ?? 'ratelimit:';

    // 根据配置选择存储后端
    if (options.redis) {
      this.store = new RedisStore(options.redis, this.keyPrefix);
      console.log('[RateLimiter] Using Redis store');
    } else {
      this.store = new MemoryStore();
      console.log('[RateLimiter] Using Memory store (not recommended for production)');
    }
  }

  /**
   * 检查速率限制
   *
   * @param identifier - 用户标识 (通常是 userId)
   * @param type - 限制类型 (如 'ai', 'ai_stream')
   * @returns 速率限制结果
   */
  async check(identifier: string, type: string): Promise<RateLimitResult> {
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

    const key = `${type}:${identifier}`;
    const { count, resetTime } = await this.store.increment(key, config.windowMs);

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
  async checkOrThrow(identifier: string, type: string): Promise<RateLimitResult> {
    const result = await this.check(identifier, type);

    if (!result.allowed) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `请求过于频繁，请在 ${result.retryAfter} 秒后重试`,
      });
    }

    return result;
  }

  /**
   * 关闭速率限制器
   */
  async close(): Promise<void> {
    await this.store.close?.();
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
    // 从环境变量读取 Redis 配置
    const redisUrl = process.env.REDIS_URL;
    const redisHost = process.env.REDIS_HOST;
    const redisPort = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : undefined;
    const redisPassword = process.env.REDIS_PASSWORD;
    const redisDb = process.env.REDIS_DB ? parseInt(process.env.REDIS_DB, 10) : undefined;

    const redisConfig = redisUrl || redisHost
      ? {
          url: redisUrl,
          host: redisHost,
          port: redisPort,
          password: redisPassword,
          db: redisDb,
        }
      : undefined;

    rateLimiterInstance = new RateLimiter({
      redis: redisConfig,
      configs: DEFAULT_RATE_LIMIT_CONFIGS,
      keyPrefix: 'graylum:ratelimit:',
    });
  }

  return rateLimiterInstance;
}

/**
 * 检查速率限制 (便捷函数)
 */
export async function checkRateLimitWithRedis(
  userId: string,
  type: string = 'ai'
): Promise<void> {
  const limiter = getRateLimiter();
  await limiter.checkOrThrow(userId, type);
}

export default RateLimiter;
