/**
 * Redis Rate Limiter Service
 *
 * 基于 Upstash Redis 的分布式速率限制器
 * 适用于 Vercel 等无服务器环境
 *
 * @see https://github.com/upstash/ratelimit
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { TRPCError } from '@trpc/server';
import { logger } from '../lib/logger';

// ============================================
// 类型定义
// ============================================

export interface RateLimitResult {
  /** 是否允许请求 */
  success: boolean;
  /** 最大允许请求数 */
  limit: number;
  /** 剩余请求数 */
  remaining: number;
  /** 窗口重置时间 (Unix 时间戳，毫秒) */
  reset: number;
  /** 重试等待时间 (秒) */
  retryAfter?: number;
  /** 失败原因 */
  reason?: 'rate_limited' | 'unavailable';
}

export type RateLimitType =
  | 'ai'
  | 'ai_stream'
  | 'api'
  | 'auth'
  | 'anonymous';

// ============================================
// Redis 客户端
// ============================================

let redis: Redis | null = null;

function shouldFailClosedRateLimit(): boolean {
  return process.env.RATE_LIMIT_FAIL_CLOSED === 'true';
}

function getRedis(): Redis {
  if (!redis) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        'Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN environment variables'
      );
    }

    redis = new Redis({ url, token });
  }
  return redis;
}

// ============================================
// 速率限制器实例
// ============================================

/**
 * 速率限制配置
 *
 * | 类型 | 限制 | 窗口 | 用途 |
 * |------|------|------|------|
 * | ai | 30次 | 1分钟 | AI 对话 (非流式) |
 * | ai_stream | 20次 | 1分钟 | AI 流式对话 |
 * | api | 100次 | 1分钟 | 通用 API |
 * | auth | 5次 | 5分钟 | 登录/注册 |
 * | anonymous | 20次 | 1分钟 | 未认证请求 |
 */
const rateLimiters: Record<RateLimitType, Ratelimit> = {} as Record<RateLimitType, Ratelimit>;

function getRateLimiter(type: RateLimitType): Ratelimit {
  if (!rateLimiters[type]) {
    const redis = getRedis();

    switch (type) {
      case 'ai':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(30, '1 m'),
          prefix: 'graylum:ratelimit:ai:',
          analytics: true,
        });
        break;

      case 'ai_stream':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(20, '1 m'),
          prefix: 'graylum:ratelimit:ai_stream:',
          analytics: true,
        });
        break;

      case 'api':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(100, '1 m'),
          prefix: 'graylum:ratelimit:api:',
          analytics: true,
        });
        break;

      case 'auth':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(5, '5 m'),
          prefix: 'graylum:ratelimit:auth:',
          analytics: true,
        });
        break;

      case 'anonymous':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(20, '1 m'),
          prefix: 'graylum:ratelimit:anon:',
          analytics: true,
        });
        break;
    }
  }

  return rateLimiters[type];
}

// ============================================
// 主要函数
// ============================================

/**
 * 检查速率限制
 *
 * @param identifier - 用户标识 (userId 或 IP)
 * @param type - 限制类型
 * @returns 速率限制结果
 */
export async function checkRateLimit(
  identifier: string,
  type: RateLimitType = 'api'
): Promise<RateLimitResult> {
  try {
    const limiter = getRateLimiter(type);
    const result = await limiter.limit(identifier);

    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfter: result.success ? undefined : Math.ceil((result.reset - Date.now()) / 1000),
      reason: result.success ? undefined : 'rate_limited',
    };
  } catch {
    if (shouldFailClosedRateLimit()) {
      logger.error('security', 'rate_limit_backend_unavailable_denying_request');
      return {
        success: false,
        limit: 0,
        remaining: 0,
        reset: Date.now() + 60_000,
        retryAfter: 60,
        reason: 'unavailable',
      };
    }

    logger.error('security', 'rate_limit_backend_unavailable_allowing_request');
    return {
      success: true,
      limit: 0,
      remaining: 0,
      reset: 0,
    };
  }
}

/**
 * 检查速率限制，超限时抛出 TRPCError
 *
 * @param identifier - 用户标识
 * @param type - 限制类型
 * @throws TRPCError 当超过限制时
 */
export async function checkRateLimitOrThrow(
  identifier: string,
  type: RateLimitType = 'api'
): Promise<RateLimitResult> {
  const result = await checkRateLimit(identifier, type);

  if (!result.success) {
    if (result.reason === 'unavailable') {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: '速率限制服务暂时不可用，请稍后再试',
      });
    }

    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `请求过于频繁，请在 ${result.retryAfter} 秒后重试`,
    });
  }

  return result;
}

/**
 * 检查速率限制，返回 HTTP 响应格式
 * 用于 Edge Middleware 或 API Routes
 *
 * @param identifier - 用户标识
 * @param type - 限制类型
 * @returns null 表示允许，Response 表示拒绝
 */
export async function checkRateLimitForMiddleware(
  identifier: string,
  type: RateLimitType = 'anonymous'
): Promise<Response | null> {
  const result = await checkRateLimit(identifier, type);

  if (!result.success) {
    if (result.reason === 'unavailable') {
      return new Response(
        JSON.stringify({
          error: 'Service Unavailable',
          message: '速率限制服务暂时不可用，请稍后再试',
          retryAfter: result.retryAfter,
        }),
        {
          status: 503,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': result.retryAfter?.toString() ?? '60',
          },
        }
      );
    }

    return new Response(
      JSON.stringify({
        error: 'Too Many Requests',
        message: `请求过于频繁，请在 ${result.retryAfter} 秒后重试`,
        retryAfter: result.retryAfter,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': result.limit.toString(),
          'X-RateLimit-Remaining': result.remaining.toString(),
          'X-RateLimit-Reset': result.reset.toString(),
          'Retry-After': result.retryAfter?.toString() ?? '60',
        },
      }
    );
  }

  return null;
}

/**
 * 获取 IP 地址 (用于未认证用户)
 *
 * @param request - Request 对象
 * @returns IP 地址
 */
export function getClientIP(request: Request): string {
  // Vercel/Cloudflare headers
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  const realIP = request.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }

  // Fallback
  return 'unknown';
}

/**
 * 检查 Redis 连接状态
 *
 * @returns 是否连接成功
 */
export async function isRedisHealthy(): Promise<boolean> {
  try {
    const redis = getRedis();
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

// ============================================
// 导出类型
// ============================================

export type { Ratelimit };
