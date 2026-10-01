/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { createTRPCContext } from '../../trpc';
type ApiContext = Awaited<ReturnType<typeof createTRPCContext>>;
import { defaultMembershipEntitlements } from '../membershipEntitlementConfig';
export const actorId = '00000000-0000-4000-8000-00000000e001';
export const planIds = {
  free: '00000000-0000-4000-8000-00000000e011',
  pro: '00000000-0000-4000-8000-00000000e012',
  gold: '00000000-0000-4000-8000-00000000e013',
};
type Row = Record<string, unknown>;
export function fixture(level: 'free' | 'pro' | 'gold' = 'pro') {
  const rows: Record<string, Row[]> = {
    profiles: [{ id: actorId, role: 'user', status: 'active', is_deleted: 'false', membership_level: level,
      nickname: 'Test', email: 'entitlements@example.test' }],
    membership_plans: (['free', 'pro', 'gold'] as const).map(tier => ({
      id: planIds[tier], level: tier, name: tier, is_active: 'true', ...defaultMembershipEntitlements(tier),
      monthly_price: 100, monthly_credits: 200, allow_export: 'true', allow_batch_export: 'false',
    })),
    user_subscriptions: [], payment_orders: [], system_settings: [{ key: 'fusion_compare_max_models', value: 4 }],
  };
  const failures = new Set<string>();
  const reads: Array<{ table: string; column: string; value: unknown }> = [];
  const writes: Array<{ table: string; value: unknown }> = [];
  const client = {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let single = false;
      let limit = Infinity;
      let mutation: { kind: string; value: Row | Row[] } | undefined;
      const execute = async () => {
        if (failures.has(table)) return { data: null, error: { message: 'PRIVATE_DATABASE_ERROR' } };
        let data = (rows[table] ?? []).filter(row => filters.every(filter => filter(row))).slice(0, limit);
        if (mutation) {
          if (table === 'membership_plans') {
            const proposed = Array.isArray(mutation.value) ? mutation.value : [mutation.value];
            if (proposed.some(item => item.level !== undefined && rows[table]!.some(row =>
              row.level === item.level && !(mutation!.kind === 'update' && data.includes(row))))) {
              return { data: null, error: { code: '23505', message: 'duplicate tier PRIVATE_DETAIL' } };
            }
          }
          writes.push({ table, value: mutation.value });
          if (mutation.kind === 'update') {
            data.forEach(row => Object.assign(row, mutation!.value));
          } else {
            const added = Array.isArray(mutation.value) ? mutation.value : [mutation.value];
            if (mutation.kind === 'upsert') {
              for (const item of added) {
                const existing = rows[table]!.find(row => row.key === item.key);
                if (existing) Object.assign(existing, item);
                else rows[table]!.push(item);
              }
            } else rows[table]!.push(...added);
            data = added;
          }
        }
        return { data: single ? data[0] ?? null : data, error: null };
      };
      const builder = {
        select() { return builder; },
        eq(column: string, value: unknown) {
          reads.push({ table, column, value });
          filters.push(row => row[column] === value);
          return builder;
        },
        not(column: string, _operator: string, value: string) {
          const excluded = value.slice(1, -1).split(',');
          filters.push(row => !excluded.includes(String(row[column])));
          return builder;
        },
        order() { return builder; },
        limit(value: number) { limit = value; return builder; },
        single() { single = true; return execute(); },
        maybeSingle() { single = true; return execute(); },
        update(value: Row) { mutation = { kind: 'update', value }; return builder; },
        insert(value: Row) { mutation = { kind: 'insert', value }; return builder; },
        upsert(value: Row | Row[]) { mutation = { kind: 'upsert', value }; return builder; },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return execute().then(resolve, reject);
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;
  const context = {
    headers: new Headers(), user: { id: actorId, email: 'entitlements@example.test' },
    isEmailVerified: true, authProvider: 'email', hasSupabaseAdminPrivileges: true,
    supabase: client, supabaseAuth: client, supabasePublic: client, supabaseAdmin: client,
  } as ApiContext;
  return { rows, failures, reads, writes, client, context };
}
export function subscription(status = 'active', end: string | null = '2099-01-01T00:00:00Z') {
  return { user_id: actorId, membership_plan_id: planIds.pro, stripe_subscription_id: 'sub_entitlements_test',
    status, current_period_end: end, cancel_at_period_end: false, billing_cycle: 'monthly', metadata: {} };
}
