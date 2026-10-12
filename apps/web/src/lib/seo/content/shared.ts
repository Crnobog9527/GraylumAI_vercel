/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

// The product entry used by public pages until the logged-out trial exists (SEO_GEO_SPEC 7.2: paused).
// After sign-up or login the visitor lands on the positioning diagnosis the pages promise, not the profile.
// The /app move rewrites this target to /app/positioning (SEO_GEO_SPEC section 15).
export const SIGNUP_CTA_HREF = '/login?action=signup&redirect=%2Fpositioning';
