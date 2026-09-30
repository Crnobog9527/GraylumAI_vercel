/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { adminRouter } from './admin';
import { settingsRouter } from './settings';
import { userRouter } from './user';
import { actorId, fixture, planIds } from '../services/__tests__/entitlementsFixture';

const createPlanInput = { name: 'Test plan', monthlyPrice: 100, yearlyPrice: 1000, monthlyCredits: 100, yearlyCredits: 1200 };

describe('ENTITLEMENTS APIs with real tRPC authentication middleware', () => {
  it('reads only the authenticated actor; never returns subscription, payment, or plan identifiers', async () => {
    const f = fixture();
    const result = await userRouter.createCaller(f.context).getEntitlements();
    expect(result.level).toBe('pro');
    expect(JSON.stringify(result)).not.toContain(actorId);
    expect(JSON.stringify(result)).not.toContain(planIds.pro);
    expect(f.reads.filter(read => read.column === 'user_id').every(read => read.value === actorId)).toBe(true);
    expect(f.writes).toEqual([]);
  });
  it('rejects forged identity or entitlement input', async () => {
    const f = fixture();
    // @ts-expect-error Deliberately adversarial client input.
    await expect(userRouter.createCaller(f.context).getEntitlements({ userId: 'other', level: 'gold' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.reads.filter(read => read.table === 'membership_plans')).toEqual([]);
  });
  it.each(['anonymous', 'unverified', 'deleted', 'banned', 'disabled', 'no-service-role'])
  ('rejects %s before returning entitlements', async mode => {
    const f = fixture();
    if (mode === 'anonymous') f.context.user = null;
    if (mode === 'unverified') f.context.isEmailVerified = false;
    if (mode === 'no-service-role') f.context.hasSupabaseAdminPrivileges = false;
    if (['deleted', 'banned', 'disabled'].includes(mode)) f.rows.profiles![0]!.status = mode;
    await expect(userRouter.createCaller(f.context).getEntitlements()).rejects.toBeDefined();
    expect(f.writes).toEqual([]);
  });
  it.each(['free', 'pro', 'gold'] as const)('admin creates %s with D4 defaults', async level => {
    const f = fixture(); f.rows.profiles![0]!.role = 'admin';
    const result = await adminRouter.createCaller(f.context).createMembershipPlan({ ...createPlanInput, level });
    expect(result).toMatchObject({
      allow_fusion_review: level !== 'free', allow_fusion_compare: level !== 'free',
      library_storage_bytes: { free: 50_000_000, pro: 500_000_000, gold: 2_000_000_000 }[level],
    });
  });
  it('allows a single admin entitlement change, preserves unrelated fields and reads it back', async () => {
    const f = fixture(); f.rows.profiles![0]!.role = 'admin';
    const before = { ...f.rows.membership_plans![1]! };
    const result = await adminRouter.createCaller(f.context).updateMembershipPlan({ id: planIds.pro, allowFusionReview: false });
    expect(result).toEqual({ ...before, allow_fusion_review: false, updated_at: expect.any(String) });
    expect(await userRouter.createCaller(f.context).getEntitlements())
      .toMatchObject({ allowFusionReview: false, allowFusionCompare: true, libraryStorageBytes: 500_000_000 });
  });
  it('requires explicit entitlements on actual tier change; same-tier legacy edits stay compatible', async () => {
    const f = fixture(); f.rows.profiles![0]!.role = 'admin';
    const caller = adminRouter.createCaller(f.context);
    await expect(caller.updateMembershipPlan({ id: planIds.pro, level: 'gold' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.writes).toEqual([]);
    await expect(caller.updateMembershipPlan({ id: planIds.pro, level: 'pro', name: 'New name' }))
      .resolves.toMatchObject({ name: 'New name', library_storage_bytes: 500_000_000 });
    await expect(caller.updateMembershipPlan({ id: planIds.pro, level: 'gold',
      allowFusionReview: true, allowFusionCompare: false, libraryStorageBytes: 100 }))
      .resolves.toMatchObject({ level: 'gold', allow_fusion_compare: false, library_storage_bytes: 100 });
  });
  it('rejects a concurrent tier change instead of restoring a tier without explicit entitlements', async () => {
    const f = fixture(); f.rows.profiles![0]!.role = 'admin';
    const originalFrom = f.client.from.bind(f.client);
    let reads = 0;
    f.client.from = ((table: string) => {
      if (table === 'membership_plans' && ++reads === 2) f.rows.membership_plans![1]!.level = 'gold';
      return originalFrom(table);
    }) as typeof f.client.from;
    await expect(adminRouter.createCaller(f.context).updateMembershipPlan({ id: planIds.pro, level: 'pro', name: 'stale' }))
      .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(f.rows.membership_plans![1]).toMatchObject({ level: 'gold', name: 'pro' });
  });
  it('rejects string permissions and accepts explicit false and zero', async () => {
    const f = fixture(); f.rows.profiles![0]!.role = 'admin';
    const caller = adminRouter.createCaller(f.context);
    // @ts-expect-error Malicious client cannot use truthy text to enable permission.
    await expect(caller.updateMembershipPlan({ id: planIds.pro, allowFusionReview: 'false' }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.writes).toEqual([]);
    await expect(caller.updateMembershipPlan({ id: planIds.pro, allowFusionReview: false, libraryStorageBytes: 0 }))
      .resolves.toMatchObject({ allow_fusion_review: false, library_storage_bytes: 0 });
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('rejects unsafe bytes %s before mutation', async bytes => {
    const f = fixture(); f.rows.profiles![0]!.role = 'admin';
    await expect(adminRouter.createCaller(f.context).updateMembershipPlan({ id: planIds.pro, libraryStorageBytes: bytes }))
      .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.writes).toEqual([]);
  });
  it.each(['user', 'anonymous'] as const)('denies %s direct management API access', async role => {
    const f = fixture(); if (role === 'anonymous') f.context.user = null;
    const caller = adminRouter.createCaller(f.context);
    await expect(caller.createMembershipPlan(createPlanInput)).rejects.toBeDefined();
    await expect(caller.updateMembershipPlan({ id: planIds.pro, allowFusionCompare: true })).rejects.toBeDefined();
    await expect(settingsRouter.createCaller(f.context).updateSystemSettings({ key: 'fusion_compare_max_models', value: 8 }))
      .rejects.toBeDefined();
    expect(f.writes).toEqual([]);
  });
  it.each(['single', 'bulk'] as const)('validates D3 in %s writes and preserves setting on rejection', async mode => {
    const f = fixture(); f.rows.profiles![0]!.role = 'admin';
    const caller = settingsRouter.createCaller(f.context);
    const save = (value: unknown) => {
      const input = { key: 'fusion_compare_max_models', value };
      return mode === 'single' ? caller.updateSystemSettings(input) : caller.updateSystemSettingsBulk([input]);
    };
    for (const value of [2, 4, 8]) {
      await save(value);
      expect((await userRouter.createCaller(f.context).getEntitlements()).fusionCompareMaxModels).toBe(value);
    }
    const writes = f.writes.length;
    for (const value of [1, 9, 2.5, '4', null, {}, [], true]) {
      await expect(save(value)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(f.writes.length).toBe(writes);
    expect(f.rows.system_settings![0]!.value).toBe(8);
  });
  it('sanitizes management read/write failures', async () => {
    const f = fixture(); f.rows.profiles![0]!.role = 'admin'; f.failures.add('membership_plans');
    await expect(adminRouter.createCaller(f.context).updateMembershipPlan({ id: planIds.pro, allowFusionReview: true }))
      .rejects.toMatchObject({ message: '更新会员方案失败，请稍后重试' });
  });
});
