/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {z} from 'zod';
import type {MethodInformationField} from './opcMethodPolicy';

export const stepConfirmationSchema = z.object({
  requiredComplete: z.boolean(),
  stepConfirmed: z.boolean(),
  stepReady: z.boolean(),
  needsLookFieldIds: z.array(z.string().min(1).max(128)).max(100),
}).strict();
export type StepConfirmation = z.infer<typeof stepConfirmationSchema>;
type Information = {
  schema: readonly MethodInformationField[];
  values?: Record<string, {value?: unknown; status?: string; basis?: string}>;
  meta?: Record<string, {source?: string; basis?: string}>;
};

/** Display readiness only; the existing snapshot/version-checked confirm API is the write authority. */
export function stepConfirmation(state: Information | undefined, valid: boolean): StepConfirmation {
  const fields = state?.schema ?? [];
  const hasContent = (id: string) => {
    const value = state?.values?.[id]?.value;
    return typeof value === 'string' && value.trim().length > 0;
  };
  // Explicit deferrals carry a reason in value. An empty status alone is not an answer.
  const requiredComplete = fields.length > 0 && fields.every(field => !field.required || hasContent(field.id));
  const stepConfirmed = valid === true;
  const needsLookFieldIds = stepConfirmed ? [] : fields.filter(field => {
    const value = state?.values?.[field.id];
    const meta = state?.meta?.[field.id];
    if (!hasContent(field.id) || meta?.source === 'user' ||
        value?.status === 'confirmed' || value?.status === 'deferred') return false;
    // Missing legacy provenance is not proof of manual entry. Never adopt pending suggestions here.
    return (meta?.basis ?? value?.basis) === 'agent_proposal' || value?.status === 'provisional';
  }).map(field => field.id);
  return {requiredComplete, stepConfirmed, stepReady: requiredComplete && !stepConfirmed, needsLookFieldIds};
}

/** One permission-checked opc_query response supplies both values and confirmation validity. */
export function withStepConfirmation<T extends {
  information?: Record<string, Information>;
  snapshot?: {steps?: Record<string, {valid?: boolean}>};
}>(draft: T) {
  return {...draft, stepConfirmation: Object.fromEntries(Object.entries(draft.information ?? {}).map(([id, state]) =>
    [id, stepConfirmation(state, draft.snapshot?.steps?.[id]?.valid === true)]))};
}
