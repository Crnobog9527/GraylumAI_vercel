import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { validateRedisEnvForBuild } from "../../packages/api/src/lib/envValidator";

const sentryBuildUploadEnabled =
  process.env.ENABLE_SENTRY_BUILD_UPLOAD === "true" &&
  Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT
  );

// Observe resource violations before enforcing CSP. Checkout/portal navigation is
// a top-level redirect, not an embedded resource. MiSans is served from /fonts.
const reportOnlyCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "script-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com",
  "style-src 'self' 'unsafe-inline' https://hcaptcha.com https://*.hcaptcha.com",
  "img-src 'self' data: blob: https://*.supabase.co https://hcaptcha.com https://*.hcaptcha.com",
  "font-src 'self'",
  "media-src 'self' blob: https://*.supabase.co",
  [
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io",
    "https://hcaptcha.com https://*.hcaptcha.com https://vitals.vercel-insights.com",
  ].join(" "),
  "frame-src https://hcaptcha.com https://*.hcaptcha.com",
  // Session Replay uses a compression worker.
  "worker-src 'self' blob:",
].join("; ");

const nextConfig: NextConfig = {
  devIndicators: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), accelerometer=(), gyroscope=(), magnetometer=(), usb=(), serial=(), hid=()",
        },
        // Start with 30 days on this host only; preload is difficult to undo.
        { key: "Strict-Transport-Security", value: "max-age=2592000" },
        { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp },
      ],
    }, {
      // Only content-addressed font resources are immutable, not the notices.
      source: "/fonts/misans/:asset(.+\\.(?:woff2|css))",
      headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
    }];
  },
  transpilePackages: [
    "@repo/api",
    "@radix-ui/react-avatar",
    "@radix-ui/react-dialog",
    "@radix-ui/react-select",
    "@radix-ui/react-dropdown-menu",
    "@radix-ui/react-label",
    "@radix-ui/react-slot",
  ],
};

// Sentry configuration options
const sentryWebpackPluginOptions = {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,

  silent: !process.env.CI,
  telemetry: false,
  widenClientFileUpload: sentryBuildUploadEnabled,
  sourcemaps: {
    disable: !sentryBuildUploadEnabled,
  },
  release: {
    create: sentryBuildUploadEnabled,
    finalize: sentryBuildUploadEnabled,
  },
  tunnelRoute: "/monitoring",
};

export default withSentryConfig((phase: string) => {
  if (phase === PHASE_PRODUCTION_BUILD) validateRedisEnvForBuild();
  return nextConfig;
}, sentryWebpackPluginOptions);
