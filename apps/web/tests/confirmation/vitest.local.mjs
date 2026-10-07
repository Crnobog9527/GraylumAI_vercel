/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
export default { test: { environment: 'node',
  include: ['../../apps/web/tests/confirmation/full-page.integration.ts'],
  testTimeout: 240000, hookTimeout: 120000, fileParallelism: false } };
