import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const sentryBuildUploadEnabled =
  process.env.ENABLE_SENTRY_BUILD_UPLOAD === "true" &&
  Boolean(
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT
  );

const nextConfig: NextConfig = {
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
  hideSourceMaps: true,
};

export default sentryBuildUploadEnabled
  ? withSentryConfig(nextConfig, sentryWebpackPluginOptions)
  : nextConfig;
