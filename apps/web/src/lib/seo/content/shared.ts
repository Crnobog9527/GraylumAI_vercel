/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

// The product entry used by public pages until the logged-out trial exists (SEO_GEO_SPEC 7.2: paused).
// After sign-up or login the visitor lands on the positioning diagnosis the pages promise, not the profile.
// Since the /app move (E1) positioning lives at /app/positioning (SEO_GEO_SPEC section 15).
export const SIGNUP_CTA_HREF = '/login?action=signup&redirect=%2Fapp%2Fpositioning';
// The Traditional Chinese pages' sign-up also says where the visitor came from: the new account's AI replies start in
// Traditional Chinese (CHAT-LANGUAGE, Owner 2026-10-24); the user can change it in the profile.
export const SIGNUP_CTA_HREF_ZH_TW = '/login?action=signup&lang=zh-Hant&redirect=%2Fapp%2Fpositioning';

// What a new account is given on sign-up, for public pages that say "免费开始，注册送 N 积分". The grant itself is made by the
// database (migration 0230) and shown in admin settings as `new_user_credits`; the landing page says only "免费试用", so this
// is the one place the public pages read the number from. Change it together with the grant.
export const SIGNUP_GRANT_CREDITS = 500;
