/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-2b: admin view and write path for research_tools_config (migration 0254).
// The API validates the full shape; the database re-checks admin, revision and the hard-cap rule.
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readResearchToolsConfig, researchToolsConfigSchema } from './vendors/config';
import { RESEARCH_VENDORS } from './vendors/types';

const vendorSwitch = z.object({ enabled: z.boolean() }).strict();
/**
 * What an admin submits. Attestations are not part of it: the server stamps who and when for the
 * vendors listed in `attestHardCap` and keeps earlier attestations for the rest.
 */
export const researchToolsUpdateSchema = z.object({
  config: z.object({
    version: z.literal(1),
    enabled: z.boolean(),
    vendors: z.object({ tikhub: vendorSwitch, parallel: vendorSwitch, firecrawl: vendorSwitch }).strict(),
    verifiedPlatforms: z.unknown(),
    benchmarkPlatforms: z.unknown(),
    routes: z.unknown(),
    limits: z.unknown(),
    recentGrowth: z.unknown(),
  }).strict(),
  attestHardCap: z.array(z.enum(RESEARCH_VENDORS)).max(RESEARCH_VENDORS.length)
    .refine(list => new Set(list).size === list.length, 'Each supplier at most once'),
  expectedRevision: z.number().int().min(0).max(9999999998),
}).strict();
export type ResearchToolsUpdate = z.infer<typeof researchToolsUpdateSchema>;

const AUDIT_ACTION = 'research_tools_config_set';

function unavailable(): never {
  throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'RESEARCH_TOOLS_UNAVAILABLE' });
}

/** Builds the full config the database will store, for validation before the call. */
function candidate(input: ResearchToolsUpdate, prior: Awaited<ReturnType<typeof readResearchToolsConfig>>, actorId: string) {
  const now = new Date().toISOString();
  const vendors = Object.fromEntries(RESEARCH_VENDORS.map(vendor => [vendor, {
    enabled: input.config.vendors[vendor].enabled,
    hardCapAttested: input.attestHardCap.includes(vendor)
      ? { by: actorId, at: now }
      : prior.config.vendors[vendor].hardCapAttested,
  }]));
  return { ...input.config, vendors };
}

export async function setResearchToolsConfig(db: SupabaseClient, actorId: string, input: unknown) {
  const update = researchToolsUpdateSchema.safeParse(input);
  if (!update.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'RESEARCH_TOOLS_INPUT_INVALID' });
  const prior = await readResearchToolsConfig(db);
  const full = researchToolsConfigSchema.safeParse(candidate(update.data, prior, actorId));
  if (!full.success) {
    const hardCap = full.error.issues.some(issue => /hard cap/.test(issue.message));
    throw new TRPCError({ code: 'BAD_REQUEST', message: hardCap ? 'RESEARCH_TOOLS_HARD_CAP_REQUIRED' : 'RESEARCH_TOOLS_INPUT_INVALID' });
  }
  const { vendors, ...rest } = full.data;
  const payload = { ...rest, vendors: Object.fromEntries(RESEARCH_VENDORS.map(v => [v, { enabled: vendors[v].enabled }])) };
  let result;
  try {
    result = await db.rpc('research_tools_config_set', {
      p_config: payload, p_attest_vendors: update.data.attestHardCap,
      p_expected_revision: update.data.expectedRevision, p_actor: actorId,
    });
  } catch { return unavailable(); }
  const code = result.error?.code;
  if (code === 'PT409') throw new TRPCError({ code: 'CONFLICT', message: '设置已被其他人修改，请重新读取后再保存' });
  if (code === '42501') throw new TRPCError({ code: 'FORBIDDEN', message: '当前账号无权修改这个设置' });
  if (code === '23514') {
    const hardCap = /HARD_CAP/.test(result.error?.message ?? '');
    throw new TRPCError({ code: 'BAD_REQUEST', message: hardCap ? 'RESEARCH_TOOLS_HARD_CAP_REQUIRED' : 'RESEARCH_TOOLS_INPUT_INVALID' });
  }
  if (result.error || !result.data) return unavailable();
}

/** Admin view: current state, last author and recent change summaries (never full values). */
export async function researchToolsView(db: SupabaseClient) {
  const state = await readResearchToolsConfig(db);
  try {
    const history = await db.from('user_activity_logs')
      .select('admin_id,details,created_at').eq('action', AUDIT_ACTION)
      .order('created_at', { ascending: false }).limit(10);
    if (history.error) return unavailable();
    const attesters = RESEARCH_VENDORS.map(v => state.config.vendors[v].hardCapAttested?.by ?? null);
    const ids = [...new Set([state.updatedBy, ...attesters, ...history.data.map(row => row.admin_id)]
      .filter((id): id is string => typeof id === 'string'))];
    const people = ids.length
      ? await db.from('profiles').select('id,email').in('id', ids)
      : { data: [] as Array<{ id: string; email: string | null }>, error: null };
    if (people.error) return unavailable();
    const email = (id: string | null) => people.data.find(p => p.id === id)?.email ?? null;
    return {
      ...state,
      updatedByEmail: email(state.updatedBy),
      hardCapAttestedBy: Object.fromEntries(RESEARCH_VENDORS.map(v =>
        [v, email(state.config.vendors[v].hardCapAttested?.by ?? null)])),
      history: history.data.map(row => {
        const details = (row.details ?? {}) as Record<string, unknown>;
        return {
          revision: typeof details.revision === 'number' ? details.revision : null,
          enabled: details.enabled === true,
          vendorsEnabled: details.vendorsEnabled ?? null,
          hardCapAttested: Array.isArray(details.hardCapAttested) ? details.hardCapAttested : [],
          operatorEmail: email(row.admin_id),
          at: row.created_at as string,
        };
      }),
    };
  } catch { return unavailable(); }
}
