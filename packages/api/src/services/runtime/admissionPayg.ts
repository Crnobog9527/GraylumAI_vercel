/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The PAYG step of runtime admission (moved out of admission.ts unchanged): trims the optional history read to the
// profile's tool ceiling, freezes the message budget and the per-call prices, and turns the run into a bill2.v2 run.
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { frozenCallPolicy, type FrozenPaygRun, type FrozenRun } from '../bill2/service';
import { READ_HISTORY_TOOL } from './agentTools';
import { freezePaygMessageBudget } from './paygMessageBudget';
import { freezeStagingPaygPricing } from './paygPricing';
import type { StagingPolicy } from './stagingPolicy';
import type { readPaygPolicies } from './realHost';

type PaygContext = Parameters<typeof freezePaygMessageBudget>[0] & { tools: string[]; historyRead?: unknown };

type Template = FrozenPaygRun['callPolicy'][number] | NonNullable<Awaited<ReturnType<ReturnType<typeof readPaygPolicies>>>>[number];

export async function freezeAdmissionPayg(input: {
  admin: SupabaseClient; context: PaygContext; billing: FrozenRun | FrozenPaygRun;
  paygTemplates: readonly Template[]; realCalls: StagingPolicy['callPolicies'] | undefined;
  selectedIds: ReadonlySet<string>; modelId: string; billingUnit: NonNullable<FrozenPaygRun['rules']['billingUnit']>;
  /** DB-PERF PR-3: model rows admission already read, reused for the price snapshots. */
  modelRows?: readonly Record<string, unknown>[];
}): Promise<FrozenRun | FrozenPaygRun> {
  const { context, billing, paygTemplates, realCalls, selectedIds } = input;
  // #878 regression: a PAYG call carries at most its profile's maxTools (SQL 0162 caps it at 2). The
  // history read is the optional extra tool, guided only by its own description, so it alone is dropped.
  const maxTools = Math.min(...paygTemplates.filter(p => p.modelId === input.modelId).map(p => p.payg?.maxTools ?? 0));
  if (context.historyRead && context.tools.length > maxTools) {
    context.tools = context.tools.filter(name => name !== READ_HISTORY_TOOL); delete context.historyRead;
  }
  freezePaygMessageBudget(context, paygTemplates);
  billing.sourceHash = createHash('sha256').update(JSON.stringify(context)).digest('hex');
  const templates = paygTemplates.filter(p => selectedIds.has(p.modelId));
  const callPolicy = realCalls
    ? await freezeStagingPaygPricing(input.admin, realCalls.map(p => ({ ...p, payg: templates.find(t => t.modelId === p.modelId)?.payg })),
      {}, input.modelRows)
    : templates.map(p => frozenCallPolicy.parse(p));
  if (callPolicy.length !== selectedIds.size || callPolicy.some(p => !p.payg)) throw new Error('BILL2_PAYG_QUOTE_INVALID');
  return { ...billing, contractVersion: 'bill2.v2', callPolicy,
    rules: { ...billing.rules, billingUnit: input.billingUnit }, limits: { ...billing.limits, credits: 0 } } as FrozenPaygRun;
}
