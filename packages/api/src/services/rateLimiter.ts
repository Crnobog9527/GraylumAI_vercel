/**
 * Rate Limiter Service
 *
 * 支持内存和 Redis 两种存储后端的速率限制器
 * 生产环境推荐使用 Redis 以支持分布式部署
 *
 * 注意: Redis 使用动态导入以避免 Next.js 客户端打包问题
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
// Redis 存储实现 (动态加载)
// ============================================

/**
 * Lua 脚本用于原子性的计数器递增
 */
const INCREMENT_SCRIPT = `
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

/**
 * 创建 Redis 存储 (动态导入 ioredis)
 */
async function createRedisStore(
  options: RateLimiterOptions['redis'],
  keyPrefix: string = 'ratelimit:'
): Promise<RateLimitStore> {
  // 动态导入 ioredis 以避免客户端打包问题
  const { default: Redis } = await import('ioredis');

  let client: InstanceType<typeof Redis>;

  if (options?.url) {
    client = new Redis(options.url);
  } else {
    client = new Redis({
      host: options?.host ?? 'localhost',
      port: options?.port ?? 6379,
      password: options?.password,
      db: options?.db ?? 0,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
      retryStrategy: (times: number) => {
        if (times > 3) return null;
        return Math.min(times * 100, 3000);
      },
    });
  }

  // 错误处理
  client.on('error', (err: Error) => {
    console.error('[RateLimiter] Redis connection error:', err.message);
  });

  return {
    async increment(key: string, windowMs: number): Promise<{ count: number; resetTime: number }> {
      const fullKey = keyPrefix + key;
      const now = Date.now();

      try {
        const result = await client.eval(
          INCREMENT_SCRIPT,
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
    },

    async close(): Promise<void> {
      await client.quit();
    },
  };
}

// ============================================
// 速率限制器主类
// ============================================

export class RateLimiter {
  private store: RateLimitStore | null = null;
  private storePromise: Promise<RateLimitStore> | null = null;
  private configs: Record<string, RateLimitConfig>;
  private keyPrefix: string;
  private redisOptions?: RateLimiterOptions['redis'];

  constructor(options: RateLimiterOptions) {
    this.configs = options.configs;
    this.keyPrefix = options.keyPrefix ?? 'ratelimit:';
    this.redisOptions = options.redis;
  }

  /**
   * 延迟初始化存储
   */
  private async getStore(): Promise<RateLimitStore> {
    if (this.store) {
      return this.store;
    }

    if (this.storePromise) {
      return this.storePromise;
    }

    if (this.redisOptions) {
      // 异步创建 Redis 存储
      this.storePromise = createRedisStore(this.redisOptions, this.keyPrefix)
        .then((store) => {
          this.store = store;
          console.log('[RateLimiter] Using Redis store');
          return store;
        })
        .catch((error) => {
          console.warn('[RateLimiter] Failed to create Redis store, using Memory store:', error);
          this.store = new MemoryStore();
          return this.store;
        });
      return this.storePromise;
    }

    // 使用内存存储
    this.store = new MemoryStore();
    console.log('[RateLimiter] Using Memory store (not recommended for production)');
    return this.store;
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

    const store = await this.getStore();
    const key = `${type}:${identifier}`;
    const { count, resetTime } = await store.increment(key, config.windowMs);

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
    const store = await this.getStore();
    await store.close?.();
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
