/**
 * Security Checks Middleware
 *
 * AI 调用前的安全检查中间件
 * 包括: 速率限制、消费熔断、余额预检、请求签名验证
 */

import { TRPCError } from '@trpc/server';
import { createHmac, timingSafeEqual } from 'crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================
// 类型定义
// ============================================

export interface SecurityContext {
  supabase: SupabaseClient;
  userId: string;
}

export interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

export interface CircuitBreakerResult {
  allowed: boolean;
  reason?: string;
  currentSpend?: number;
  limit?: number;
}

export interface RequestSignatureParams {
  /** 请求签名 (HMAC-SHA256) */
  signature: string;
  /** 请求时间戳 (ISO 8601 格式) */
  timestamp: string;
  /** 请求体摘要 (用于签名验证) */
  bodyDigest?: string;
}

// ============================================
// 常量配置
// ============================================

/**
 * 速率限制配置
 */
export const RATE_LIMIT_CONFIG: Record<string, RateLimitConfig> = {
  ai: {
    maxRequests: 60, // 每分钟最多 60 次 AI 请求
    windowMs: 60 * 1000,
  },
  ai_stream: {
    maxRequests: 30, // 流式请求限制更严格
    windowMs: 60 * 1000,
  },
};

/**
 * 消费熔断配置
 */
export const CIRCUIT_BREAKER_CONFIG = {
  // 每小时消费上限 (积分)
  hourlyLimit: 10000,
  // 每日消费上限 (积分)
  dailyLimit: 50000,
  // 熔断冷却时间 (毫秒)
  cooldownMs: 5 * 60 * 1000, // 5 分钟
};

/**
 * 请求签名配置
 */
export const SIGNATURE_CONFIG = {
  // 签名有效期 (毫秒) - 30秒
  maxTimestampAge: 30 * 1000,
  // 签名算法
  algorithm: 'sha256' as const,
  // 签名前缀
  prefix: 'GRAYLUM-HMAC-SHA256',
};

// ============================================
// 速率限制器
// ============================================

import { getRateLimiter } from '../services/rateLimiter';
import {
  checkRateLimit as checkRedisRateLimit,
  checkRateLimitOrThrow as checkRedisRateLimitOrThrow,
  type RateLimitType,
} from '../services/redisRateLimiter';

/**
 * 检查速率限制 (异步版本)
 *
 * 优先使用 Redis (Upstash)，未配置时回退到内存限制器
 */
export async function checkRateLimitAsync(
  userId: string,
  type: RateLimitType = 'ai'
): Promise<void> {
  // 尝试使用 Redis 速率限制
  const result = await checkRedisRateLimit(userId, type);

  // 如果 Redis 返回 limit=0 说明未配置，回退到内存限制器
  if (result.limit === 0) {
    const limiter = getRateLimiter();
    limiter.checkOrThrow(userId, type);
    return;
  }

  // Redis 结果检查
  if (!result.success) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `请求过于频繁，请在 ${result.retryAfter} 秒后重试`,
    });
  }
}

/**
 * 检查速率限制 (同步版本 - 仅内存)
 *
 * @deprecated 建议使用 checkRateLimitAsync
 */
export function checkRateLimit(
  userId: string,
  type: keyof typeof RATE_LIMIT_CONFIG = 'ai'
): void {
  const limiter = getRateLimiter();
  limiter.checkOrThrow(userId, type);
}

/**
 * 导出速率限制器实例获取函数
 */
export { getRateLimiter } from '../services/rateLimiter';
export { checkRedisRateLimit, checkRedisRateLimitOrThrow };

/**
 * 检查消费熔断
 * 防止异常消费导致用户积分快速耗尽
 */
export async function checkConsumptionCircuitBreaker(
  ctx: SecurityContext
): Promise<CircuitBreakerResult> {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 查询最近一小时的消费
  const { data: hourlySpend } = await ctx.supabase
    .from('billing_history')
    .select('amount')
    .eq('user_id', ctx.userId)
    .eq('operation_type', 'settle')
    .gte('created_at', hourAgo.toISOString());

  const hourlyTotal = Math.abs(
    (hourlySpend ?? []).reduce((sum, record) => sum + (record.amount ?? 0), 0)
  );

  if (hourlyTotal >= CIRCUIT_BREAKER_CONFIG.hourlyLimit) {
    return {
      allowed: false,
      reason: `每小时消费已达上限 (${CIRCUIT_BREAKER_CONFIG.hourlyLimit} 积分)，请稍后再试`,
      currentSpend: hourlyTotal,
      limit: CIRCUIT_BREAKER_CONFIG.hourlyLimit,
    };
  }

  // 查询最近一天的消费
  const { data: dailySpend } = await ctx.supabase
    .from('billing_history')
    .select('amount')
    .eq('user_id', ctx.userId)
    .eq('operation_type', 'settle')
    .gte('created_at', dayAgo.toISOString());

  const dailyTotal = Math.abs(
    (dailySpend ?? []).reduce((sum, record) => sum + (record.amount ?? 0), 0)
  );

  if (dailyTotal >= CIRCUIT_BREAKER_CONFIG.dailyLimit) {
    return {
      allowed: false,
      reason: `每日消费已达上限 (${CIRCUIT_BREAKER_CONFIG.dailyLimit} 积分)，请明天再试`,
      currentSpend: dailyTotal,
      limit: CIRCUIT_BREAKER_CONFIG.dailyLimit,
    };
  }

  return { allowed: true };
}

/**
 * 获取用户余额
 */
export async function getUserBalance(ctx: SecurityContext): Promise<number> {
  const { data: profile, error } = await ctx.supabase
    .from('profiles')
    .select('credits')
    .eq('id', ctx.userId)
    .single();

  if (error || !profile) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '用户资料不存在',
    });
  }

  return profile.credits ?? 0;
}

/**
 * 检查用户状态
 */
export async function checkUserStatus(ctx: SecurityContext): Promise<void> {
  const { data: profile, error } = await ctx.supabase
    .from('profiles')
    .select('status, role')
    .eq('id', ctx.userId)
    .single();

  if (error || !profile) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: '用户资料不存在',
    });
  }

  if (profile.status === 'disabled') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '账号已被禁用，请联系管理员',
    });
  }

  if (profile.status === 'banned') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: '账号已被封禁',
    });
  }
}

// ============================================
// 统一安全检查入口
// ============================================

/**
 * AI 调用前的完整安全检查
 *
 * 执行顺序:
 * 1. 用户状态检查
 * 2. 速率限制检查
 * 3. 消费熔断检查
 * 4. 余额预检
 */
export async function preAICallSecurityChecks(
  ctx: SecurityContext,
  estimatedCost: number,
  options: {
    skipRateLimit?: boolean;
    skipCircuitBreaker?: boolean;
    rateLimitType?: keyof typeof RATE_LIMIT_CONFIG;
  } = {}
): Promise<void> {
  // 1. 用户状态检查
  await checkUserStatus(ctx);

  // 2. 速率限制检查 (使用 Redis 优先，内存回退)
  if (!options.skipRateLimit) {
    await checkRateLimitAsync(ctx.userId, options.rateLimitType as RateLimitType ?? 'ai');
  }

  // 3. 消费熔断检查
  if (!options.skipCircuitBreaker) {
    const circuitBreaker = await checkConsumptionCircuitBreaker(ctx);
    if (!circuitBreaker.allowed) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: circuitBreaker.reason ?? '消费熔断触发',
      });
    }
  }

  // 4. 余额预检
  const balance = await getUserBalance(ctx);
  if (balance < estimatedCost) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: `积分不足，需要约 ${estimatedCost}，当前 ${balance}`,
    });
  }
}

/**
 * 内容安全检查 (输入)
 * 检测潜在的 Prompt 注入攻击
 */
export function checkInputSecurity(message: string): void {
  // 检测常见的 Prompt 注入模式
  const suspiciousPatterns = [
    /ignore\s+(all\s+)?(previous|above)\s+(instructions?|prompts?)/i,
    /disregard\s+(all\s+)?(previous|above)/i,
    /forget\s+(everything|all)/i,
    /new\s+instructions?:/i,
    /system\s*prompt:/i,
    /\[INST\]/i,
    /<\|im_start\|>/i,
    /<<SYS>>/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(message)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '检测到潜在的不安全输入',
      });
    }
  }

  // 检测消息长度
  if (message.length > 100000) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: '消息过长，请缩短后重试',
    });
  }
}

// ============================================
// 请求签名验证
// ============================================

/**
 * 生成请求签名
 * 用于客户端签名生成 (也可用于服务端验证时生成期望签名)
 *
 * @param secretKey - 签名密钥 (应从环境变量获取)
 * @param timestamp - ISO 8601 时间戳
 * @param bodyDigest - 请求体摘要 (可选)
 * @param userId - 用户 ID (可选，增加签名唯一性)
 */
export function generateSignature(
  secretKey: string,
  timestamp: string,
  bodyDigest?: string,
  userId?: string
): string {
  // 构建签名消息
  const parts = [
    SIGNATURE_CONFIG.prefix,
    timestamp,
    userId ?? '',
    bodyDigest ?? '',
  ];
  const message = parts.join('\n');

  // 生成 HMAC-SHA256 签名
  const hmac = createHmac(SIGNATURE_CONFIG.algorithm, secretKey);
  hmac.update(message);
  return hmac.digest('hex');
}

/**
 * 验证请求时间戳
 * 防止重放攻击
 */
export function verifyTimestamp(timestamp: string): { valid: boolean; reason?: string } {
  try {
    const requestTime = new Date(timestamp).getTime();
    const now = Date.now();

    // 检查时间戳是否有效
    if (isNaN(requestTime)) {
      return { valid: false, reason: '无效的时间戳格式' };
    }

    // 检查时间戳是否在有效范围内
    const age = Math.abs(now - requestTime);
    if (age > SIGNATURE_CONFIG.maxTimestampAge) {
      return {
        valid: false,
        reason: `请求已过期 (超过 ${SIGNATURE_CONFIG.maxTimestampAge / 1000} 秒)`,
      };
    }

    // 检查是否来自未来 (允许 5 秒的时钟偏差)
    if (requestTime > now + 5000) {
      return { valid: false, reason: '请求时间戳无效 (来自未来)' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: '时间戳解析失败' };
  }
}

/**
 * 验证请求签名
 * 使用 HMAC-SHA256 + 时间戳验证
 *
 * @param params - 签名参数
 * @param userId - 用户 ID
 * @returns 验证结果
 */
export function verifyRequestSignature(
  params: RequestSignatureParams,
  userId: string
): { valid: boolean; reason?: string } {
  // 获取签名密钥 (从环境变量)
  const secretKey = process.env.API_SIGNATURE_SECRET;

  // 如果未配置签名密钥，跳过验证 (开发环境)
  if (!secretKey) {
    console.warn('[Security] API_SIGNATURE_SECRET not configured, skipping signature verification');
    return { valid: true };
  }

  // 1. 验证时间戳
  const timestampResult = verifyTimestamp(params.timestamp);
  if (!timestampResult.valid) {
    return timestampResult;
  }

  // 2. 验证签名
  const expectedSignature = generateSignature(
    secretKey,
    params.timestamp,
    params.bodyDigest,
    userId
  );

  try {
    // 使用 timing-safe 比较防止时序攻击
    const signatureBuffer = Buffer.from(params.signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSignature, 'hex');

    if (signatureBuffer.length !== expectedBuffer.length) {
      return { valid: false, reason: '签名长度无效' };
    }

    if (!timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return { valid: false, reason: '签名验证失败' };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: '签名验证错误' };
  }
}

/**
 * 请求签名验证中间件
 * 在敏感操作 (如计费相关) 时调用
 */
export async function checkRequestSignature(
  params: RequestSignatureParams | undefined,
  userId: string
): Promise<void> {
  // 如果未提供签名参数，检查是否强制要求签名
  const requireSignature = process.env.REQUIRE_API_SIGNATURE === 'true';

  if (!params) {
    if (requireSignature) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: '缺少请求签名',
      });
    }
    return; // 不强制要求时，跳过验证
  }

  const result = verifyRequestSignature(params, userId);

  if (!result.valid) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: result.reason ?? '签名验证失败',
    });
  }
}

/**
 * 内容安全检查 (输出)
 * 检测 AI 输出中的敏感内容
 */
export function checkOutputSecurity(content: string): boolean {
  // 检测敏感信息泄露模式
  const sensitivePatterns = [
    /api[_-]?key\s*[:=]\s*["']?[a-zA-Z0-9-_]{20,}/i,
    /password\s*[:=]\s*["']?[^\s"']{8,}/i,
    /secret\s*[:=]\s*["']?[a-zA-Z0-9-_]{20,}/i,
    /sk-[a-zA-Z0-9]{48}/i, // OpenAI API key pattern
    /sk-ant-[a-zA-Z0-9-_]{95}/i, // Anthropic API key pattern
  ];

  for (const pattern of sensitivePatterns) {
    if (pattern.test(content)) {
      console.warn('Detected potential sensitive content in AI output');
      return false;
    }
  }

  return true;
}

export default {
  preAICallSecurityChecks,
  checkRateLimit,
  checkConsumptionCircuitBreaker,
  getUserBalance,
  checkUserStatus,
  checkInputSecurity,
  checkOutputSecurity,
  // 签名验证
  generateSignature,
  verifyTimestamp,
  verifyRequestSignature,
  checkRequestSignature,
};
