/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Pure helpers of the core-path e2e seed script: the guards and the account plan. No network, no secrets.
import { randomBytes } from 'node:crypto';

export const STAGING_PROJECT_REF = 'gvcpmcunmfrbxuwimxfa';
export const PRODUCTION_PROJECT_REF = 'fhmshnqjjnnlvplojktv';

/** The dedicated accounts of the core-path journeys: what each is for, its plan and the credits it is topped up to. */
export const ACCOUNTS = Object.freeze({
  gold: { level: 'gold', credits: 6000 },
  pro: { level: 'pro', credits: 2000 },
});

/** Refuses anything but the staging Supabase project; production is named explicitly. */
export function assertStagingUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('The Supabase URL is not a valid URL.'); }
  const match = /^([a-z0-9]{20})\.supabase\.co$/.exec(url.hostname.toLowerCase());
  if (match?.[1] === PRODUCTION_PROJECT_REF) throw new Error('Refused: the target is the production Supabase project.');
  if (!match || match[1] !== STAGING_PROJECT_REF || url.protocol !== 'https:' || url.port || url.username
    || (url.pathname !== '/' && url.pathname !== '') || url.search) {
    throw new Error('Refused: the target is not the staging Supabase project.');
  }
  return `https://${STAGING_PROJECT_REF}.supabase.co`;
}

/** Test addresses only: a fixed local part per role at a domain the operator owns (never written to the repository). */
export function emailFor(role, domain, suffix = '') {
  if (!Object.hasOwn(ACCOUNTS, role)) throw new Error(`Unknown role: ${role}`);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain ?? '')) throw new Error('CORE_E2E_EMAIL_DOMAIN must be a domain such as example.com.');
  return `core-e2e-${role}${suffix}@${domain}`;
}

export function randomPassword() {
  // 24 random bytes: long enough for the strength rules, never reused between runs.
  return `Aa1-${randomBytes(24).toString('base64url')}`;
}

/** Credits to add so the account ends at `target` (never removes credits it does not own). */
export function topUpAmount(current, target) {
  return Math.max(0, target - Number(current ?? 0));
}
