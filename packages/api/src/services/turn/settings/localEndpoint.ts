/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Loopback tests remain separate from the explicitly enabled Staging host. */
export function runtimeLocalEndpoint() {
  const endpoint = process.env.V3_RUNTIME_LOCAL_ENDPOINT;
  for (const value of [endpoint, process.env.NEXT_PUBLIC_SUPABASE_URL]) {
    if (!value) throw new Error('RUNTIME_DISABLED');
    const u = new URL(value);
    if (u.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(u.hostname) || u.username || u.password) throw new Error('RUNTIME_DISABLED');
  }
  return endpoint!;
}
