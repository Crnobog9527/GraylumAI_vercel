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
const LOG_SINK = Symbol.for("graylum.api.logSink");
export function setLogSink(sink) {
    globalThis[LOG_SINK] = sink;
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
    }
    catch {
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
    supabase = null;
    enableDbLogging = false;
    /**
     * 初始化数据库日志功能
     */
    init(supabase, enableDbLogging = true) {
        this.supabase = supabase;
        this.enableDbLogging = enableDbLogging;
    }
    /**
     * 写入日志到数据库 (异步，不阻塞主流程)
     */
    async writeToDb(entry) {
        if (!this.supabase || !this.enableDbLogging)
            return;
        // 只记录 warn 和 error 级别到数据库
        if (entry.level !== "warn" && entry.level !== "error")
            return;
        try {
            await this.supabase.from("application_logs").insert({
                level: entry.level,
                category: entry.category,
                message: entry.message,
                context: entry.context,
                user_id: entry.user_id,
                request_id: entry.request_id,
            });
        }
        catch (error) {
            // 数据库写入失败不应影响主流程
            baseLogger.error({ error }, "Failed to write log to database");
        }
    }
    /**
     * 通用日志方法
     */
    log(level, category, message, context = {}) {
        const logData = {
            category,
            ...context,
        };
        baseLogger[level](logData, message);
        const sink = globalThis[LOG_SINK];
        if (sink && (level === "error" || context.swallowed === true)) {
            try {
                sink({ level, category, message });
            }
            catch { /* reporting never affects the caller */ }
        }
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
    debug(category, message, context) {
        this.log("debug", category, message, context);
    }
    info(category, message, context) {
        this.log("info", category, message, context);
    }
    warn(category, message, context) {
        this.log("warn", category, message, context);
    }
    error(category, message, context) {
        this.log("error", category, message, context);
    }
    // ============ 业务场景专用方法 ============
    /**
     * 认证相关日志
     */
    auth = {
        success: (userId, method, context) => {
            this.info("auth", "auth_success", { userId, method, ...context });
        },
        failed: (email, reason, context) => {
            this.warn("auth", "auth_failed", { email, reason, ...context });
        },
        logout: (userId, context) => {
            this.info("auth", "auth_logout", { userId, ...context });
        },
    };
    /**
     * AI 调用相关日志
     */
    ai = {
        callStart: (model, inputTokens, conversationId, requestId, context) => {
            this.info("ai", "ai_call_start", {
                modelId: model,
                inputTokens,
                conversationId,
                requestId,
                ...context,
            });
        },
        callComplete: (model, inputTokens, outputTokens, durationMs, cost, requestId, context) => {
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
        callFailed: (model, error, retryCount, requestId, context) => {
            this.error("ai", "ai_call_failed", {
                modelId: model,
                error,
                retryCount,
                requestId,
                ...context,
            });
        },
        streamAborted: (model, tokensConsumed, requestId, context) => {
            this.info("ai", "ai_stream_aborted", {
                modelId: model,
                tokensConsumed,
                requestId,
                ...context,
            });
        },
        routingDecision: (query, selectedModel, reason, context) => {
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
        rateLimited: (userId, endpoint, limit, context) => {
            this.warn("security", "rate_limited", {
                userId,
                endpoint,
                limit,
                ...context,
            });
        },
        circuitBreakerTriggered: (userId, consumedAmount, limit, context) => {
            this.warn("security", "circuit_breaker_triggered", {
                userId,
                consumedAmount,
                limit,
                ...context,
            });
        },
        contentBlocked: (userId, reason, contentType, context) => {
            this.warn("security", "content_blocked", {
                userId,
                reason,
                contentType,
                ...context,
            });
        },
        suspiciousActivity: (userId, activity, details, context) => {
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
        startup: (service, version, context) => {
            this.info("system", "system_startup", { service, version, ...context });
        },
        shutdown: (service, reason, context) => {
            this.info("system", "system_shutdown", { service, reason, ...context });
        },
        healthCheck: (status, details, context) => {
            const level = status === "unhealthy" ? "error" : status === "degraded" ? "warn" : "info";
            this.log(level, "system", "health_check", { status, details, ...context });
        },
        cronJob: (job, status, durationMs, error, context) => {
            if (status === "failed") {
                this.error("system", "cron_job", { job, status, durationMs, error, ...context });
            }
            else {
                this.info("system", "cron_job", { job, status, durationMs, ...context });
            }
        },
    };
    /**
     * API 请求相关日志
     */
    api = {
        request: (method, path, userId, requestId, context) => {
            this.debug("api", "api_request", {
                method,
                path,
                userId: userId || "anonymous",
                requestId,
                ...context,
            });
        },
        response: (method, path, statusCode, durationMs, requestId, context) => {
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
        error: (method, path, error, requestId, context) => {
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
