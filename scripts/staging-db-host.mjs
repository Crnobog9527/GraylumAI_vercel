/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Input is the hostname parsed by URL, never a whole connection string.
export function isSupabaseLikeHost(hostname) {
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.supabase\.(?:co|com)$/i.test(hostname);
}
