/**
 * Registers runtime instrumentation for the Next.js app.
 * The file lives under src because this app uses src/app routing.
 */
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
    // The api layer's error logs and swallowed failures go to the same Sentry project (MAINT-P3).
    const { connectApiLogsToSentry } = await import("./lib/api-log-sentry");
    connectApiLogsToSentry();
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
