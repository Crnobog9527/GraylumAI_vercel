/**
 * Security Checks Middleware
 *
 * AI 调用前的安全检查中间件
 * 包括: 速率限制、消费熔断、余额预检
 */

import { TRPCError } from '@trpc/server';
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

// ============================================
// 内存速率限制器 (生产环境建议使用 Redis)
// ============================================

const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

/**
 * 检查速率限制
 */
export async function checkRateLimit(
  userId: string,
  type: keyof typeof RATE_LIMIT_CONFIG = 'ai'
): Promise<void> {
  const config = RATE_LIMIT_CONFIG[type];
  const key = `${type}:${userId}`;
  const now = Date.now();

  const record = rateLimitStore.get(key);

  if (!record || now > record.resetTime) {
    // 新窗口
    rateLimitStore.set(key, {
      count: 1,
      resetTime: now + config.windowMs,
    });
    return;
  }

  if (record.count >= config.maxRequests) {
    const retryAfter = Math.ceil((record.resetTime - now) / 1000);
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `请求过于频繁，请在 ${retryAfter} 秒后重试`,
    });
  }

  record.count += 1;
}

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

  // 2. 速率限制检查
  if (!options.skipRateLimit) {
    await checkRateLimit(ctx.userId, options.rateLimitType ?? 'ai');
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
};
