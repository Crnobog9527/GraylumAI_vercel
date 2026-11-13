import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import { PHASE_PRODUCTION_BUILD } from "next/constants";
import { validateRedisEnvForBuild } from "../../packages/api/src/lib/envValidator";
import { buildRobotsHeaderRules, SITE_INDEXING_ENV } from "./src/lib/robots-policy";
import { buildLegacyHostRedirects, buildPathRedirects, SINGLE_HOST_REDIRECTS_ENV } from "./src/lib/single-host-redirects";

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
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  [
    "img-src 'self' data: blob: https://*.supabase.co",
    "https://*.google-analytics.com https://www.googletagmanager.com",
  ].join(" "),
  "font-src 'self'",
  "media-src 'self' blob: https://*.supabase.co",
  [
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
    "https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://*.ingest.de.sentry.io",
    "https://vitals.vercel-insights.com",
    // ANALYTICS: GA4 collection (report-only, observed before enforcing). Termly's consent script is gone (ANALYTICS-CONSENT).
    "https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com",
  ].join(" "),
  // Session Replay uses a compression worker.
  "worker-src 'self' blob:",
].join("; ");

const nextConfig: NextConfig = {
  devIndicators: false,
  // The browser's saved page data (lib/persisted-cache.ts) is dropped whenever the build changes: new code never reads old data's shape.
  env: { NEXT_PUBLIC_CACHE_BUILD: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 12) ?? "dev" },
  // One root layout per language (app/(zh-hans), app/zh-tw): an address that matches no route is answered by
  // app/global-not-found.tsx, since no single layout covers it.
  experimental: { globalNotFound: true },
  // Development server only, and only for the simulated-model browser tests (scripts/e2e-sim/run.mjs sets the switch): `next dev` drops a page it
  // compiled once the page has been idle for a minute (and keeps only the last few), so a route warmed up at the start was compiled again in the
  // middle of a later journey, stalling the server's event loop for seconds (first CI run with stall measurements, #1794). With the switch, the
  // pages compiled in a run stay compiled.
  // The same switch stops the development compiler from writing its cache to disk. Webpack writes everything it compiled to .next/cache once
  // the compiler has been idle (a minute after the last compile; a second after a large one), and reads it back afterwards: over a gigabyte
  // here, serialised on the server's own thread. The event loop stood still for 5 to 14 seconds each time, in whichever journey was running a
  // minute after the warm-up, and the rate limiter's fixed deadline refused that journey's request (2026-11-11: the first journey of
  // 02-failures, now and then). A test run starts without that cache and throws it away, so nothing ever read what was written; what is
  // compiled stays in memory (Next's own memory cache), so nothing compiles twice. A deployed app has no compiler at all.
  // Not set anywhere else; a build or a deployed app never reads these options.
  ...(process.env.SIM_KEEP_COMPILED === "1" ? {
    onDemandEntries: { maxInactiveAge: 6 * 60 * 60 * 1000, pagesBufferLength: 200 },
    webpack: (config: { cache?: unknown }, { dev }: { dev: boolean }) => {
      if (dev) config.cache = false;
      return config;
    },
  } : {}),
  // Single host (E1): old addresses and, once switched on, the old hosts. The rules and why are in
  // src/lib/single-host-redirects; the host rules come first so an old host goes to www in one step.
  async redirects() {
    return [
      ...buildLegacyHostRedirects(process.env[SINGLE_HOST_REDIRECTS_ENV]),
      ...buildPathRedirects(),
    ];
  },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        // ANALYTICS plan §3.3: only the origin, even within the site, so no path or query reaches a referrer.
        { key: "Referrer-Policy", value: "strict-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=(), accelerometer=(), gyroscope=(), magnetometer=(), usb=(), serial=(), hid=()",
        },
        // Start with 30 days on this host only; preload is difficult to undo.
        { key: "Strict-Transport-Security", value: "max-age=2592000" },
        { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp },
      ],
    },
    // X-Robots-Tag: every response stays noindex unless SITE_INDEXING is exactly "public"; on the public
    // environment only logged-in, login and status pages keep it (SEO_GEO_SPEC sections 2 and 15). Read at
    // build time; staging and production build in separate Vercel projects with their own value.
    ...buildRobotsHeaderRules(process.env[SITE_INDEXING_ENV]),
    {
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
