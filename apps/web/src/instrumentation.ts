/**
 * Registers runtime instrumentation for the Next.js app.
 * The file lives under src because this app uses src/app routing.
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    // 缺必填环境变量只记日志并上报 Sentry，不 throw：漏配要看得见，但不能让整站起不来。
    const { validateEnvOnStartup } = await import("@repo/api/src/lib/envValidator");
    const envResult = validateEnvOnStartup();
    if (!envResult.valid) {
      Sentry.captureMessage("env_validation_failed", {
        level: "error",
        extra: { environment: envResult.environment, errors: envResult.errors },
      });
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
