/**
 * 环境变量验证器
 *
 * 在应用启动时验证必需的环境变量
 * 确保生产环境不使用测试密钥
 */

import { z } from 'zod';

// ============================================
// 环境变量 Schema
// ============================================

const apiKeySchema = z.string().min(10);

const envSchema = z.object({
  // Node 环境
  NODE_ENV: z.enum(['development', 'staging', 'production']).default('development'),

  // Supabase (必需)
  NEXT_PUBLIC_SUPABASE_URL: z
    .string()
    .url()
    .refine(
      (url) => url.includes('.supabase.co'),
      'NEXT_PUBLIC_SUPABASE_URL 必须是有效的 Supabase URL'
    ),

  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(100, 'NEXT_PUBLIC_SUPABASE_ANON_KEY 格式无效'),

  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(100, 'SUPABASE_SERVICE_ROLE_KEY 格式无效')
    .optional(),

  // Database
  DATABASE_URL: z
    .string()
    .refine(
      (url) => url.startsWith('postgresql://') || url.startsWith('postgres://'),
      'DATABASE_URL 必须是有效的 PostgreSQL 连接字符串'
    )
    .optional(),

  // AI Provider API (OpenRouter / Anthropic)
  OPENROUTER_API_KEY: apiKeySchema
    .regex(/^sk-or-/, 'OPENROUTER_API_KEY 必须以 sk-or- 开头')
    .optional(),

  ANTHROPIC_API_KEY: z
    .string()
    .regex(/^sk-ant-/, 'ANTHROPIC_API_KEY 必须以 sk-ant- 开头')
    .optional(),

  // Sentry (可选但推荐)
  NEXT_PUBLIC_SENTRY_DSN: z
    .string()
    .url()
    .optional(),

  // Rate Limiting (可选)
  RATE_LIMIT_AI_MAX_REQUESTS: z.coerce.number().min(1).max(1000).optional(),
  RATE_LIMIT_AI_STREAM_MAX_REQUESTS: z.coerce.number().min(1).max(500).optional(),

  // Circuit Breaker (可选)
  CIRCUIT_BREAKER_HOURLY_LIMIT: z.coerce.number().min(100).max(100000).optional(),
  CIRCUIT_BREAKER_DAILY_LIMIT: z.coerce.number().min(1000).max(1000000).optional(),
});

// ============================================
// 验证结果类型
// ============================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  environment: string;
}

// ============================================
// 验证函数
// ============================================

/**
 * 验证环境变量
 * @returns 验证结果
 */
export function validateEnv(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. 基本 Schema 验证
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    result.error.issues.forEach((issue) => {
      errors.push(`${issue.path.join('.')}: ${issue.message}`);
    });
  }

  const env = result.success ? result.data : null;
  const nodeEnv = env?.NODE_ENV ?? process.env.NODE_ENV ?? 'development';
  const hasAnyAiKey = Boolean(process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY);

  if (!hasAnyAiKey) {
    errors.push('必须配置 OPENROUTER_API_KEY 或 ANTHROPIC_API_KEY');
  }

  // 2. 生产环境特殊检查
  if (nodeEnv === 'production') {
    // 检查是否使用测试密钥
    if (process.env.OPENROUTER_API_KEY?.includes('test') || process.env.ANTHROPIC_API_KEY?.includes('test')) {
      errors.push('生产环境不能使用测试 API 密钥');
    }

    // 检查 Sentry 是否配置
    if (!process.env.NEXT_PUBLIC_SENTRY_DSN) {
      warnings.push('生产环境建议配置 Sentry 错误监控');
    }

    // 检查 Service Role Key
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      warnings.push('生产环境建议配置 SUPABASE_SERVICE_ROLE_KEY');
    }
  }

  // 3. 安全检查
  // 检查是否有明文密码在环境变量名中
  const sensitivePatterns = [
    /password.*=.+/i,
    /secret.*=.+/i,
    /token.*=.+/i,
    /key.*=.+/i,
  ];

  // 检查 Supabase URL 是否匹配环境
  if (nodeEnv === 'production') {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
    if (supabaseUrl.includes('localhost') || supabaseUrl.includes('127.0.0.1')) {
      errors.push('生产环境不能使用 localhost Supabase URL');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    environment: nodeEnv,
  };
}

/**
 * 在启动时验证并打印结果
 */
export function validateEnvOnStartup(): void {
  const result = validateEnv();

  console.log('========================================');
  console.log('环境变量验证');
  console.log('========================================');
  console.log(`环境: ${result.environment}`);
  console.log(`状态: ${result.valid ? '✅ 通过' : '❌ 失败'}`);

  if (result.errors.length > 0) {
    console.log('\n❌ 错误:');
    result.errors.forEach((err) => console.log(`  - ${err}`));
  }

  if (result.warnings.length > 0) {
    console.log('\n⚠️ 警告:');
    result.warnings.forEach((warn) => console.log(`  - ${warn}`));
  }

  console.log('========================================\n');

  // 在生产环境，如果验证失败则抛出错误
  if (!result.valid && result.environment === 'production') {
    throw new Error(
      `环境变量验证失败:\n${result.errors.join('\n')}`
    );
  }
}

/**
 * 获取安全的环境变量摘要 (用于日志，不包含敏感值)
 */
export function getSafeEnvSummary(): Record<string, string> {
  return {
    NODE_ENV: process.env.NODE_ENV ?? 'undefined',
    SUPABASE_URL_SET: process.env.NEXT_PUBLIC_SUPABASE_URL ? '✓' : '✗',
    SUPABASE_ANON_KEY_SET: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? '✓' : '✗',
    SUPABASE_SERVICE_KEY_SET: process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓' : '✗',
    DATABASE_URL_SET: process.env.DATABASE_URL ? '✓' : '✗',
    ANTHROPIC_KEY_SET: process.env.ANTHROPIC_API_KEY ? '✓' : '✗',
    OPENROUTER_KEY_SET: process.env.OPENROUTER_API_KEY ? '✓' : '✗',
    SENTRY_DSN_SET: process.env.NEXT_PUBLIC_SENTRY_DSN ? '✓' : '✗',
  };
}
