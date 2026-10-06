/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import type { MetadataRoute } from 'next';
import { buildRobots, SITE_INDEXING_ENV } from '@/lib/robots-policy';

// Read the switch per request so a cached build can never carry another environment's policy.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  try {
    return buildRobots(process.env[SITE_INDEXING_ENV]);
  } catch {
    return buildRobots(undefined);
  }
}
