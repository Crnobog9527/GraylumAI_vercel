import { router, publicProcedure, adminProcedure } from '../trpc';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const settingsRouter = router({
  /**
   * 获取首页公告 (公开接口)
   * 返回 announcement_type = 'homepage' 的活跃公告列表
   */
  getActiveAnnouncements: publicProcedure.query(async ({ ctx }) => {
    const now = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from('announcements')
      .select('id, title, content, type, icon, icon_color, tag, tag_color, banner_link, priority, start_date, end_date, created_at')
      .eq('active', 'true')  // active 是字符串类型
      .eq('announcement_type', 'homepage')  // 首页公告
      .lte('start_date', now)
      .or(`end_date.is.null,end_date.gt.${now}`)
      .order('priority', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Failed to fetch homepage announcements:', error);
      return [];
    }

    // 映射字段名以兼容前端
    return (data ?? []).map(item => ({
      id: item.id,
      title: item.title,
      description: item.content,  // content -> description
      type: item.type,
      icon: item.icon,
      tag: item.tag,
      tag_color: item.tag_color,
      link_url: item.banner_link,
      priority: item.priority,
      created_at: item.created_at,
    }));
  }),

  /**
   * 获取横幅公告 (公开接口)
   * 返回 announcement_type = 'banner' 的活跃公告
   */
  getBannerAnnouncement: publicProcedure.query(async ({ ctx }) => {
    const now = new Date().toISOString();

    const { data, error } = await ctx.supabase
      .from('announcements')
      .select('id, title, content, type, banner_style, banner_link, tag')
      .eq('active', 'true')  // active 是字符串类型
      .eq('announcement_type', 'banner')  // 横幅公告
      .lte('start_date', now)
      .or(`end_date.is.null,end_date.gt.${now}`)
      .order('priority', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // 没有横幅公告时返回 null
      return null;
    }

    return {
      id: data.id,
      title: data.title,
      description: data.content,
      type: data.type,
      banner_style: data.banner_style,
      link_url: data.banner_link,
      tag: data.tag,
    };
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
