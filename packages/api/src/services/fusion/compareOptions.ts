/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readMembershipEntitlements } from '../membershipEntitlements';
import { FUSION_COMPARE_SURFACE, publicModelChoices } from '../modelIdentity/display';
import type { BillingRpc } from '../bill2/service';
import { loadStagingPolicy } from '../runtime/stagingPolicy';
import { readFusionSettings } from './settings';
import { fusionModelOptions } from './settingsAdmin';

/** What the compare picker shows when it opens (FUSION-COMPARE §3.3): whether compare can be used at all, the models the
 * administrator allows (with the real configured names, Owner 2026-10-17), which are ticked by default, and the bounds on how
 * many may be ticked. Read only: nothing is held. A model that stopped being runnable since the settings were saved (key,
 * host policy, quote, reasoning profile, output capacity) is left out by the same live eligibility check a save uses, so the
 * defaults are never a selection that the first estimate would refuse. */
export async function compareOptions(admin: SupabaseClient, actorId: string, env: Record<string, string | undefined> = process.env) {
  const settings = (await readFusionSettings(admin)).compare;
  const off = { enabled: false as const };
  if (!settings.enabled) return { ...off, reason: 'disabled' as const };
  const entitlements = await readMembershipEntitlements(admin, actorId);
  if (!entitlements.allowFusionCompare) return { ...off, reason: 'plan' as const };
  const rows = await admin.from('ai_models').select('id,name,model_id,is_active').in('id', settings.allowedModelIds);
  if (rows.error) throw new Error('FUSION_SETTINGS_UNAVAILABLE');
  const window = await loadStagingPolicy(admin as unknown as BillingRpc, actorId, env).catch(() => { throw new Error('FUSION_SETTINGS_UNAVAILABLE'); });
  const runnable = new Set((await fusionModelOptions(admin, actorId, env, window)).models.filter(model => model.compare).map(model => model.id));
  const byId = new Map((rows.data ?? []).filter(row => row.is_active === 'true' && runnable.has(row.id as string)).map(row => [row.id as string, row]));
  const listed = settings.allowedModelIds.map(id => byId.get(id)).filter((row): row is NonNullable<typeof row> => Boolean(row))
    .map(row => ({ id: row.id as string, name: String(row.name ?? row.model_id) }));
  const labels = new Map(publicModelChoices(listed, { surface: FUSION_COMPARE_SURFACE }).map(choice => [choice.id, choice.label]));
  const max = Math.min(entitlements.fusionCompareMaxModels, 8);
  const defaults = settings.defaultModelIds.filter(id => labels.has(id)).slice(0, max);
  const min = Math.min(settings.minModels, max);
  return { enabled: true as const, models: listed.map(model => ({ id: model.id, name: labels.get(model.id)! })), defaultModelIds: defaults,
    minModels: min, maxModels: max,
    // Fewer usable models than the minimum: the picker explains instead of offering a choice that can never be made.
    usable: listed.length >= min };
}
