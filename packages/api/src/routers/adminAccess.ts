/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { router, adminProcedure } from '../trpc';

/**
 * `admin.access` (merged into the admin router in root.ts): whether the caller may open the admin area. adminProcedure does
 * the whole check and no data is read here, so the admin layout's guard costs no table scan. It used to call
 * admin.getStatistics, nine queries including every profile and every ledger row, on every admin page.
 */
export const adminAccessRouter = router({
  access: adminProcedure.query(() => ({ admin: true as const })),
});
