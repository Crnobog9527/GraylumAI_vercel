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
import { RateLimitError } from '../lib/rateLimitError';
import { logger } from '../lib/logger';
import { redisEnvironment } from './redisEnvironment';
import { runtimeRateLimitsSchema, type RuntimeRateLimits } from './runtime/rateLimitSettings';

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

// All environments fail closed. Offline tests must explicitly mock Redis.
// 500ms bounds admission latency during outages; it is not a provider timeout.
const RATE_LIMIT_TIMEOUT_MS = 500;

async function withDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('RATE_LIMIT_TIMEOUT')), RATE_LIMIT_TIMEOUT_MS);
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

async function limitWithDeadline(limiter: Ratelimit, identifier: string, rate?: number) {
  const result = await withDeadline(limiter.limit(identifier, rate === undefined ? undefined : { rate }));
  // Upstash can report a timeout as success. Never treat that as admission.
  if (result.reason === 'timeout') throw new Error('RATE_LIMIT_TIMEOUT');
  return result;
}

function getRedis(): Redis {
  if (!redis) {
    const { url, token } = redisEnvironment(process.env);

    redis = new Redis({
      url, token, retry: { retries: 0 },
      signal: () => AbortSignal.timeout(RATE_LIMIT_TIMEOUT_MS),
    });
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
          timeout: 0, // Disable SDK fail-open timer; use the deadline above.
        });
        break;

      case 'ai_stream':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(20, '1 m'),
          prefix: 'graylum:ratelimit:ai_stream:',
          analytics: true,
          timeout: 0, // Disable SDK fail-open timer; use the deadline above.
        });
        break;

      case 'api':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(100, '1 m'),
          prefix: 'graylum:ratelimit:api:',
          analytics: true,
          timeout: 0, // Disable SDK fail-open timer; use the deadline above.
        });
        break;

      case 'auth':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(5, '5 m'),
          prefix: 'graylum:ratelimit:auth:',
          analytics: true,
          timeout: 0, // Disable SDK fail-open timer; use the deadline above.
        });
        break;

      case 'anonymous':
        rateLimiters[type] = new Ratelimit({
          redis,
          limiter: Ratelimit.slidingWindow(20, '1 m'),
          prefix: 'graylum:ratelimit:anon:',
          analytics: true,
          timeout: 0, // Disable SDK fail-open timer; use the deadline above.
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

  if (!result.success) throw new RateLimitError(result.reason ?? 'rate_limited', result.retryAfter);

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

/** Prepared for host wiring; no route invokes this until replay/recovery boundaries are integrated. */
type RuntimeBucket = 'admission' | 'calls';
type RuntimeEnvironment = 'staging' | 'production' | 'local';
type RuntimeWindow = 'day' | 'minute';
type RuntimeLimitResult =
  | { success: true }
  | { success: false; reason: 'rate_limited' | 'unavailable' | 'usage_configuration_required'; window?: RuntimeWindow; retryAfter: number };
const runtimeLimiters = new Map<string, {
  perMinute: number; perDay: number; minute: Ratelimit; day: Ratelimit;
}>();

export async function checkRuntimeRateLimit(
  identifier: string, bucket: RuntimeBucket, config: RuntimeRateLimits, environment: RuntimeEnvironment, rate = 1,
): Promise<RuntimeLimitResult> {
  let backendStarted = false;
  try {
    const parsed = runtimeRateLimitsSchema.parse(config);
    if (!identifier || !['admission', 'calls'].includes(bucket)
      || !['staging', 'production', 'local'].includes(environment)) throw new Error('INVALID_RUNTIME_BUCKET');
    const perMinute = bucket === 'admission' ? parsed.admissionPerMinute : parsed.callsPerMinute;
    const perDay = bucket === 'admission' ? parsed.admissionPer24Hours : parsed.callsPer24Hours;
    if (!Number.isSafeInteger(rate) || rate < 1) throw new Error('INVALID_RUNTIME_RATE');
    if (rate > perMinute || rate > perDay) {
      logger.error('security', 'runtime_rate_limit_round_exceeds_limit', { bucket });
      return { success: false, reason: 'usage_configuration_required', retryAfter: 0,
        window: rate > perMinute ? 'minute' : 'day' };
    }
    backendStarted = true;
    const key = `${environment}:${bucket}`;
    let pair = runtimeLimiters.get(key);
    if (!pair || pair.perMinute !== perMinute || pair.perDay !== perDay) {
      const client = getRedis();
      const make = (window: RuntimeWindow, count: number, duration: '1 m' | '1 d') => new Ratelimit({
        redis: client, limiter: Ratelimit.slidingWindow(count, duration),
        // Stable across edits: changing a threshold never resets the Redis counters.
        prefix: `graylum:ratelimit:runtime:${key}:${window}:`,
        analytics: false, ephemeralCache: false, timeout: 0,
      });
      pair = { perMinute, perDay, minute: make('minute', perMinute, '1 m'), day: make('day', perDay, '1 d') };
      runtimeLimiters.set(key, pair); // Exactly six possible entries; replace, never append config versions.
    }
    // Read both windows before any multi-call reservation. Concurrent races can only overcount.
    if (rate > 1) {
      for (const window of ['minute', 'day'] as const) {
        const result = await withDeadline(pair[window].getRemaining(identifier));
        if (!Number.isFinite(result.remaining) || !Number.isFinite(result.reset)) throw new Error('INVALID_REMAINING');
        if (result.remaining < rate) return { success: false, reason: 'rate_limited', window,
          retryAfter: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)) };
      }
    }
    for (const window of ['minute', 'day'] as const) {
      const result = await limitWithDeadline(pair[window], identifier, rate);
      if (!result.success) return { success: false, reason: 'rate_limited', window,
        retryAfter: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)) };
    }
    return { success: true };
  } catch {
    logger.error('security', backendStarted ? 'runtime_rate_limit_backend_unavailable_denying_request'
      : 'runtime_rate_limit_invalid_configuration_denying_request');
    return { success: false, reason: 'unavailable', retryAfter: 60 };
  }
}
