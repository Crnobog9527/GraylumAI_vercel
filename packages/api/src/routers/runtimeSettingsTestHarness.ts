/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { DEFAULT_RUNTIME_RATE_LIMITS } from '../services/runtime/rateLimitSettings';
import { runtimeRateLimitsRouter } from './runtimeRateLimits';
import { settingsRouter } from './settings';

export function runtimeSettingsHarness(role: 'admin' | 'user' | 'anonymous') {
  const stored = new Map<string, unknown>();
  const writes: unknown[] = [];
  const db = {
    from(table: string) {
      if (table === 'profiles') return { select() { return this; }, eq() { return this; },
        single: async () => ({ data: { id: 'actor', role, status: 'active', credits: 0,
          nickname: 'Synthetic', email: 'synthetic@example.test' }, error: null }) };
      if (table !== 'system_settings') throw new Error(table);
      let key = '';
      return { select() { return this; }, eq(_field: string, value: string) { key = value; return this; },
        maybeSingle: async () => ({ data: stored.has(key) ? { key, value: stored.get(key) } : null, error: null }) };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      writes.push({ name, args });
      const key = name === 'runtime_update_stop_loss' ? 'runtime_stop_loss' : 'runtime_rate_limits';
      const raw = stored.get(key);
      const prior = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown> | undefined;
      let value;
      if (name === 'runtime_update_stop_loss') {
        if ((prior?.revision ?? 0) !== args.p_expected_version) return { error: { code: 'PT409' }, data: null };
        value = { ...(args.p_config as object), revision: Number(args.p_expected_version) + 1 };
      } else if (name === 'runtime_update_rate_limits') {
        value = { ...(prior ?? DEFAULT_RUNTIME_RATE_LIMITS), ...(args.p_limits as object) };
      } else if (name === 'runtime_set_stop_new_calls') {
        value = { ...(prior ?? DEFAULT_RUNTIME_RATE_LIMITS), stopNewCalls: args.p_stopped };
      } else { throw new Error(name); }
      stored.set(key, value);
      return { data: value, error: null };
    },
  };
  const ctx = { headers: new Headers(), user: role === 'anonymous' ? null : {
    id: 'actor', email: 'synthetic@example.test', app_metadata: { provider: 'email' }, user_metadata: { email_verified: true } },
    isEmailVerified: true, authProvider: 'email', supabase: db, supabaseAuth: db, supabasePublic: {},
    supabaseAdmin: db, hasSupabaseAdminPrivileges: true } as never;
  return { caller: runtimeRateLimitsRouter.createCaller(ctx), generic: settingsRouter.createCaller(ctx), stored, writes, db };
}
