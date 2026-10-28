/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertSeparateSummaryModel, summaryPolicy } from '../artifacts/summaryPolicy';
import { readAdmissionConfiguration, readAdmissionModule } from '../runtime/admissionConfiguration';
import { catalogRead } from '../runtime/catalogCache';
import { readAdmissionSettings } from '../runtime/newWorkGate';
import { AGENT_TURN_REQUEST_FORMAT } from '../runtime/providerRequest';
import { readPurposeBudgets } from '../runtime/purposeBudgets';
import type { PricingDeps } from '../runtime/pricingAdmission';
import { CORE_PATH_SETTING, coreSetting, HISTORY_ITEMS } from './chat';
import { turnPolicy } from './policy';
import { chatQuote, QuoteError, type ChatQuote } from './quote';

/*
 * CORE-PATH-V2 kind=mentor, before turn_open: everything the turn freezes comes from the catalog cache (plan 2.4). The mentor
 * model is the draft's module model (the client names the module; turn_open refuses any other), quoted for the agent-turn
 * request format; the organizer is the summary model (v3_summary_model_id, never the dialogue model), quoted for the attached
 * organizer use with its summary output limit. Model calls (plan 2.5.3, 3.1 budget <= 11 round trips): the mentor's reply, one
 * continuation after a read_skill_file (a free tool answered from the process cache, no row), and the organizer; an opening
 * cannot call tools, so it has no continuation.
 */
export const MENTOR_INPUT_BYTES = 90000, ORGANIZER_INPUT_BYTES = 112000;
export type MentorCatalog = {
  config: { enabled: boolean; stopLoss: Parameters<typeof turnPolicy>[0]['stopLoss'] };
  mentor: ChatQuote; organizer: ChatQuote | null; brandIdentity: boolean;
};

export class MentorCatalogError extends Error {
  constructor(readonly code: string) { super(code); }
}
const KNOWN = /^[A-Z][A-Z0-9_]{2,63}$/;

export async function mentorCatalog(admin: SupabaseClient, input: { moduleId: string; organize: boolean; pricing?: PricingDeps })
  : Promise<MentorCatalog> {
  const core = await catalogRead(admin, 'settings', 'core-path-v2', () =>
    admin.from('system_settings').select('value').eq('key', CORE_PATH_SETTING).maybeSingle());
  const config = coreSetting.safeParse(core.error ? null : core.data?.value);
  if (!config.success || !config.data.enabled) throw new MentorCatalogError('TURN_CORE_DISABLED');
  const configuration = readAdmissionConfiguration(admin);
  const [settings, budgets, rows, module] = await Promise.all([readAdmissionSettings(admin, configuration),
    readPurposeBudgets(admin, configuration), configuration, readAdmissionModule(admin, input.moduleId)]);
  if (module.error || module.data?.active !== true || typeof module.data.model_id !== 'string')
    throw new MentorCatalogError('TURN_MENTOR_DENIED');
  try {
    const mentor = await chatQuote(admin, { modelId: module.data.model_id, inputBytes: budgets?.interactive.inputBytes ?? MENTOR_INPUT_BYTES,
      deps: input.pricing, use: { phase: 'skill', requestFormat: AGENT_TURN_REQUEST_FORMAT, purpose: 'interactive' } });
    let organizer: ChatQuote | null = null;
    if (input.organize) {
      const summary = summaryPolicy(Object.fromEntries((rows.data ?? []).map(r => [r.key, r.value])), module.data.model_id);
      organizer = await chatQuote(admin, { modelId: summary.modelId, inputBytes: budgets?.organize.inputBytes ?? ORGANIZER_INPUT_BYTES,
        deps: input.pricing, use: { phase: 'attached_organizer', requestFormat: AGENT_TURN_REQUEST_FORMAT, purpose: 'organize',
          outputCap: summary.maxTokens } });
      assertSeparateSummaryModel(mentor.model, organizer.model);
    }
    return { config: config.data, mentor, organizer, brandIdentity: settings.ok ? settings.identityGuard ?? true : true };
  } catch (error) {
    if (error instanceof QuoteError) throw new MentorCatalogError(error.code);
    const message = error instanceof Error ? error.message : '';
    throw new MentorCatalogError(KNOWN.test(message) ? message : 'TURN_QUOTE_UNAVAILABLE');
  }
}

/** The frozen numbers of one mentor turn (G_turn, U_turn, the call limits) and what turn_mentor_context checks. */
export function mentorPolicy(catalog: MentorCatalog, input: { opening: boolean; stepId: string; moduleId: string }) {
  const { mentor, organizer } = catalog;
  const freeTools = input.opening ? 0 : 1;
  // turn_mentor_context reads its input from policy.mentor (the per-kind hook of turn_open).
  return { ...turnPolicy({ q: mentor.q, multiplier: mentor.multiplier, modelUpperUsd: mentor.upperUsd,
    limits: { model: 1 + freeTools + (organizer ? 1 : 0), paidTools: 0, freeTools, decisions: 0 },
    otherModelCalls: organizer ? [{ upperUsd: organizer.upperUsd, multiplier: organizer.multiplier }] : [],
    stopLoss: catalog.config.stopLoss, historyItems: HISTORY_ITEMS, inputBytes: mentor.inputLimit,
    frozen: { modelId: mentor.modelId, model: mentor.model, ...(organizer ? { organizerModelId: organizer.modelId } : {}) } }),
  mentor: { moduleId: input.moduleId, stepId: input.stepId } };
}
