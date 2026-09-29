/**
 * Rate Limiter for API Routes
 *
 * 基于 Upstash Redis 的分布式速率限制器
 * 适用于 Vercel Edge 和 Server 环境
 */

import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import { logServerError } from '@/lib/server-log';

// ============================================
// 类型定义
// ============================================

export interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
  reason?: 'rate_limited' | 'unavailable';
}

export type RateLimitType =
  | 'ai'
  | 'ai_stream'
  | 'api'
  | 'auth'
  | 'anonymous'
  | 'ip';

// ============================================
// Redis 客户端
// ============================================

let redis: Redis | null = null;

// All environments fail closed. Offline tests must explicitly mock Redis.
// 500ms bounds admission latency during outages; it is not a provider timeout.
const RATE_LIMIT_TIMEOUT_MS = 500;

async function limitWithDeadline(limiter: Ratelimit, identifier: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      limiter.limit(identifier),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RATE_LIMIT_TIMEOUT')), RATE_LIMIT_TIMEOUT_MS);
      }),
    ]);
    // Upstash can report a timeout as success. Never treat that as admission.
    if (result.reason === 'timeout') throw new Error('RATE_LIMIT_TIMEOUT');
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function getRedis(): Redis | null {
  if (redis) return redis;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return null;
  }

  try {
    redis = new Redis({
      url, token, retry: { retries: 0 },
      signal: () => AbortSignal.timeout(RATE_LIMIT_TIMEOUT_MS),
    });
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
    case 'ip':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(60, '1 m'),
        prefix: 'graylum:middleware:',
        analytics: true,
        timeout: 0,
      });
      break;

    case 'ai':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(30, '1 m'),
        prefix: 'graylum:ratelimit:ai:',
        analytics: true,
        timeout: 0, // Disable SDK fail-open timer; use the deadline above.
      });
      break;

    case 'ai_stream':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(20, '1 m'),
        prefix: 'graylum:ratelimit:ai_stream:',
        analytics: true,
        timeout: 0, // Disable SDK fail-open timer; use the deadline above.
      });
      break;

    case 'api':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(100, '1 m'),
        prefix: 'graylum:ratelimit:api:',
        analytics: true,
        timeout: 0, // Disable SDK fail-open timer; use the deadline above.
      });
      break;

    case 'auth':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(5, '5 m'),
        prefix: 'graylum:ratelimit:auth:',
        analytics: true,
        timeout: 0, // Disable SDK fail-open timer; use the deadline above.
      });
      break;

    case 'anonymous':
      limiter = new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(20, '1 m'),
        prefix: 'graylum:ratelimit:anon:',
        analytics: true,
        timeout: 0, // Disable SDK fail-open timer; use the deadline above.
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

    if (!limiter) throw new Error('RATE_LIMIT_UNCONFIGURED');

    const result = await limitWithDeadline(limiter, identifier);

    return {
      success: result.success,
      limit: result.limit,
      remaining: result.remaining,
      reset: result.reset,
      retryAfter: result.success ? undefined : Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)),
      reason: result.success ? undefined : 'rate_limited',
    };
  } catch {
    logServerError('security', 'web_rate_limit_backend_unavailable_denying_request');
    return {
      success: false,
      limit: 0,
      remaining: 0,
      reset: Date.now() + 60_000,
      retryAfter: 60,
      reason: 'unavailable',
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
