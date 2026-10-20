/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Input is the hostname parsed by URL, never a whole connection string.
export function isSupabaseLikeHost(hostname) {
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.supabase\.(?:co|com)$/i.test(hostname);
}

// Production hosts the staging-only readiness scripts refuse: any host containing the old app host or the single
// www host (E1), and the bare domain itself. The bare domain is matched exactly, since every graylum.com
// subdomain, staging included, contains it.
const PRODUCTION_HOST_FRAGMENTS = ['app.graylum.com', 'www.graylum.com'];
const PRODUCTION_WORD = /(^|[-_.])prod(uction)?($|[-_.])/i;

export function hostHasProductionSignal(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === 'graylum.com' || PRODUCTION_HOST_FRAGMENTS.some(fragment => normalized.includes(fragment))
    || PRODUCTION_WORD.test(normalized);
}
