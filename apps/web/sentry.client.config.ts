// This file configures the initialization of Sentry on the client.
// The config you add here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

  // Environment identification
  environment: process.env.NODE_ENV,

  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: process.env.NODE_ENV === "production" ? 1.0 : 0,

  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,

  // Replay configuration for session replay
  replaysOnErrorSampleRate: 1.0,
  replaysSessionSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 0,

  // Filter out noisy errors
  ignoreErrors: [
    // Network errors
    "Network request failed",
    "Failed to fetch",
    "Load failed",
    "NetworkError",
    "net::ERR_",
    "TypeError: NetworkError",

    // User cancellation
    "AbortError",
    "The operation was aborted",
    "signal is aborted without reason",
    "The user aborted a request",

    // Browser extensions
    "Extension context invalidated",
    "chrome-extension://",
    "moz-extension://",

    // Third-party scripts
    "Script error.",
    "ResizeObserver loop limit exceeded",
    "ResizeObserver loop completed with undelivered notifications",
  ],

  // Filter out requests to certain URLs
  denyUrls: [
    // Chrome extensions
    /extensions\//i,
    /^chrome:\/\//i,
    /^chrome-extension:\/\//i,
    // Firefox extensions
    /^moz-extension:\/\//i,
  ],

  // Add integrations
  integrations: [
    Sentry.replayIntegration({
      // Additional Replay configuration
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],

  // Before sending event, add additional context
  beforeSend(event, hint) {
    // Don't send events in development
    if (process.env.NODE_ENV === "development") {
      console.log("[Sentry] Event captured (not sent in dev):", event);
      return null;
    }
    return event;
  },
});
