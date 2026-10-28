/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { assertSeparateSummaryModel, summaryPolicy } from '../artifacts/summaryPolicy';
import { readAdmissionConfiguration, readAdmissionModule } from '../runtime/admissionConfiguration';
import { readAdmissionSettings } from '../runtime/newWorkGate';
import { AGENT_TURN_REQUEST_FORMAT } from '../runtime/providerRequest';
import { readPurposeBudgets } from '../runtime/purposeBudgets';
import { RESEARCH_THRESHOLDS_KEY } from '../runtime/researchAdmission';
import { rowFor } from '../runtime/settingsRows';
import type { PricingDeps } from '../runtime/pricingAdmission';
import { CORE_PATH_SETTING, coreSetting, HISTORY_ITEMS } from './chat';
import { startThresholdCredits, turnPolicy } from './policy';
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
  /** The start threshold L of this turn: one normal turn's cost, the mentor's L (purpose skill) plus the organizer's
   * (attached_organizer), each from billing_payg_start_thresholds as the old path claimed each call (Owner 10-01, 10-28). */
  startCredits: number;
};

export class MentorCatalogError extends Error {
  constructor(readonly code: string) { super(code); }
}
const KNOWN = /^[A-Z][A-Z0-9_]{2,63}$/;

export async function mentorCatalog(admin: SupabaseClient, input: { moduleId: string; organize: boolean; pricing?: PricingDeps })
  : Promise<MentorCatalog> {
  // Every setting from the admission configuration rows (one cached query), as chat.ts.
  const configuration = readAdmissionConfiguration(admin);
  const rows = await configuration;
  const core = rowFor(rows, CORE_PATH_SETTING);
  const config = coreSetting.safeParse(core.error ? null : core.data?.value);
  if (!config.success || !config.data.enabled) throw new MentorCatalogError('TURN_CORE_DISABLED');
  const [settings, budgets, module] = await Promise.all([readAdmissionSettings(admin, configuration),
    readPurposeBudgets(admin, configuration), readAdmissionModule(admin, input.moduleId)]);
  if (module.error || module.data?.active !== true || typeof module.data.model_id !== 'string')
    throw new MentorCatalogError('TURN_MENTOR_DENIED');
  try {
    const mentor = await chatQuote(admin, { configuration: rows, modelId: module.data.model_id,
      inputBytes: budgets?.interactive.inputBytes ?? MENTOR_INPUT_BYTES,
      deps: input.pricing, use: { phase: 'skill', requestFormat: AGENT_TURN_REQUEST_FORMAT, purpose: 'interactive' } });
    let organizer: ChatQuote | null = null;
    if (input.organize) {
      const summary = summaryPolicy(Object.fromEntries((rows.data ?? []).map(r => [r.key, r.value])), module.data.model_id);
      organizer = await chatQuote(admin, { configuration: rows, modelId: summary.modelId, inputBytes: budgets?.organize.inputBytes ?? ORGANIZER_INPUT_BYTES,
        deps: input.pricing, key: await mentor.credential(), use: { phase: 'attached_organizer', requestFormat: AGENT_TURN_REQUEST_FORMAT, purpose: 'organize',
          outputCap: summary.maxTokens } });
      assertSeparateSummaryModel(mentor.model, organizer.model);
    }
    const thresholds = rowFor(rows, RESEARCH_THRESHOLDS_KEY), setting = thresholds.error ? null : thresholds.data?.value;
    const mentorL = startThresholdCredits(setting, mentor.model, 'skill', mentor.q, mentor.multiplier);
    const organizerL = organizer ? startThresholdCredits(setting, organizer.model, 'attached_organizer', organizer.q, organizer.multiplier) : 0;
    if (mentorL === undefined || organizerL === undefined) throw new MentorCatalogError('TURN_START_THRESHOLD_UNCONFIGURED');
    return { config: config.data, mentor, organizer, brandIdentity: settings.ok ? settings.identityGuard ?? true : true,
      startCredits: mentorL + organizerL };
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
    startThresholdCredits: catalog.startCredits, pricing: mentor.pricing,
    limits: { model: 1 + freeTools + (organizer ? 1 : 0), paidTools: 0, freeTools, decisions: 0 },
    otherModelCalls: organizer ? [{ upperUsd: organizer.upperUsd, multiplier: organizer.multiplier }] : [],
    stopLoss: catalog.config.stopLoss, historyItems: HISTORY_ITEMS, inputBytes: mentor.inputLimit,
    frozen: { modelId: mentor.modelId, model: mentor.model, ...(organizer ? { organizerModelId: organizer.modelId } : {}) } }),
  // V2-8: recovery prices a call whose cost is unknown with the model and price table frozen here, per model id (two models).
  models: Object.fromEntries([mentor, ...(organizer ? [organizer] : [])].map(q => [q.modelId, q.model])),
  pricings: Object.fromEntries([mentor, ...(organizer ? [organizer] : [])].map(q => [q.modelId, q.pricing])),
  mentor: { moduleId: input.moduleId, stepId: input.stepId } };
}
