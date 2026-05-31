// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

function getSentryEnvironment() {
  return (
    process.env.SENTRY_ENVIRONMENT ??
    process.env.APP_ENV ??
    process.env.NEXT_PUBLIC_APP_ENV ??
    process.env.NODE_ENV
  );
}

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Environment identification
  environment: getSentryEnvironment(),

  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: process.env.NODE_ENV === "production" ? 1.0 : 0,

  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,

  // Filter out noisy errors
  ignoreErrors: [
    // Network errors
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "ENOTFOUND",

    // User cancellation
    "AbortError",
    "The operation was aborted",
    "signal is aborted without reason",

    // Expected errors
    "NEXT_NOT_FOUND",
    "NEXT_REDIRECT",
  ],

  // Add additional integrations for server-side monitoring
  integrations: [
    // HTTP integration for tracing requests
    Sentry.httpIntegration(),
  ],

  // Before sending event, add additional context
  beforeSend(event, hint) {
    // Don't send events in development
    if (process.env.NODE_ENV === "development") {
      console.log("[Sentry] Server event captured (not sent in dev):", event.message || event.exception?.values?.[0]?.value);
      return null;
    }
    return event;
  },
});
