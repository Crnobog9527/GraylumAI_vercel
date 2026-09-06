/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { adminProcedure, router } from '../trpc';
import { packagePublicationInput, publishSkillPackage } from '../services/skills/publication';
import { resolvePublishedSkillSnapshot } from '../services/skillRuntime';

const skillColumns = 'id, skill_key, draft_content, status, published_version, published_content_hash, published_at';
const moduleColumns = 'id, title, description, skill_id, active, category, platform';
const idInput = z.object({ id: z.string().uuid() }).strict();
const pagination = z.object({ offset: z.number().int().min(0).default(0) }).strict().optional();
const draftContent = z.string().max(100_000);

export interface AdminSkill {
  id: string;
  skill_key: string;
  draft_content: string;
  status: 'draft' | 'published' | 'archived';
  published_version: number;
  published_content_hash: string | null;
  published_at: string | null;
}
export interface AdminSkillModule {
  id: string;
  title: string;
  description: string | null;
  skill_id: string | null;
  active: boolean;
  category: string;
  platform: string;
}

function assertResult(error: unknown, data: unknown, message: string): asserts data {
  if (error || !data) throw new TRPCError({ code: 'BAD_REQUEST', message });
}

export const skillsRouter = router({
  publishPackage: adminProcedure.input(packagePublicationInput).mutation(async ({ ctx, input }) => {
    try { return await publishSkillPackage(ctx.supabase, ctx.profileId, input); }
    catch { throw new TRPCError({ code: 'BAD_REQUEST', message: '完整包发布失败，请刷新版本并检查文件与资源计划' }); }
  }),
  revokeRevision: adminProcedure.input(z.object({ revisionId: z.string().uuid() }).strict()).mutation(async ({ ctx, input }) => {
    const { error } = await ctx.supabase.rpc('revoke_skill_revision', { p_revision_id: input.revisionId, p_actor_id: ctx.profileId });
    if (error) throw new TRPCError({ code: 'BAD_REQUEST', message: '撤销失败' });
    return { success: true };
  }),
  list: adminProcedure.input(pagination).query(async ({ ctx, input }) => {
    const offset = input?.offset ?? 0;
    const { data, error, count } = await ctx.supabase.from('skills')
      .select(skillColumns, { count: 'exact' }).order('skill_key').range(offset, offset + 49);
    assertResult(error, data, '读取 Skill 列表失败');
    return { skills: data as AdminSkill[], total: count ?? 0 };
  }),
  get: adminProcedure.input(idInput).query(async ({ ctx, input }) => {
    const { data, error } = await ctx.supabase.from('skills').select(skillColumns).eq('id', input.id).single();
    assertResult(error, data, 'Skill 不存在或读取失败');
    return data as AdminSkill;
  }),
  create: adminProcedure.input(z.object({
    skillKey: z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/),
    draftContent,
  }).strict()).mutation(async ({ ctx, input }) => {
    const { data, error } = await ctx.supabase.from('skills').insert({
      skill_key: input.skillKey, draft_content: input.draftContent,
      status: 'draft', created_by: ctx.profileId, updated_by: ctx.profileId,
    }).select(skillColumns).single();
    assertResult(error, data, '创建 Skill 失败，请确认标识没有重复');
    return data as AdminSkill;
  }),
  editDraft: adminProcedure.input(idInput.extend({ draftContent })).mutation(async ({ ctx, input }) => {
    const { data, error } = await ctx.supabase.from('skills')
      .update({ draft_content: input.draftContent, updated_by: ctx.profileId })
      .eq('id', input.id).select(skillColumns).single();
    assertResult(error, data, '保存草稿失败');
    return data as AdminSkill;
  }),
  publish: adminProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const { data, error } = await ctx.supabase.rpc('atomic_publish_skill', {
      p_skill_id: input.id, p_published_by: ctx.profileId,
      p_publish_metadata: { source: 'admin_skills' },
    });
    assertResult(error, data?.[0], '发布失败，请确认草稿非空后重试');
    return { success: true };
  }),
  archive: adminProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const { data, error } = await ctx.supabase.from('skills').update({
      status: 'archived', archived_by: ctx.profileId,
      archived_at: new Date().toISOString(), updated_by: ctx.profileId,
    }).eq('id', input.id).select(skillColumns).single();
    assertResult(error, data, '归档失败');
    return data as AdminSkill;
  }),
  listModules: adminProcedure.input(pagination).query(async ({ ctx, input }) => {
    const offset = input?.offset ?? 0;
    const { data, error, count } = await ctx.supabase.from('modules')
      .select(moduleColumns, { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + 49);
    assertResult(error, data, '读取模块列表失败');
    return { modules: data as AdminSkillModule[], total: count ?? 0 };
  }),
  createModule: adminProcedure.input(z.object({
    title: z.string().trim().min(1).max(100),
    description: z.string().trim().max(1000).default(''),
  }).strict()).mutation(async ({ ctx, input }) => {
    const { data, error } = await ctx.supabase.from('modules').insert({
      title: input.title, description: input.description, active: false,
      skill_id: null, category: 'other', platform: 'web', created_by: ctx.profileId,
    }).select(moduleColumns).single();
    assertResult(error, data, '创建模块失败');
    return data as AdminSkillModule;
  }),
  bindModule: adminProcedure.input(idInput.extend({ skillId: z.string().uuid().nullable() }))
    .mutation(async ({ ctx, input }) => {
      if (input.skillId) {
        const result = await ctx.supabase.from('skills').select('id').eq('id', input.skillId).single();
        assertResult(result.error, result.data, '绑定的 Skill 不存在');
      }
      // Rebinding requires a disabled module; CAS also closes concurrent enable.
      const { data, error } = await ctx.supabase.from('modules').update({ skill_id: input.skillId })
        .eq('id', input.id).eq('active', false).select(moduleColumns).single();
      assertResult(error, data, '绑定失败，请先停用模块再绑定');
      return data as AdminSkillModule;
    }),
  setModuleActive: adminProcedure.input(idInput.extend({ active: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      let update = ctx.supabase.from('modules').update({ active: input.active }).eq('id', input.id);
      if (input.active) {
        const { data: module, error } = await ctx.supabase.from('modules')
          .select('id, skill_id').eq('id', input.id).single();
        assertResult(error, module, '模块不存在或读取失败');
        try {
          await resolvePublishedSkillSnapshot(ctx.supabase, { id: module.id, skill_id: module.skill_id }, { allowInactive: true });
        } catch {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'MODULE_SKILL_UNAVAILABLE：请先绑定可用的已发布 Skill' });
        }
        update = update.eq('skill_id', module.skill_id);
      }
      const { data, error } = await update.select(moduleColumns).single();
      assertResult(error, data, '更新模块状态失败，请刷新后重试');
      return data as AdminSkillModule;
    }),
});
