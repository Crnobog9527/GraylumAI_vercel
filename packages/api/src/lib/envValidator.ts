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
const hasDuplicatedEnvPrefix = (value: string, key: string) =>
  value.startsWith(`${key}=`) ||
  value.startsWith(`"${key}=`) ||
  value.startsWith(`'${key}=`);

const rejectDuplicatedEnvPrefix = (key: string) =>
  z.string().refine(
    (value) => !hasDuplicatedEnvPrefix(value, key),
    `${key} 的值包含重复的 ${key}= 前缀，请修正环境变量来源`
  );

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

  NEXT_PUBLIC_APP_URL: z
    .string()
    .url('NEXT_PUBLIC_APP_URL 必须是有效的 URL')
    .optional(),

  NEXT_PUBLIC_SITE_NAME: z
    .string()
    .min(1, 'NEXT_PUBLIC_SITE_NAME 不能为空')
    .optional(),

  NEXT_PUBLIC_SUPPORT_EMAIL: z
    .string()
    .email('NEXT_PUBLIC_SUPPORT_EMAIL 必须是有效的邮箱地址')
    .optional(),

  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(100, 'SUPABASE_SERVICE_ROLE_KEY 格式无效')
    .optional(),

  // Database
  DATABASE_URL: rejectDuplicatedEnvPrefix('DATABASE_URL')
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

  // Stripe (可选，启用支付时必需)
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^sk_(test|live)_/, 'STRIPE_SECRET_KEY 必须是有效的 Stripe Secret Key')
    .optional(),

  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z
    .string()
    .regex(/^pk_(test|live)_/, 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY 必须是有效的 Stripe Publishable Key')
    .optional(),

  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_/, 'STRIPE_WEBHOOK_SECRET 必须以 whsec_ 开头')
    .optional(),

  SENTRY_AUTH_TOKEN: rejectDuplicatedEnvPrefix('SENTRY_AUTH_TOKEN')
    .regex(/^sntrys_/, 'SENTRY_AUTH_TOKEN 必须以 sntrys_ 开头')
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

    if (!process.env.NEXT_PUBLIC_APP_URL) {
      errors.push('生产环境必须配置 NEXT_PUBLIC_APP_URL');
    }

    if (!process.env.NEXT_PUBLIC_SITE_NAME) {
      warnings.push('生产环境建议配置 NEXT_PUBLIC_SITE_NAME');
    }

    if (!process.env.NEXT_PUBLIC_SUPPORT_EMAIL) {
      warnings.push('生产环境建议配置 NEXT_PUBLIC_SUPPORT_EMAIL');
    }

    // 检查 Service Role Key
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      warnings.push('生产环境建议配置 SUPABASE_SERVICE_ROLE_KEY');
    }

    if (process.env.STRIPE_SECRET_KEY?.includes('_test_')) {
      warnings.push('生产环境检测到 Stripe 测试密钥，请确认是否仍处于 Test Mode');
    }
  }

  const hasAnyStripeKey = Boolean(
    process.env.STRIPE_SECRET_KEY ||
    process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||
    process.env.STRIPE_WEBHOOK_SECRET
  );

  if (hasAnyStripeKey) {
    if (!process.env.STRIPE_SECRET_KEY) {
      errors.push('启用 Stripe 时必须配置 STRIPE_SECRET_KEY');
    }
    if (!process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY) {
      errors.push('启用 Stripe 时必须配置 NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY');
    }
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      errors.push('启用 Stripe 时必须配置 STRIPE_WEBHOOK_SECRET');
    }
    if (!process.env.NEXT_PUBLIC_APP_URL) {
      errors.push('启用 Stripe 时必须配置 NEXT_PUBLIC_APP_URL');
    }
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      errors.push('启用 Stripe 时必须配置 SUPABASE_SERVICE_ROLE_KEY');
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

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? '';
    if (appUrl.includes('localhost') || appUrl.includes('127.0.0.1')) {
      errors.push('生产环境不能使用 localhost NEXT_PUBLIC_APP_URL');
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
    APP_URL_SET: process.env.NEXT_PUBLIC_APP_URL ? '✓' : '✗',
    SITE_NAME_SET: process.env.NEXT_PUBLIC_SITE_NAME ? '✓' : '✗',
    SUPPORT_EMAIL_SET: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ? '✓' : '✗',
    SUPABASE_SERVICE_KEY_SET: process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓' : '✗',
    DATABASE_URL_SET: process.env.DATABASE_URL ? '✓' : '✗',
    ANTHROPIC_KEY_SET: process.env.ANTHROPIC_API_KEY ? '✓' : '✗',
    OPENROUTER_KEY_SET: process.env.OPENROUTER_API_KEY ? '✓' : '✗',
    STRIPE_SECRET_KEY_SET: process.env.STRIPE_SECRET_KEY ? '✓' : '✗',
    STRIPE_PUBLISHABLE_KEY_SET: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ? '✓' : '✗',
    STRIPE_WEBHOOK_SECRET_SET: process.env.STRIPE_WEBHOOK_SECRET ? '✓' : '✗',
    SENTRY_DSN_SET: process.env.NEXT_PUBLIC_SENTRY_DSN ? '✓' : '✗',
    SENTRY_AUTH_TOKEN_SET: process.env.SENTRY_AUTH_TOKEN ? '✓' : '✗',
  };
}
