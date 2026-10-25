/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { vi } from 'vitest';
// Offline tests have no Redis and every limiter fails closed. Let logged-in calls through here;
// procedureRateLimit.test.ts unmocks the middleware and tests it directly.
vi.mock('../middleware/procedureRateLimit', async importOriginal => ({
  ...await importOriginal<typeof import('../middleware/procedureRateLimit')>(),
  procedureRateLimit: <T>({ next }: { next: () => Promise<T> }) => next(),
}));
