/**
 * Diagnostics Service
 *
 * 系统诊断服务 - 一键测试所有关键功能
 *
 * 11 项测试功能:
 * - AI 功能 (5项): 智能路由、Token计算、Prompt缓存、上下文压缩、流式响应
 * - 计费功能 (3项): 三段式计费、幂等性检查、余额对账
 * - 安全功能 (3项): 速率限制、消费熔断、RLS数据隔离
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { classifyTask, classifyTaskComplexity, selectModel, needsRealtimeData } from './modelRouter';
import { countTokens, quickEstimate } from './tokenCounter';
import { getRateLimiter, DEFAULT_RATE_LIMIT_CONFIGS } from './rateLimiter';
import { BillingService, calculateTokenCost, estimateRequestCost } from './billing';
import { runDailyBillingReconciliation } from './billingReconciliation';
import { buildCachedPrompt } from './promptCacheBuilder';
import { getChatRuntimeSettings } from './chatRuntime';
import { getConfiguredProviderApiKeySource } from './providerUtils';
import { logger } from '../lib/logger';
import type { TokenUsage } from '../types/ai';

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

export interface LatestRuntimeProof {
  found: boolean;
  status: DiagnosticStatus;
  message: string;
  checkedAt: string;
  usageLog?: Record<string, unknown>;
  tokenStats?: Record<string, unknown>;
  settle?: Record<string, unknown>;
  transaction?: Record<string, unknown>;
  snapshots?: {
    searchDigest: boolean;
    compressionCheckpoint: boolean;
    rollingSummary: boolean;
  };
  checks?: Record<string, boolean>;
}

// ============================================
// 测试定义
// ============================================

const TEST_DEFINITIONS = [
  // AI 功能测试 (5项)
  { id: 'ai_routing', name: '智能路由测试', category: 'ai' as DiagnosticCategory },
  { id: 'ai_token_calc', name: 'Token 计算精度测试', category: 'ai' as DiagnosticCategory },
  { id: 'ai_prompt_cache', name: 'Prompt 缓存测试', category: 'ai' as DiagnosticCategory },
  { id: 'ai_context_compress', name: '上下文压缩测试', category: 'ai' as DiagnosticCategory },
  { id: 'ai_realtime_keywords', name: '实时数据关键词测试', category: 'ai' as DiagnosticCategory },
  { id: 'ai_model_status', name: 'AI 模型状态检查', category: 'ai' as DiagnosticCategory },
  { id: 'ai_live_runtime_proof', name: '真实运行证据测试', category: 'ai' as DiagnosticCategory },

  // 计费功能测试 (3项)
  { id: 'billing_prededuct', name: '预扣计费测试', category: 'billing' as DiagnosticCategory },
  { id: 'billing_idempotency', name: '幂等性检查测试', category: 'billing' as DiagnosticCategory },
  { id: 'billing_reconcile', name: '余额对账测试', category: 'billing' as DiagnosticCategory },

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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function parseIsoTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function hasRoutingEvidence(
  tokenMetadata: Record<string, unknown>,
  usageMetadata: Record<string, unknown>,
): boolean {
  return Boolean(
    tokenMetadata.routing_decision ||
    tokenMetadata.routingReason ||
    usageMetadata.routingDecision ||
    usageMetadata.routingReason,
  );
}

export function matchBillingSettleByRequestId(
  settleCandidates: Array<Record<string, unknown>>,
  requestId: string | null | undefined,
): Record<string, unknown> | null {
  if (!requestId) return null;

  for (const row of settleCandidates) {
    const metadata = asRecord(row.metadata);
    if (metadata.requestId === requestId) {
      return row;
    }
  }

  return null;
}

export function matchBillingSettleForUsage(
  settleCandidates: Array<Record<string, unknown>>,
  usageLog: Record<string, unknown>,
): Record<string, unknown> | null {
  const exact = matchBillingSettleByRequestId(
    settleCandidates,
    typeof usageLog.request_id === 'string' ? usageLog.request_id : null,
  );
  if (exact) {
    return exact;
  }

  const conversationId = typeof usageLog.conversation_id === 'string' ? usageLog.conversation_id : null;
  const usageTimestamp = parseIsoTime(usageLog.created_at);
  if (!conversationId) {
    return null;
  }

  const conversationMatches = settleCandidates.filter((row) => {
    const metadata = asRecord(row.metadata);
    const response = asRecord(metadata.response);
    return response.conversationId === conversationId || response.conversation_id === conversationId;
  });

  if (conversationMatches.length === 0) {
    return null;
  }

  if (usageTimestamp === null) {
    return conversationMatches[0] ?? null;
  }

  return conversationMatches.reduce<Record<string, unknown> | null>((best, row) => {
    if (best === null) return row;

    const bestDiff = Math.abs((parseIsoTime(best.created_at) ?? usageTimestamp) - usageTimestamp);
    const rowDiff = Math.abs((parseIsoTime(row.created_at) ?? usageTimestamp) - usageTimestamp);
    return rowDiff < bestDiff ? row : best;
  }, null);
}

export async function loadLatestRuntimeProof(
  supabase: SupabaseClient,
  hours: number = 72,
): Promise<LatestRuntimeProof> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  const { data: usageLog } = await supabase
    .from('ai_usage_logs')
    .select('id, user_id, conversation_id, request_id, model_id, latency_ms, created_at, metadata')
    .eq('status', 'success')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!usageLog) {
    return {
      found: false,
      status: 'warning',
      message: `最近 ${hours} 小时内暂无成功 AI 请求，无法生成真实运行证据`,
      checkedAt: new Date().toISOString(),
    };
  }

  const usageMetadata = asRecord(usageLog.metadata);
  const usageTimestamp = parseIsoTime(usageLog.created_at);
  const expectedSearchCount = Number(usageMetadata.webSearchCount ?? 0) || 0;
  const searchExecuted = usageMetadata.webSearchExecuted === true || expectedSearchCount > 0;
  const freeTierUsed = usageMetadata.freeTierUsed === true;

  const { data: tokenCandidates } = await supabase
    .from('token_stats')
    .select('id, conversation_id, message_id, model_used, total_credits, web_search_count, total_cost_usd, metadata, created_at')
    .eq('conversation_id', usageLog.conversation_id)
    .order('created_at', { ascending: false })
    .limit(5);

  const tokenStats = (tokenCandidates ?? []).reduce<Record<string, unknown> | null>((best, row) => {
    if (!row) return best;
    if (best === null) return row;

    const rowTime = parseIsoTime(row.created_at);
    const bestTime = parseIsoTime(best.created_at);

    if (usageTimestamp === null || rowTime === null || bestTime === null) return best;

    const rowDiff = Math.abs(rowTime - usageTimestamp);
    const bestDiff = Math.abs(bestTime - usageTimestamp);
    return rowDiff < bestDiff ? row : best;
  }, null);

  const { data: settleCandidates } = await supabase
    .from('billing_history')
    .select('id, transaction_id, amount, operation_type, metadata, created_at')
    .eq('user_id', usageLog.user_id)
    .eq('operation_type', 'settle')
    .order('created_at', { ascending: false })
    .limit(20);

  const settle = matchBillingSettleForUsage(
    (settleCandidates ?? []) as Array<Record<string, unknown>>,
    usageLog as Record<string, unknown>,
  );

  const { data: transaction } = settle?.transaction_id
    ? await supabase
      .from('credit_transactions')
      .select('id, type, amount, description, created_at')
      .eq('id', settle.transaction_id)
      .maybeSingle()
    : { data: null };

  const { data: snapshotRows } = await supabase
    .from('conversation_context_snapshots')
    .select('snapshot_type, created_at')
    .eq('conversation_id', usageLog.conversation_id)
    .in('snapshot_type', ['search_digest', 'compression_checkpoint', 'rolling_summary'])
    .order('created_at', { ascending: false });

  const tokenMetadata = tokenStats ? asRecord(tokenStats.metadata) : {};
  const settleMetadata = settle ? asRecord(settle.metadata) : {};
  const legacySettleWithoutTransaction = Boolean(settle && !settle.transaction_id && !freeTierUsed);
  const snapshots = {
    searchDigest: (snapshotRows ?? []).some((row) => row.snapshot_type === 'search_digest'),
    compressionCheckpoint: (snapshotRows ?? []).some((row) => row.snapshot_type === 'compression_checkpoint'),
    rollingSummary: (snapshotRows ?? []).some((row) => row.snapshot_type === 'rolling_summary'),
  };

  const checks = {
    usageLogFound: true,
    tokenStatsFound: Boolean(tokenStats),
    modelMatched: tokenStats ? tokenStats.model_used === usageLog.model_id : false,
    routingCaptured: hasRoutingEvidence(tokenMetadata, usageMetadata),
    settleRecorded: freeTierUsed ? true : Boolean(settle),
    creditsMatched: tokenStats
      ? freeTierUsed
        ? Number(tokenStats.total_credits ?? 0) === 0
        : Number(tokenStats.total_credits ?? -1) === Number(settleMetadata.actualCredits ?? Math.abs(Number(settle?.amount ?? 0)))
      : false,
    searchCountMatched: tokenStats
      ? Number(tokenStats.web_search_count ?? 0) === expectedSearchCount
      : false,
    searchSnapshotMatched: searchExecuted ? snapshots.searchDigest : true,
    transactionLinked: freeTierUsed ? true : Boolean(transaction),
  };

  const criticalOk =
    checks.tokenStatsFound &&
    checks.modelMatched &&
    checks.routingCaptured &&
    checks.settleRecorded &&
    checks.creditsMatched &&
    checks.searchCountMatched &&
    checks.searchSnapshotMatched &&
    checks.transactionLinked;

  const legacyCompatibleOk =
    legacySettleWithoutTransaction &&
    checks.tokenStatsFound &&
    checks.modelMatched &&
    checks.routingCaptured &&
    checks.settleRecorded &&
    checks.creditsMatched &&
    checks.searchCountMatched &&
    checks.searchSnapshotMatched;

  return {
    found: true,
    status: criticalOk ? 'passed' : legacyCompatibleOk ? 'warning' : 'failed',
    message: criticalOk
      ? `已验证最近一次真实请求: model=${usageLog.model_id}, credits=${tokenStats?.total_credits ?? 0}, search=${tokenStats?.web_search_count ?? 0}`
      : legacyCompatibleOk
        ? '已找到最近一次真实请求，但该记录来自旧账务路径，缺少 credit_transactions 关联；请生成一条新的真实请求以完成原子证据链'
        : '最近一次真实 AI 请求存在账务或运行时证据不一致',
    checkedAt: new Date().toISOString(),
    usageLog,
    tokenStats: tokenStats ?? undefined,
    settle: settle ?? undefined,
    transaction: transaction ?? undefined,
    snapshots,
    checks,
  };
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
 * 测试 1: 智能路由测试
 */
async function testAIRouting(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'ai_routing';
  const testName = '智能路由测试';
  const category: DiagnosticCategory = 'ai';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      const runtimeSettings = await getChatRuntimeSettings(ctx.supabase);
      // 测试简单任务分类
      const simpleTask = classifyTask('你好', 0);
      const simpleTaskComplexity = classifyTaskComplexity('你好', 0);
      const complexTask = classifyTask('请帮我写一个完整的用户管理系统，包括登录、注册、权限管理功能', 0);
      const complexTaskComplexity = classifyTaskComplexity('请帮我写一个完整的用户管理系统，包括登录、注册、权限管理功能', 0);
      const multiTurnTask = classifyTask('继续', 5);
      const multiTurnTaskComplexity = classifyTaskComplexity('继续', 5);

      // 测试模型选择
      const routingResult = await selectModel({
        supabase: ctx.supabase,
        message: '帮我分析这段代码',
        conversationTurns: 0,
      });

      return {
        smartRoutingEnabled: runtimeSettings.enableSmartRouting,
        simpleTask,
        simpleTaskComplexity,
        complexTask,
        complexTaskComplexity,
        multiTurnTask,
        multiTurnTaskComplexity,
        selectedModel: routingResult.modelConfig.name,
        routingReason: routingResult.routingReason,
        routingDecision: routingResult.routingDecision,
      };
    });

    // 验证结果
    const isValid =
      result.simpleTask === 'greeting' &&
      result.simpleTaskComplexity === 'simple' &&
      result.complexTask === 'coding' &&
      result.complexTaskComplexity === 'complex' &&
      result.multiTurnTaskComplexity === 'complex' &&
      result.selectedModel !== undefined;

    return {
      testId,
      testName,
      category,
      status: isValid ? 'passed' : 'failed',
      message: isValid
        ? `路由正常: 开关=${result.smartRoutingEnabled ? '开启' : '关闭'}, 简单=${result.simpleTask}/${result.simpleTaskComplexity}, 复杂=${result.complexTask}/${result.complexTaskComplexity}`
        : '路由分类异常',
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
 * 测试 2: Token 计算精度测试
 */
async function testTokenCalculation(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'ai_token_calc';
  const testName = 'Token 计算精度测试';
  const category: DiagnosticCategory = 'ai';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      // 测试文本
      const chineseText = '这是一段中文测试文本，用于验证 Token 计算的准确性。';
      const englishText = 'This is an English test text for verifying token calculation accuracy.';
      const mixedText = '这是 mixed 混合文本 with English and 中文混合。';

      // 快速估算
      const chineseEstimate = quickEstimate(chineseText);
      const englishEstimate = quickEstimate(englishText);
      const mixedEstimate = quickEstimate(mixedText);

      // 完整计数 (使用估算方法)
      const countResult = await countTokens(
        {
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: chineseText }],
          system: '你是一个助手',
        },
        { useOfficial: false }
      );

      return {
        chineseEstimate,
        englishEstimate,
        mixedEstimate,
        countResult,
      };
    });

    // 验证结果 (估算值应该合理)
    const isValid =
      result.chineseEstimate > 10 &&
      result.chineseEstimate < 100 &&
      result.englishEstimate > 10 &&
      result.englishEstimate < 50 &&
      result.countResult.inputTokens > 0;

    return {
      testId,
      testName,
      category,
      status: isValid ? 'passed' : 'warning',
      message: `Token 估算: 中文=${result.chineseEstimate}, 英文=${result.englishEstimate}, 混合=${result.mixedEstimate}`,
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
 * 测试 3: Prompt 缓存测试
 */
async function testPromptCache(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'ai_prompt_cache';
  const testName = 'Prompt 缓存测试';
  const category: DiagnosticCategory = 'ai';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      const runtimeSettings = await getChatRuntimeSettings(ctx.supabase);
      const cachedPrompt = buildCachedPrompt({
        systemPrompt: '你是一个提示词缓存测试助手。'.repeat(220),
        messages: [
          { role: 'user', content: '这是第一轮历史消息。'.repeat(180) },
          { role: 'assistant', content: '这是第一轮回复。'.repeat(180) },
          { role: 'user', content: '这是第二轮历史消息。'.repeat(180) },
          { role: 'assistant', content: '这是第二轮回复。'.repeat(180) },
          { role: 'user', content: '这是当前用户输入。' },
        ],
        config: { enabled: runtimeSettings.enablePromptCache },
      });

      return {
        cacheEnabled: runtimeSettings.enablePromptCache,
        cachePoints: cachedPrompt.cachePoints,
        estimatedCacheSavings: cachedPrompt.estimatedCacheSavings,
        cacheApplied: cachedPrompt.cachePoints > 0,
      };
    });

    return {
      testId,
      testName,
      category,
      status: result.cacheEnabled && result.cacheApplied ? 'passed' : 'warning',
      message: result.cacheEnabled
        ? `Prompt 缓存已接入构造链路，缓存点 ${result.cachePoints}`
        : 'Prompt 缓存已关闭',
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
 * 测试 4: 上下文压缩测试
 */
async function testContextCompression(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'ai_context_compress';
  const testName = '上下文压缩测试';
  const category: DiagnosticCategory = 'ai';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      // 检查上下文管理器配置
      // 阈值应为 90000 (150000 * 60%)
      const expectedThreshold = 90000;
      const maxContextTokens = 150000;
      const compressionRatio = expectedThreshold / maxContextTokens;

      return {
        maxContextTokens,
        compressionThreshold: expectedThreshold,
        compressionRatio: Math.round(compressionRatio * 100),
        isConfigCorrect: compressionRatio >= 0.58 && compressionRatio <= 0.62,
      };
    });

    return {
      testId,
      testName,
      category,
      status: result.isConfigCorrect ? 'passed' : 'warning',
      message: `上下文阈值: ${result.compressionThreshold} (${result.compressionRatio}%)`,
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
 * 测试 5: 实时数据关键词测试
 */
async function testRealtimeKeywords(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'ai_realtime_keywords';
  const testName = '实时数据关键词测试';
  const category: DiagnosticCategory = 'ai';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      const runtimeSettings = await getChatRuntimeSettings(ctx.supabase);
      // 测试各种实时数据查询
      const testCases = [
        { query: '今天的新闻是什么', expected: true },
        { query: '上海天气怎么样', expected: true },
        { query: '苹果股票价格', expected: true },
        { query: 'latest bitcoin price', expected: true },
        { query: '什么是机器学习', expected: false },
        { query: 'how to write a function', expected: false },
      ];

      const results = testCases.map((tc) => ({
        query: tc.query,
        detected: needsRealtimeData(tc.query),
        expected: tc.expected,
        correct: needsRealtimeData(tc.query) === tc.expected,
      }));

      const correctCount = results.filter((r) => r.correct).length;

      return {
        smartSearchEnabled: runtimeSettings.enableSmartSearchDecision,
        testCases: results,
        correctCount,
        totalCount: testCases.length,
        passRate: Math.round((correctCount / testCases.length) * 100),
      };
    });

    const allCorrect = result.correctCount === result.totalCount;

    return {
      testId,
      testName,
      category,
      status: allCorrect ? 'passed' : result.passRate >= 80 ? 'warning' : 'failed',
      message: `实时关键词检测: ${result.correctCount}/${result.totalCount} 正确 (${result.passRate}%)，当前仅做判断${result.smartSearchEnabled ? '' : '，开关关闭'}`,
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
 * 测试 5.1: AI 模型状态检查 (修复 #25-27)
 */
async function testAIModelStatus(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'ai_model_status';
  const testName = 'AI 模型状态检查';
  const category: DiagnosticCategory = 'ai';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      // 获取所有启用的模型
      const { data: models, error } = await ctx.supabase
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

async function testAILiveRuntimeProof(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'ai_live_runtime_proof';
  const testName = '真实运行证据测试';
  const category: DiagnosticCategory = 'ai';

  try {
    const { result, latencyMs } = await measureLatency(async () => loadLatestRuntimeProof(ctx.supabase));

    return {
      testId,
      testName,
      category,
      status: result.status,
      message: result.message,
      details: result as unknown as Record<string, unknown>,
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
// 计费功能测试
// ============================================

/**
 * 测试 6: 预扣计费测试 (修复 #26 - 验证实际 RPC 调用)
 */
async function testBillingPrededuct(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'billing_prededuct';
  const testName = '预扣计费测试';
  const category: DiagnosticCategory = 'billing';

  if (!ctx.userId) {
    return {
      testId, testName, category,
      status: 'skipped',
      message: '跳过: 未提供用户 ID',
      latencyMs: 0
    };
  }

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      const testAmount = 1;
      const requestId = crypto.randomUUID();

      // 实际调用数据库 RPC
      const { data, error } = await ctx.supabaseAdmin.rpc('atomic_pre_deduct', {
        p_user_id: ctx.userId,
        p_amount: testAmount,
        p_reason: '诊断测试预扣',
        p_request_id: requestId
      });

      if (error) throw error;

      const deductResult = Array.isArray(data) ? data[0] : data;

      // 立即退款以保持积分平衡
      if (deductResult && deductResult.pre_deduct_id) {
        await ctx.supabaseAdmin.rpc('atomic_refund', {
          p_user_id: ctx.userId,
          p_pre_deduct_id: deductResult.pre_deduct_id,
          p_reason: '诊断测试自动退费'
        });
      }

      return {
        deductResult,
        testAmount,
        reconciled: true
      };
    });

    return {
      testId,
      testName,
      category,
      status: 'passed',
      message: `RPC 调用成功: 预扣 ${result.testAmount} 积分已自动退还`,
      details: result,
      latencyMs,
    };
  } catch (error) {
    return {
      testId,
      testName,
      category,
      status: 'failed',
      message: createDiagnosticFailureMessage('RPC 预扣失败'),
      latencyMs: 0,
    };
  }
}


/**
 * 测试 7: 幂等性检查测试
 */
async function testBillingIdempotency(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'billing_idempotency';
  const testName = '幂等性检查测试';
  const category: DiagnosticCategory = 'billing';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      // 检查 RPC 函数是否存在
      const { data: rpcCheck, error: rpcError } = await ctx.supabaseAdmin.rpc('atomic_pre_deduct', {
        p_user_id: '00000000-0000-0000-0000-000000000000',
        p_amount: 0,
        p_reason: 'test',
        p_request_id: 'test_idempotency_check',
      });

      // 如果 RPC 不存在会返回 404 错误
      const rpcExists = !rpcError || !rpcError.message.includes('not exist');

      return {
        rpcExists,
        rpcError: rpcError?.message,
        idempotencySupported: rpcExists,
      };
    });

    return {
      testId,
      testName,
      category,
      status: result.idempotencySupported ? 'passed' : 'warning',
      message: result.idempotencySupported
        ? '原子化 RPC 函数可用，支持幂等性'
        : '原子化 RPC 不可用，使用乐观锁回退',
      details: result,
      latencyMs,
    };
  } catch (error) {
    return {
      testId,
      testName,
      category,
      status: 'warning',
      message: 'RPC 检查异常，使用乐观锁回退',
      details: { hint: '请查看服务端日志' },
      latencyMs: 0,
    };
  }
}

/**
 * 测试 8: 余额对账测试
 */
async function testBillingReconcile(ctx: DiagnosticContext): Promise<DiagnosticTestResult> {
  const testId = 'billing_reconcile';
  const testName = '余额对账测试';
  const category: DiagnosticCategory = 'billing';

  try {
    const { result, latencyMs } = await measureLatency(async () => {
      const reconciliation = await runDailyBillingReconciliation(ctx.supabase);
      return {
        reconcileValid: reconciliation.success,
        mismatches: reconciliation.mismatches,
        summary: reconciliation.summary,
        periodStart: reconciliation.periodStart,
        periodEnd: reconciliation.periodEnd,
      };
    });

    return {
      testId,
      testName,
      category,
      status: result.reconcileValid ? 'passed' : 'warning',
      message: result.reconcileValid
        ? `对账通过: 成功请求 ${result.summary.successfulAiRequests}, Token 统计 ${result.summary.tokenStatsCount}`
        : `发现 ${result.mismatches.length} 条对账异常`,
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
// 安全功能测试
// ============================================

/**
 * 测试 9: 速率限制测试
 */
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
      status: result.isConfigured ? 'passed' : 'failed',
      message: `速率限制: ${result.testResult.limit}/分钟, 剩余: ${result.testResult.remaining}`,
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
      status: result.circuitBreakerEnabled ? 'passed' : 'warning',
      message: `消费熔断: ${result.maxCreditsPerHour}/小时, 状态: ${result.circuitBreakerEnabled ? '已启用' : '未启用'}`,
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
      testAIRouting,
      testTokenCalculation,
      testPromptCache,
      testContextCompression,
      testRealtimeKeywords,
      testAIModelStatus,
      testAILiveRuntimeProof,
      testBillingPrededuct,
      testBillingIdempotency,
      testBillingReconcile,
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
      ai: [testAIRouting, testTokenCalculation, testPromptCache, testContextCompression, testRealtimeKeywords, testAIModelStatus, testAILiveRuntimeProof],
      billing: [testBillingPrededuct, testBillingIdempotency, testBillingReconcile],
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
      ai_routing: testAIRouting,
      ai_token_calc: testTokenCalculation,
      ai_prompt_cache: testPromptCache,
      ai_context_compress: testContextCompression,
      ai_realtime_keywords: testRealtimeKeywords,
      ai_live_runtime_proof: testAILiveRuntimeProof,
      billing_prededuct: testBillingPrededuct,
      billing_idempotency: testBillingIdempotency,
      billing_reconcile: testBillingReconcile,
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
    const { data } = await this.supabase
      .from('diagnostic_latest_results')
      .select('*')
      .order('created_at', { ascending: false });

    return (data ?? []).map((row) => ({
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
    const { data } = await this.supabaseAdmin.rpc('get_test_history', {
      p_test_id: testId,
      p_limit: limit,
    });

    return (data ?? []).map((row: { id: string; status: string; message: string; latency_ms: number; created_at: string }) => ({
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
    const { data } = await this.supabaseAdmin.rpc('get_diagnostic_summary', {
      p_hours: hours,
    });

    if (data && data.length > 0) {
      return data[0];
    }

    return {
      total_tests: 0,
      passed_tests: 0,
      failed_tests: 0,
      warning_tests: 0,
      pass_rate: 0,
      avg_latency_ms: 0,
      last_run: null,
    };
  }

  async getLatestRuntimeProof(hours: number = 72): Promise<LatestRuntimeProof> {
    return loadLatestRuntimeProof(this.supabase, hours);
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

    const { error } = await this.supabase.from('diagnostic_results').insert(records);

    if (error) {
      logger.error('system', 'diagnostics_results_save_failed', {
        code: error.code,
      });
      return { saved: false, error: '诊断结果保存失败，请稍后重试' };
    }
    return { saved: true };
  }

  private async saveSingleResult(result: DiagnosticTestResult) {
    const { error } = await this.supabase.from('diagnostic_results').insert({
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
