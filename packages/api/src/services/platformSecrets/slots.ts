/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * ADMIN-SECRETS (migration 0259): business third-party keys entered in the admin and kept in
 * Supabase Vault. System keys (database, service role, Stripe, Redis…) stay in Vercel and are
 * not handled here. The list must match the CHECK in public.platform_secrets.
 */
export const PLATFORM_SECRET_SLOTS = [
  'openrouter', 'postforme', 'postforme_webhook', 'tikhub', 'parallel', 'firecrawl',
] as const;
export type PlatformSecretSlot = typeof PLATFORM_SECRET_SLOTS[number];

/**
 * Transition-period fallback: when the admin has not filled a slot, read this server environment
 * variable instead. OpenRouter has none on purpose: the Runtime binds every call to the exact
 * key fingerprint a test window quoted, and has never read an environment key.
 */
export const PLATFORM_SECRET_ENV_FALLBACK: Record<PlatformSecretSlot, string | null> = {
  openrouter: null,
  postforme: 'POSTFORME_API_KEY',
  postforme_webhook: 'POSTFORME_WEBHOOK_SECRET',
  tikhub: 'TIKHUB_API_KEY',
  parallel: 'PARALLEL_API_KEY',
  firecrawl: 'FIRECRAWL_API_KEY',
};

// Printable ASCII without spaces, 16-1024 characters (the database enforces the same).
const BASE = /^[!-~]{16,1024}$/;
const FORMAT: Record<PlatformSecretSlot, RegExp> = {
  openrouter: /^sk-or-/,
  postforme: /^pfm_(live|test)_[A-Za-z0-9]{8,128}$/,
  // The shared secret Post for Me sends in the webhook header; Graylum chooses it.
  postforme_webhook: BASE,
  tikhub: BASE,
  parallel: BASE,
  firecrawl: BASE,
};

export function isPlatformSecretSlot(value: unknown): value is PlatformSecretSlot {
  return typeof value === 'string' && (PLATFORM_SECRET_SLOTS as readonly string[]).includes(value);
}

export function validPlatformSecret(slot: PlatformSecretSlot, value: string): boolean {
  return BASE.test(value) && FORMAT[slot].test(value);
}

/** The last four characters, the only part of a key ever shown or logged. */
export function lastFour(value: string): string {
  return value.slice(-4);
}
