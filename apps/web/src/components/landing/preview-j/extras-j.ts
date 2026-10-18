/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LandingFlags } from '@/lib/landing/landing-flags';

/** What sample J needs beyond the shared landing data, read on the server in the preview page. */
export type PageExtras = {
  flags: LandingFlags;
  /** The sample reports: in a local development preview, or when the `sampleReports` flag is on. */
  showSamples?: boolean;
};
