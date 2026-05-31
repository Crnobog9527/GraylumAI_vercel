// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
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
    "Network request failed",
    "Failed to fetch",

    // User cancellation
    "AbortError",
    "The operation was aborted",
  ],

  // Before sending event, add additional context
  beforeSend(event, hint) {
    // Don't send events in development
    if (process.env.NODE_ENV === "development") {
      console.log("[Sentry] Edge event captured (not sent in dev):", event.message || event.exception?.values?.[0]?.value);
      return null;
    }
    return event;
  },
});
