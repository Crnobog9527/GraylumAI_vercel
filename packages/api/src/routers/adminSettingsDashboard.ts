/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { adminSettingsRowSchema, genericAdminSettingsRows } from '../services/adminSettings';
import { entitlementRowShape } from '../services/membershipEntitlementConfig';
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { hydrateStripeCatalogPrices } from '../services/payments/stripeCatalog';
import { createAdminOperationError, assertValidAdminRows } from './adminShared';

const adminSettingsMembershipPlanRowSchema = z.object({
  ...entitlementRowShape,
  id: z.string().min(1),
  name: z.string().min(1),
  level: z.enum(['free', 'pro', 'gold']),
  allow_export: z.enum(['true', 'false']),
  allow_batch_export: z.enum(['true', 'false']),
}).passthrough();

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminSettingsDashboardProcedures = {
  /**
   * Get settings page bootstrap data
   */
  getSettingsDashboard: adminProcedure
    .query(async ({ ctx }) => {
      const [systemSettingsResult, membershipPlansResult] = await Promise.all([
        ctx.supabase.from('system_settings').select('key, value'),
        ctx.supabase
          .from('membership_plans')
          .select('*')
          .order('sort_order', { ascending: true }),
      ]);

      if (systemSettingsResult.error) {
        throw createAdminOperationError('读取系统设置', systemSettingsResult.error);
      }

      if (membershipPlansResult.error) {
        throw createAdminOperationError('读取会员方案列表', membershipPlansResult.error);
      }

      const systemSettings = genericAdminSettingsRows(systemSettingsResult.data);
      assertValidAdminRows(
        systemSettings,
        adminSettingsRowSchema,
        '读取设置页数据',
        'settings dashboard settings',
      );
      assertValidAdminRows(
        membershipPlansResult.data,
        adminSettingsMembershipPlanRowSchema,
        '读取设置页数据',
        'settings dashboard membership plans',
      );

      return {
        systemSettings: Object.fromEntries(
          systemSettings.map((setting) => [setting.key, setting.value]),
        ),
        membershipPlans: await hydrateStripeCatalogPrices({ db: ctx.supabaseAdmin, kind: 'membership_plan', rows: membershipPlansResult.data }),
      };
    }),
};
