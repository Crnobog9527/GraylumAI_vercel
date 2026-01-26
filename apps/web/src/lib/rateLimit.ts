/**
 * Rate Limiter for API Routes
 *
 * 基于 Upstash Redis 的分布式速率限制器
 * 适用于 Vercel Edge 和 Server 环境
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';

// ============================================
// 类型定义
// ============================================

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
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

function getRedis(): Redis | null {
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  try {
    redis = new Redis({ url, token });
    return redis;
  } catch {
    return null;
  }
}

// ============================================
// 速率限制器实例
// ============================================

const rateLimiters: Partial<Record<RateLimitType, Ratelimit>> = {};

function getRateLimiter(type: RateLimitType): Ratelimit | null {
  if (rateLimiters[type]) return rateLimiters[type]!;

  const redis = getRedis();
  if (!redis) return null;

  let limiter: Ratelimit;

  switch (type) {
    case 'ai':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(30, '1 m'),
        prefix: 'graylum:ratelimit:ai:',
        analytics: true,
      });
      break;

    case 'ai_stream':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(20, '1 m'),
        prefix: 'graylum:ratelimit:ai_stream:',
        analytics: true,
      });
      break;

    case 'api':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(100, '1 m'),
        prefix: 'graylum:ratelimit:api:',
        analytics: true,
      });
      break;

    case 'auth':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(5, '5 m'),
        prefix: 'graylum:ratelimit:auth:',
        analytics: true,
      });
      break;

    case 'anonymous':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(20, '1 m'),
        prefix: 'graylum:ratelimit:anon:',
        analytics: true,
      });
      break;

    default:
      return null;
  }

  rateLimiters[type] = limiter;
  return limiter;
}

// ============================================
// 主要函数
// ============================================

/**
 * 检查速率限制
 */
export async function checkRateLimit(
  identifier: string,
  type: RateLimitType = 'api'
): Promise<RateLimitResult> {
  try {
    const limiter = getRateLimiter(type);

    if (!limiter) {
      // Redis 未配置，允许请求通过
      return {
        success: true,
        limit: 0,
        remaining: 0,
        reset: 0,
      };
    }

    const result = await limiter.limit(identifier);

    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfter: result.success ? undefined : Math.ceil((result.reset - Date.now()) / 1000),
    };
  } catch (error) {
    // Redis 连接失败时，允许请求通过 (fail-open)
    console.error('[RateLimit] Redis error, allowing request:', error);
    return {
      success: true,
      limit: 0,
      remaining: 0,
      reset: 0,
    };
  }
}

/**
 * 获取客户端 IP
 */
export function getClientIP(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  const realIP = request.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }
  return 'unknown';
}
