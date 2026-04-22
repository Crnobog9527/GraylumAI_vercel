/**
 * 结构化日志系统
 *
 * 功能:
 * - 开发环境: 美化输出 (pino-pretty)
 * - 生产环境: JSON 格式
 * - 自动添加: 时间戳、请求 ID、环境标识
 * - 支持将关键日志写入数据库
 */

import pino from "pino";
import type { SupabaseClient } from "@supabase/supabase-js";

// 日志级别
export type LogLevel = "debug" | "info" | "warn" | "error";

// 日志分类
export type LogCategory =
  | "auth"
  | "billing"
  | "ai"
  | "database"
  | "security"
  | "system"
  | "api";

// 日志上下文
export interface LogContext {
  userId?: string;
  requestId?: string;
  conversationId?: string;
  modelId?: string;
  [key: string]: unknown;
}

// 数据库日志记录
interface DbLogEntry {
  level: LogLevel;
  category: LogCategory;
  message: string;
  context: LogContext;
  user_id?: string;
  request_id?: string;
}

function createDevPrettyStream() {
  if (process.env.NODE_ENV !== "development") {
    return undefined;
  }

  try {
    // Use a direct pretty stream in development so Next.js dev servers do not
    // need pino's worker-based transport resolution.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pretty = require("pino-pretty");
    return pretty({
      colorize: true,
      translateTime: "SYS:standard",
      ignore: "pid,hostname",
    });
  } catch {
    return undefined;
  }
}

const devPrettyStream = createDevPrettyStream();

// 创建基础 pino logger
const baseLogger = pino({
  level: process.env.LOG_LEVEL || (process.env.NODE_ENV === "production" ? "info" : "debug"),
  base: {
    env: process.env.NODE_ENV,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
}, devPrettyStream);

/**
 * 应用日志器类
 * 提供结构化日志记录功能，支持可选的数据库持久化
 */
class AppLogger {
  private supabase: SupabaseClient | null = null;
  private enableDbLogging = false;

  /**
   * 初始化数据库日志功能
   */
  init(supabase: SupabaseClient, enableDbLogging = true) {
    this.supabase = supabase;
    this.enableDbLogging = enableDbLogging;
  }

  /**
   * 写入日志到数据库 (异步，不阻塞主流程)
   */
  private async writeToDb(entry: DbLogEntry): Promise<void> {
    if (!this.supabase || !this.enableDbLogging) return;

    // 只记录 warn 和 error 级别到数据库
    if (entry.level !== "warn" && entry.level !== "error") return;

    try {
      await this.supabase.from("application_logs").insert({
        level: entry.level,
        category: entry.category,
        message: entry.message,
        context: entry.context,
        user_id: entry.user_id,
        request_id: entry.request_id,
      });
    } catch (error) {
      // 数据库写入失败不应影响主流程
      baseLogger.error({ error }, "Failed to write log to database");
    }
  }

  /**
   * 通用日志方法
   */
  private log(
    level: LogLevel,
    category: LogCategory,
    message: string,
    context: LogContext = {}
  ) {
    const logData = {
      category,
      ...context,
    };

    baseLogger[level](logData, message);

    // 异步写入数据库 (不等待)
    this.writeToDb({
      level,
      category,
      message,
      context,
      user_id: context.userId,
      request_id: context.requestId,
    }).catch(() => {
      // 忽略数据库写入错误
    });
  }

  // ============ 便捷方法 ============

  debug(category: LogCategory, message: string, context?: LogContext) {
    this.log("debug", category, message, context);
  }

  info(category: LogCategory, message: string, context?: LogContext) {
    this.log("info", category, message, context);
  }

  warn(category: LogCategory, message: string, context?: LogContext) {
    this.log("warn", category, message, context);
  }

  error(category: LogCategory, message: string, context?: LogContext) {
    this.log("error", category, message, context);
  }

  // ============ 业务场景专用方法 ============

  /**
   * 认证相关日志
   */
  auth = {
    success: (userId: string, method: string, context?: LogContext) => {
      this.info("auth", "auth_success", { userId, method, ...context });
    },
    failed: (email: string, reason: string, context?: LogContext) => {
      this.warn("auth", "auth_failed", { email, reason, ...context });
    },
    logout: (userId: string, context?: LogContext) => {
      this.info("auth", "auth_logout", { userId, ...context });
    },
  };

  /**
   * 积分/计费相关日志
   */
  billing = {
    preDeduct: (
      userId: string,
      amount: number,
      requestId: string,
      context?: LogContext
    ) => {
      this.info("billing", "billing_prededuct", {
        userId,
        amount,
        requestId,
        ...context,
      });
    },
    settle: (
      userId: string,
      prededucted: number,
      actual: number,
      refunded: number,
      requestId: string,
      context?: LogContext
    ) => {
      this.info("billing", "billing_settle", {
        userId,
        prededucted,
        actual,
        refunded,
        requestId,
        ...context,
      });
    },
    refund: (
      userId: string,
      amount: number,
      requestId: string,
      reason: string,
      context?: LogContext
    ) => {
      this.info("billing", "billing_refund", {
        userId,
        amount,
        requestId,
        reason,
        ...context,
      });
    },
    insufficient: (
      userId: string,
      required: number,
      available: number,
      context?: LogContext
    ) => {
      this.warn("billing", "credits_insufficient", {
        userId,
        required,
        available,
        ...context,
      });
    },
    failed: (
      userId: string,
      operation: string,
      error: string,
      context?: LogContext
    ) => {
      this.error("billing", "billing_failed", {
        userId,
        operation,
        error,
        ...context,
      });
    },
  };

  /**
   * AI 调用相关日志
   */
  ai = {
    callStart: (
      model: string,
      inputTokens: number,
      conversationId: string,
      requestId: string,
      context?: LogContext
    ) => {
      this.info("ai", "ai_call_start", {
        modelId: model,
        inputTokens,
        conversationId,
        requestId,
        ...context,
      });
    },
    callComplete: (
      model: string,
      inputTokens: number,
      outputTokens: number,
      durationMs: number,
      cost: number,
      requestId: string,
      context?: LogContext
    ) => {
      this.info("ai", "ai_call_complete", {
        modelId: model,
        inputTokens,
        outputTokens,
        durationMs,
        cost,
        requestId,
        ...context,
      });
    },
    callFailed: (
      model: string,
      error: string,
      retryCount: number,
      requestId: string,
      context?: LogContext
    ) => {
      this.error("ai", "ai_call_failed", {
        modelId: model,
        error,
        retryCount,
        requestId,
        ...context,
      });
    },
    streamAborted: (
      model: string,
      tokensConsumed: number,
      requestId: string,
      context?: LogContext
    ) => {
      this.info("ai", "ai_stream_aborted", {
        modelId: model,
        tokensConsumed,
        requestId,
        ...context,
      });
    },
    routingDecision: (
      query: string,
      selectedModel: string,
      reason: string,
      context?: LogContext
    ) => {
      this.debug("ai", "ai_routing_decision", {
        query: query.substring(0, 100),
        modelId: selectedModel,
        reason,
        ...context,
      });
    },
  };

  /**
   * 安全相关日志
   */
  security = {
    rateLimited: (
      userId: string,
      endpoint: string,
      limit: number,
      context?: LogContext
    ) => {
      this.warn("security", "rate_limited", {
        userId,
        endpoint,
        limit,
        ...context,
      });
    },
    circuitBreakerTriggered: (
      userId: string,
      consumedAmount: number,
      limit: number,
      context?: LogContext
    ) => {
      this.warn("security", "circuit_breaker_triggered", {
        userId,
        consumedAmount,
        limit,
        ...context,
      });
    },
    contentBlocked: (
      userId: string,
      reason: string,
      contentType: "input" | "output",
      context?: LogContext
    ) => {
      this.warn("security", "content_blocked", {
        userId,
        reason,
        contentType,
        ...context,
      });
    },
    suspiciousActivity: (
      userId: string,
      activity: string,
      details: string,
      context?: LogContext
    ) => {
      this.error("security", "suspicious_activity", {
        userId,
        activity,
        details,
        ...context,
      });
    },
  };

  /**
   * 系统相关日志
   */
  system = {
    startup: (service: string, version: string, context?: LogContext) => {
      this.info("system", "system_startup", { service, version, ...context });
    },
    shutdown: (service: string, reason: string, context?: LogContext) => {
      this.info("system", "system_shutdown", { service, reason, ...context });
    },
    healthCheck: (status: "healthy" | "degraded" | "unhealthy", details: Record<string, unknown>, context?: LogContext) => {
      const level = status === "unhealthy" ? "error" : status === "degraded" ? "warn" : "info";
      this.log(level, "system", "health_check", { status, details, ...context });
    },
    cronJob: (job: string, status: "started" | "completed" | "failed", durationMs?: number, error?: string, context?: LogContext) => {
      if (status === "failed") {
        this.error("system", "cron_job", { job, status, durationMs, error, ...context });
      } else {
        this.info("system", "cron_job", { job, status, durationMs, ...context });
      }
    },
  };

  /**
   * API 请求相关日志
   */
  api = {
    request: (
      method: string,
      path: string,
      userId: string | null,
      requestId: string,
      context?: LogContext
    ) => {
      this.debug("api", "api_request", {
        method,
        path,
        userId: userId || "anonymous",
        requestId,
        ...context,
      });
    },
    response: (
      method: string,
      path: string,
      statusCode: number,
      durationMs: number,
      requestId: string,
      context?: LogContext
    ) => {
      const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";
      this.log(level, "api", "api_response", {
        method,
        path,
        statusCode,
        durationMs,
        requestId,
        ...context,
      });
    },
    error: (
      method: string,
      path: string,
      error: string,
      requestId: string,
      context?: LogContext
    ) => {
      this.error("api", "api_error", {
        method,
        path,
        error,
        requestId,
        ...context,
      });
    },
  };
}

// 导出单例
export const logger = new AppLogger();

// 导出类型
export type { AppLogger };
