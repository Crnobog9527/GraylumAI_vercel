/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { ANNOUNCEMENT_LINK_ERROR, resolveAnnouncementLink } from '../shared/announcementLink';
import { adminProcedure } from '../trpc';
import { z } from 'zod';
import { createAdminOperationError, logAdminEndpointMetric } from './adminShared';

const announcementLinkInputSchema = z.string()
  .refine(value => resolveAnnouncementLink(value) !== null, ANNOUNCEMENT_LINK_ERROR)
  .transform(value => resolveAnnouncementLink(value)!.href)
  .nullable().optional();

// Part of the admin router (merged in ./admin.ts): the procedure paths stay `admin.<name>`.
export const adminAnnouncementProcedures = {
  /**
   * Get all announcements (for admin)
   */
  getAllAnnouncements: adminProcedure
    .input(z.object({
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
      activeOnly: z.boolean().default(false),
    }))
    .query(async ({ ctx, input }) => {
      const startedAt = Date.now();
      // Only the site-wide banner is managed; retired homepage rows stay stored but unlisted.
      let query = ctx.supabase
        .from('announcements')
        .select('*', { count: 'planned' })
        .eq('announcement_type', 'banner')
        .order('priority', { ascending: false })
        .order('created_at', { ascending: false })
        .range(input.offset, input.offset + input.limit - 1);

      if (input.activeOnly) {
        query = query.eq('active', true);
      }

      const { data, error, count } = await query;

      if (error) {
        throw createAdminOperationError('读取公告列表', error);
      }

      // Get stats
      const statsQuery = await ctx.supabase
        .from('announcements')
        .select('active, type')
        .eq('announcement_type', 'banner');

      const stats = {
        total: statsQuery.data?.length ?? 0,
        active: statsQuery.data?.filter(a => a.active === 'true').length ?? 0,
        inactive: statsQuery.data?.filter(a => a.active === 'false').length ?? 0,
        byType: {
          info: statsQuery.data?.filter(a => a.type === 'info').length ?? 0,
          warning: statsQuery.data?.filter(a => a.type === 'warning').length ?? 0,
          success: statsQuery.data?.filter(a => a.type === 'success').length ?? 0,
          error: statsQuery.data?.filter(a => a.type === 'error').length ?? 0,
        },
      };

      const result = {
        announcements: data ?? [],
        total: count ?? 0,
        hasMore: (count ?? 0) > input.offset + input.limit,
        stats,
      };

      logAdminEndpointMetric('admin.getAllAnnouncements', startedAt, {
        queryCount: 2,
        countStrategy: 'planned',
        pageSize: input.limit,
        returnedCount: result.announcements.length,
      });

      return result;
    }),

  /**
   * Create a new announcement
   */
  createAnnouncement: adminProcedure
    .input(z.object({
      title: z.string().min(1).max(200),
      content: z.string().min(1).max(5000),
      type: z.enum(['info', 'warning', 'success', 'error', 'promo', 'announcement']).default('info'),
      announcementType: z.literal('banner').default('banner'),
      bannerStyle: z.enum(['info', 'warning', 'success', 'error', 'promo', 'announcement']).optional(),
      bannerLink: announcementLinkInputSchema,
      icon: z.string().default('Megaphone'),
      iconColor: z.string().default('text-blue-500'),
      tag: z.string().optional(),
      tagColor: z.string().default('blue'),
      priority: z.number().int().min(0).max(100).default(0),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { data, error } = await ctx.supabase
        .from('announcements')
        .insert({
          title: input.title,
          content: input.content,
          type: input.type,
          announcement_type: input.announcementType,
          banner_style: input.bannerStyle ?? input.type,
          banner_link: input.bannerLink ?? null,
          icon: input.icon,
          icon_color: input.iconColor,
          tag: input.tag,
          tag_color: input.tagColor,
          priority: input.priority,
          active: 'true',
          start_date: input.startDate ?? new Date().toISOString(),
          end_date: input.endDate ?? null,
          created_by: ctx.profileId,
        })
        .select()
        .single();

      if (error) {
        throw createAdminOperationError('创建公告', error);
      }

      return data;
    }),

  /**
   * Update an announcement
   */
  updateAnnouncement: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      title: z.string().min(1).max(200).optional(),
      content: z.string().min(1).max(5000).optional(),
      type: z.enum(['info', 'warning', 'success', 'error', 'promo', 'announcement']).optional(),
      announcementType: z.literal('banner').optional(),
      bannerStyle: z.enum(['info', 'warning', 'success', 'error', 'promo', 'announcement']).optional(),
      bannerLink: announcementLinkInputSchema,
      icon: z.string().optional(),
      iconColor: z.string().optional(),
      tag: z.string().optional(),
      tagColor: z.string().optional(),
      priority: z.number().int().min(0).max(100).optional(),
      active: z.enum(['true', 'false']).optional(),
      startDate: z.string().optional(),
      endDate: z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const updateData: Record<string, unknown> = {
        updated_at: new Date().toISOString(),
      };
      if (input.title !== undefined) updateData.title = input.title;
      if (input.content !== undefined) updateData.content = input.content;
      if (input.type !== undefined) updateData.type = input.type;
      if (input.announcementType !== undefined) updateData.announcement_type = input.announcementType;
      if (input.bannerStyle !== undefined) updateData.banner_style = input.bannerStyle;
      if (input.bannerLink !== undefined) updateData.banner_link = input.bannerLink;
      if (input.icon !== undefined) updateData.icon = input.icon;
      if (input.iconColor !== undefined) updateData.icon_color = input.iconColor;
      if (input.tag !== undefined) updateData.tag = input.tag;
      if (input.tagColor !== undefined) updateData.tag_color = input.tagColor;
      if (input.priority !== undefined) updateData.priority = input.priority;
      if (input.active !== undefined) updateData.active = input.active;
      if (input.startDate !== undefined) updateData.start_date = input.startDate;
      if (input.endDate !== undefined) updateData.end_date = input.endDate;

      const { data, error } = await ctx.supabase
        .from('announcements')
        .update(updateData)
        .eq('id', input.id).eq('announcement_type', 'banner')
        .select()
        .single();

      if (error) {
        throw createAdminOperationError('更新公告', error);
      }

      return data;
    }),

  /**
   * Delete an announcement
   */
  deleteAnnouncement: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { error } = await ctx.supabase
        .from('announcements')
        .delete()
        .eq('id', input.id).eq('announcement_type', 'banner');

      if (error) {
        throw createAdminOperationError('删除公告', error);
      }

      return { success: true };
    }),
};
