import { router, publicProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const settingsRouter = router({
  /**
   * 获取活跃公告 (公开接口，供首页使用)
   * 返回当前有效的公告列表（按优先级和创建时间排序）
   */
  getActiveAnnouncements: publicProcedure.query(async ({ ctx }) => {
    const now = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from('announcements')
      .select('id, title, description, type, icon, tag, tag_color, link_url, link_text, priority, start_date, end_date, created_at')
      .eq('active', true)
      .lte('start_date', now)
      .or(`end_date.is.null,end_date.gt.${now}`)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch announcements:', error);
      return [];
    }

    return data ?? [];
  }),

  /**
   * 获取横幅公告 (公开接口)
   * 返回类型为 banner 的活跃公告
   */
  getBannerAnnouncement: publicProcedure.query(async ({ ctx }) => {
    const now = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from('announcements')
      .select('id, title, description, type, link_url, link_text')
      .eq('active', true)
      .eq('type', 'banner')
      .lte('start_date', now)
      .or(`end_date.is.null,end_date.gt.${now}`)
      .order('priority', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // 没有横幅公告时返回 null
      return null;
    }

    return data;
  }),

  // Public: Get system settings (for display purposes)
  getSystemSettings: publicProcedure.query(async ({ ctx }) => {
    const { data, error } = await ctx.supabase
      .from('system_settings')
      .select('*');

    if (error) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
    }

    return data.reduce((acc: Record<string, unknown>, setting: { key: string; value: unknown }) => ({
      ...acc,
      [setting.key]: setting.value
    }), {});
  }),

  // Admin only: Update system settings
  updateSystemSettings: adminProcedure
    .input(z.object({ key: z.string(), value: z.any() }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('system_settings')
        .upsert({ key: input.key, value: input.value }, { onConflict: 'key' })
        .select();

      if (error) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: error.message });
      }
      return data;
    }),
});
