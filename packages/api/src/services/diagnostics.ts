/**
 * Diagnostics Service
 *
 *
 */

import { testRuntimeStopLoss } from './runtime/stopLossMonitor';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getRateLimiter, DEFAULT_RATE_LIMIT_CONFIGS } from './rateLimiter';
import { testBillingPrededuct, testBillingIdempotency, testBillingReconcile } from './diagnosticsBilling';
import { getConfiguredProviderApiKeySource } from './providerUtils';
import { logger } from '../lib/logger';
import { realModelUsedOrStored } from './modelIdentity/usageAliases';
import { readDiagnosticSummary, readDiagnosticTestHistory, readLatestDiagnosticResults } from './diagnosticsResults';

// ============================================
// 类型定义
// ============================================

export type DiagnosticStatus = 'passed' | 'failed' | 'warning' | 'skipped' | 'error';
export type DiagnosticCategory = 'ai' | 'billing' | 'security' | 'performance' | 'data';

export interface DiagnosticTestResult {
  testId: string;
  testName: string;
  category: DiagnosticCategory;
  status: DiagnosticStatus;
  message: string;
  details?: Record<string, unknown>;
  latencyMs: number;
}

export interface DiagnosticRunResult {
  batchId: string;
  runAt: Date;
  runType: 'manual' | 'cron' | 'ci';
  results: DiagnosticTestResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    warning: number;
    skipped: number;
    error: number;
    passRate: number;
    avgLatencyMs: number;
  };
  saveStatus?: {
    saved: boolean;
    error?: string;
  };
}

export interface DiagnosticContext {
  supabase: SupabaseClient;
  supabaseAdmin: SupabaseClient;
  userId?: string;
  runType?: 'manual' | 'cron' | 'ci';
}

// ============================================
// 测试定义
// ============================================

const TEST_DEFINITIONS = [
  // AI 功能测试
  { id: 'ai_model_status', name: 'AI 模型状态检查', category: 'ai' as DiagnosticCategory },

  // 计费功能测试 (3项)
  { id: 'billing_prededuct', name: '预扣记录只读检查', category: 'billing' as DiagnosticCategory },
  { id: 'billing_idempotency', name: '幂等字段只读检查', category: 'billing' as DiagnosticCategory },
  { id: 'billing_reconcile', name: '余额对账测试', category: 'billing' as DiagnosticCategory },

  { id: 'runtime_stop_loss', name: 'Runtime 成本与余额告警', category: 'billing' as DiagnosticCategory },

  // 安全功能测试 (3项)
  { id: 'security_ratelimit', name: '速率限制测试', category: 'security' as DiagnosticCategory },
  { id: 'security_circuit_breaker', name: '消费熔断测试', category: 'security' as DiagnosticCategory },
  { id: 'security_rls', name: 'RLS 数据隔离测试', category: 'security' as DiagnosticCategory },
];

// ============================================
// 辅助函数
// ============================================

function generateBatchId(): string {
  // 生成 UUID v4 格式，符合数据库 batch_id uuid 类型要求
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

function createDiagnosticFailureMessage(label = '测试执行异常'): string {
  return `${label}，请稍后重试`;
}

async function measureLatency<T>(fn: () => Promise<T>): Promise<{ result: T; latencyMs: number }> {
  const start = performance.now();
  const result = await fn();
  const latencyMs = Math.round(performance.now() - start);
  return { result, latencyMs };
}

// ============================================
// AI 功能测试
// ============================================

/**
 * 测试 5.1: AI 模型状态检查 (修复 #25-27)
 */
async function testAIModelStatus(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'ai_model_status';
  const testName = 'AI 模型状态检查';
  const category: DiagnosticCategory = 'ai';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      // 获取所有启用的模型
      const { data: models, error } = await ctx.supabaseAdmin
        .from('ai_models')
        .select('id, name, model_id, provider, is_active, api_key, config')
        .eq('is_active', 'true');

      if (error) throw error;

      const modelResults = await Promise.all((models || []).map(async (model) => {
        const config = (model.config as Record<string, unknown> | null) ?? {};
        const connectionStatus = typeof config.connection_status === 'string'
          ? config.connection_status
          : null;
        const hasKey = !!model.api_key || !!getConfiguredProviderApiKeySource();

        return {
          id: model.id,
          name: model.name,
          modelId: model.model_id,
          status: !hasKey ? 'missing_key' : connectionStatus ?? 'untested',
          message: !hasKey ? '缺少 API 密钥' : (connectionStatus ? `最近连接状态: ${connectionStatus}` : '尚未执行连接测试'),
        };
      }));

      const failedCount = modelResults.filter(m => m.status === 'missing_key' || m.status === 'error').length;

      return {
        models: modelResults,
        total: modelResults.length,
        configured: modelResults.length - failedCount,
        failed: failedCount,
      };
    });

    const allOk = result.failed === 0;

    return {
      testId,
      testName,
      category,
      status: allOk ? 'passed' : 'warning',
      message: allOk
        ? `所有模型 (${result.total}) 配置正确`
        : `警告: 有 ${result.failed}/${result.total} 个模型未配置密钥`,
      details: result,
      latencyMs,
    };
  } catch (error) {
    return {
      testId,
      testName,
      category,
      status: 'error',
      message: createDiagnosticFailureMessage('模型检查异常'),
      latencyMs: 0,
    };
  }
}

async function testRateLimit(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'security_ratelimit';
  const testName = '速率限制测试';
  const category: DiagnosticCategory = 'security';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      const rateLimiter = getRateLimiter();

      // 测试速率限制器
      const testUserId = 'test_diagnostic_user';
      const checkResult = rateLimiter.check(testUserId, 'ai');

      return {
        configuredLimits: DEFAULT_RATE_LIMIT_CONFIGS,
        testResult: checkResult,
        storeSize: rateLimiter.getStoreSize(),
        isConfigured: checkResult.limit > 0,
      };
    });

    return {
      testId,
      testName,
      category,
      status: result.isConfigured ? 'warning' : 'failed',
      message: `仅本地限流器检查: ${result.testResult.limit}/分钟；未验证请求链路限流或 Redis 故障处理`,
      details: result,
      latencyMs,
    };
  } catch (error) {
    return {
      testId,
      testName,
      category,
      status: 'error',
      message: createDiagnosticFailureMessage(),
      latencyMs: 0,
    };
  }
}

/**
 * 测试 10: 消费熔断测试
 */
async function testCircuitBreaker(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'security_circuit_breaker';
  const testName = '消费熔断测试';
  const category: DiagnosticCategory = 'security';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      // 检查系统设置中的熔断配置
      const { data: settings } = await ctx.supabase
        .from('system_settings')
        .select('value')
        .eq('key', 'security')
        .single();

      const securitySettings = settings?.value as {
        maxCreditsPerHour?: number;
        circuitBreakerEnabled?: boolean;
      } | null;

      // 默认熔断阈值
      const maxCreditsPerHour = securitySettings?.maxCreditsPerHour ?? 10000;
      const circuitBreakerEnabled = securitySettings?.circuitBreakerEnabled ?? true;

      return {
        maxCreditsPerHour,
        circuitBreakerEnabled,
        settingsFound: settings !== null,
      };
    });

    return {
      testId,
      testName,
      category,
      status: 'warning',
      message: '仅读取旧熔断配置及默认值；未验证消费熔断是否在请求链路生效',
      details: result,
      latencyMs,
    };
  } catch (error) {
    return {
      testId,
      testName,
      category,
      status: 'error',
      message: createDiagnosticFailureMessage(),
      latencyMs: 0,
    };
  }
}

/**
 * 测试 11: RLS 数据隔离测试
 */
async function testRLSIsolation(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'security_rls';
  const testName = 'RLS 数据隔离测试';
  const category: DiagnosticCategory = 'security';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      // 这里使用的是 service-role 上下文，无法直接验证用户视角的 RLS 效果。
      // 退而求其次，只做表可访问性检查，并显式标记为未验证，避免误报 passed。
      const tablesToCheck = [
        'profiles',
        'conversations',
        'messages',
        'credit_transactions',
        'billing_history',
        'tickets',
        'token_stats',
        'ai_usage_logs',
      ];

      const tableStatuses: Record<string, boolean> = {};
      const inaccessibleTables: string[] = [];

      for (const table of tablesToCheck) {
        const { error } = await ctx.supabase.from(table).select('id').limit(0);
        const isAccessible = !error;
        tableStatuses[table] = isAccessible;
        if (!isAccessible) {
          inaccessibleTables.push(table);
        }
      }

      const accessibleTables = Object.values(tableStatuses).filter(Boolean).length;

      return {
        tablesToCheck: tablesToCheck.length,
        accessibleTables,
        inaccessibleTables,
        tableStatuses,
        rlsConfigured: false,
        rlsVerified: false,
        verificationMode: 'service-role-unverified',
      };
    });

    return {
      testId,
      testName,
      category,
      status: 'warning',
      message: `无法通过 service-role 客户端验证 RLS 隔离，仅确认 ${result.accessibleTables}/${result.tablesToCheck} 张表可访问`,
      details: result,
      latencyMs,
    };
  } catch (error) {
    return {
      testId,
      testName,
      category,
      status: 'error',
      message: createDiagnosticFailureMessage(),
      latencyMs: 0,
    };
  }
}

// ============================================
// 主服务类
// ============================================

export class DiagnosticsService {
  private supabase: SupabaseClient;
  private supabaseAdmin: SupabaseClient;
  private userId?: string;
  private runType: 'manual' | 'cron' | 'ci';

  constructor(ctx: DiagnosticContext) {
    this.supabase = ctx.supabase;
    this.supabaseAdmin = ctx.supabaseAdmin;
    this.userId = ctx.userId;
    this.runType = ctx.runType ?? 'manual';
  }

  /**
   * 运行所有诊断测试
   */
  async runAllTests(): Promise<DiagnosticRunResult> {
    const batchId = generateBatchId();
    const runAt = new Date();
    const results: DiagnosticTestResult[] = [];

    const ctx: DiagnosticContext = {
      supabase: this.supabase,
      supabaseAdmin: this.supabaseAdmin,
      userId: this.userId,
      runType: this.runType,
    };

    // 运行所有测试
    const testFunctions = [
      testAIModelStatus,
      testBillingPrededuct,
      testBillingIdempotency,
      testBillingReconcile,
      testRuntimeStopLoss,
      testRateLimit,
      testCircuitBreaker,
      testRLSIsolation,
    ];

    for (const testFn of testFunctions) {
      try {
        const result = await testFn(ctx);
        results.push(result);
      } catch {
        // 单个测试失败不影响其他测试
        logger.error('system', 'diagnostics_full_run_test_failed');
      }
    }

    // 计算汇总
    const summary = this.calculateSummary(results);

    // 保存结果到数据库
    const saveStatus = await this.saveResults(batchId, results);

    return {
      batchId,
      runAt,
      runType: this.runType,
      results,
      summary,
      saveStatus,
    };
  }

  /**
   * 运行指定类别的测试
   */
  async runCategoryTests(category: DiagnosticCategory): Promise<DiagnosticRunResult> {
    const batchId = generateBatchId();
    const runAt = new Date();
    const results: DiagnosticTestResult[] = [];

    const ctx: DiagnosticContext = {
      supabase: this.supabase,
      supabaseAdmin: this.supabaseAdmin,
      userId: this.userId,
      runType: this.runType,
    };

    // 根据类别选择测试
    const testMap: Record<DiagnosticCategory, Array<(ctx: DiagnosticContext) => Promise<DiagnosticTestResult>>> = {
      ai: [testAIModelStatus],
      billing: [testBillingPrededuct, testBillingIdempotency, testBillingReconcile, testRuntimeStopLoss],
      security: [testRateLimit, testCircuitBreaker, testRLSIsolation],
      performance: [],
      data: [],
    };

    const tests = testMap[category] ?? [];

    for (const testFn of tests) {
      try {
        const result = await testFn(ctx);
        results.push(result);
      } catch {
        logger.error('system', 'diagnostics_category_run_test_failed', {
          category,
        });
      }
    }

    const summary = this.calculateSummary(results);
    const saveStatus = await this.saveResults(batchId, results);

    return {
      batchId,
      runAt,
      runType: this.runType,
      results,
      summary,
      saveStatus,
    };
  }

  /**
   * 运行单个测试
   */
  async runSingleTest(testId: string): Promise<DiagnosticTestResult | null> {
    const ctx: DiagnosticContext = {
      supabase: this.supabase,
      supabaseAdmin: this.supabaseAdmin,
      userId: this.userId,
      runType: this.runType,
    };

    const testMap: Record<string, (ctx: DiagnosticContext) => Promise<DiagnosticTestResult>> = {
      billing_prededuct: testBillingPrededuct,
      billing_idempotency: testBillingIdempotency,
      billing_reconcile: testBillingReconcile,
      runtime_stop_loss: testRuntimeStopLoss,
      security_ratelimit: testRateLimit,
      security_circuit_breaker: testCircuitBreaker,
      security_rls: testRLSIsolation,
    };

    const testFn = testMap[testId];
    if (!testFn) return null;

    try {
      const result = await testFn(ctx);
      await this.saveSingleResult(result);
      return result;
    } catch {
      logger.error('system', 'diagnostics_single_run_test_failed');
      return null;
    }
  }

  /**
   * 获取测试定义列表
   */
  getTestDefinitions() {
    return TEST_DEFINITIONS;
  }

  /**
   * 获取最新测试结果
   */
  async getLatestResults(): Promise<DiagnosticTestResult[]> {
    return (await readLatestDiagnosticResults(this.supabaseAdmin, TEST_DEFINITIONS.map((test) => test.id))).map((row) => ({
      testId: row.test_id,
      testName: row.test_name,
      category: row.category as DiagnosticCategory,
      status: row.status as DiagnosticStatus,
      message: row.message ?? '',
      details: row.details,
      latencyMs: row.latency_ms ?? 0,
    }));
  }

  /**
   * 获取测试历史
   */
  async getTestHistory(testId: string, limit: number = 10): Promise<DiagnosticTestResult[]> {
    return (await readDiagnosticTestHistory(this.supabaseAdmin, testId, limit)).map((row) => ({
      testId,
      testName: TEST_DEFINITIONS.find((t) => t.id === testId)?.name ?? testId,
      category: TEST_DEFINITIONS.find((t) => t.id === testId)?.category ?? 'ai',
      status: row.status as DiagnosticStatus,
      message: row.message ?? '',
      latencyMs: row.latency_ms ?? 0,
    }));
  }

  /**
   * 获取诊断摘要统计
   */
  async getSummaryStats(hours: number = 24) {
    return readDiagnosticSummary(this.supabaseAdmin, hours);
  }

  // ============================================
  // 私有方法
  // ============================================

  private calculateSummary(results: DiagnosticTestResult[]) {
    const total = results.length;
    const passed = results.filter((r) => r.status === 'passed').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const warning = results.filter((r) => r.status === 'warning').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const error = results.filter((r) => r.status === 'error').length;

    const totalLatency = results.reduce((sum, r) => sum + r.latencyMs, 0);

    return {
      total,
      passed,
      failed,
      warning,
      skipped,
      error,
      passRate: total > 0 ? Math.round((passed / total) * 100) : 0,
      avgLatencyMs: total > 0 ? Math.round(totalLatency / total) : 0,
    };
  }

  private async saveResults(batchId: string, results: DiagnosticTestResult[]): Promise<{ saved: boolean; error?: string }> {
    const records = results.map((r) => ({
      test_id: r.testId,
      test_name: r.testName,
      category: r.category,
      status: r.status,
      message: r.message,
      details: r.details ?? {},
      latency_ms: r.latencyMs,
      run_by: this.userId,
      run_type: this.runType,
      batch_id: batchId,
    }));

    const { error } = await this.supabaseAdmin.from('diagnostic_results').insert(records);

    if (error) {
      logger.error('system', 'diagnostics_results_save_failed', {
        code: error.code,
      });
      return { saved: false, error: '诊断结果保存失败，请稍后重试' };
    }
    return { saved: true };
  }

  private async saveSingleResult(result: DiagnosticTestResult) {
    const { error } = await this.supabaseAdmin.from('diagnostic_results').insert({
      test_id: result.testId,
      test_name: result.testName,
      category: result.category,
      status: result.status,
      message: result.message,
      details: result.details ?? {},
      latency_ms: result.latencyMs,
      run_by: this.userId,
      run_type: this.runType,
    });

    if (error) {
      logger.error('system', 'diagnostics_result_save_failed', {
        code: error.code,
      });
    }
  }
}

export default DiagnosticsService;
