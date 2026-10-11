/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {buildStepSummaryNotice} from './stepSummary';
import {stepConfirmation} from '../../shared/opcStepConfirmation';
import {fieldElicitation, type MethodInformationField} from '../../shared/opcMethodPolicy';
import {GROUNDED_CARD_CONTRACT} from '../runtime/groundedCard';
import {HOST_TURN_MAX_BYTES, hostTurnContextSchema, type HostTurnContext} from '../runtime/hostTurn';
import {organizerAnswerCard, type AnsweredCard} from './answerCard';

export type CaptureState = {
  schema: readonly MethodInformationField[];
  values?: Record<string, {value?: unknown; status?: string; nature?: string; basis?: string}>;
  meta?: Record<string, {protected?: boolean; source?: string; basis?: string; hasPendingSuggestion?: boolean;
    suggestion?: {value?: unknown; nature?: unknown; basis?: unknown}; pendingSuggestion?: PendingSuggestion}>;
  notes?: unknown[];
};
type Step = {id: string; title: string};
type PendingSuggestion = {value: string; nature: unknown; basis: unknown};
export function captureHostContext(steps: readonly Step[], information: Record<string, CaptureState>,
  stepId: string, opening: boolean, updatedFieldIds?: string[], confirmed: Record<string, boolean> = {}, summary = false): HostTurnContext {
  const context: HostTurnContext = {cardContract: GROUNDED_CARD_CONTRACT, stepId, opening,
    ...(summary ? {stepSummary: buildStepSummaryNotice(information[stepId]!)} : {}),
    confirmation: stepConfirmation(information[stepId], confirmed[stepId] === true),
    ...(updatedFieldIds ? {updatedFieldIds} : {}), checklist: steps.map(step => ({
    id: step.id, title: step.title,
    fields: (information[step.id]?.schema ?? []).map(field => {
      const state = information[step.id]!;
      const existing = state.values?.[field.id];
      const status = existing?.status === 'confirmed' || existing?.status === 'deferred'
        ? existing.status : typeof existing?.value === 'string' && existing.value.trim() ? 'draft' : 'missing';
      return {id: field.id, title: field.title ?? field.id, required: Boolean(field.required),
        role: fieldElicitation(field), status, protected: state.meta?.[field.id]?.protected ?? true,
        value: typeof existing?.value === 'string' ? existing.value : '', nature: existing?.nature ?? 'unknown',
        source: state.meta?.[field.id]?.source ?? 'unknown',
        basis: state.meta?.[field.id]?.source === 'user' ? 'user_statement'
          : state.meta?.[field.id]?.basis ?? existing?.basis ?? 'unknown',
        hasPendingSuggestion: Boolean(state.meta?.[field.id]?.hasPendingSuggestion)};
    }),
  }))};
  // Same compression order as capture: omit confirmed values first, then fail closed.
  if (Buffer.byteLength(JSON.stringify(context)) > HOST_TURN_MAX_BYTES) {
    for (const step of context.checklist) for (const field of step.fields) {
      if (field.status === 'confirmed') { field.value = ''; field.valueOmitted = true; }
    }
  }
  if (Buffer.byteLength(JSON.stringify(context)) > HOST_TURN_MAX_BYTES) throw new Error('OPC_CAPTURE_INPUT_LIMIT');
  return hostTurnContextSchema.parse(context);
}
export function captureFocus(state: CaptureState): string {
  const missing = state.schema.find(field => field.required &&
    !(typeof state.values?.[field.id]?.value === 'string' && String(state.values[field.id]!.value).trim()));
  const field = missing ?? state.schema.find(field => state.values?.[field.id]?.status !== 'confirmed') ?? state.schema.at(-1);
  if (!field) throw new Error('OPC_QUESTION_NOT_REACHED');
  return field.id;
}
export function captureOrganizerInput(host: HostTurnContext, information: Record<string, CaptureState>,
  confirmed: Record<string, boolean>, userInput: string, answer?: AnsweredCard): string {
  const checklist = host.checklist.map(step => ({...step, confirmed: Boolean(confirmed[step.id]),
    fields: step.fields.map(field => {
      const description = information[step.id]?.schema.find(item => item.id === field.id)?.description;
      return {id: field.id, title: field.title, required: field.required,
      ...(description !== undefined ? {description} : {}),
      role: field.role, status: field.status, protected: field.protected, elicit: field.role,
      value: information[step.id]?.values?.[field.id]?.value ?? '',
      nature: information[step.id]?.values?.[field.id]?.nature ?? 'unknown',
      ...(pending(information[step.id], field.id) ? {pendingSuggestion: pending(information[step.id], field.id)} : {}),
    }; }),
    ...(!confirmed[step.id] ? {notes: information[step.id]?.notes ?? []} : {}),
  }));
  const serialize = () => JSON.stringify({captureFormat: 'v2',
    userInput: host.updatedFieldIds ? '' : userInput,
    ...(host.updatedFieldIds ? {hostEvent: {kind: 'checklist_updated', fieldIds: host.updatedFieldIds}} : {}),
    ...organizerAnswerCard(answer),
    originalStepId: host.stepId, checklist});
  let input = serialize();
  if (input.length > 24000) {
    for (const step of checklist) if (step.confirmed) for (const field of step.fields) field.value = '';
    input = serialize();
  }
  if (input.length > 24000) throw new Error('OPC_CAPTURE_INPUT_LIMIT');
  return input;
}

const pending = (state: CaptureState | undefined, fieldId: string) => state?.meta?.[fieldId]?.pendingSuggestion;

/** Projection generated by B1, after opc_step_material, is the only value/status authority.
 * Suggestion text is not frozen (the mentor reads that material): it comes from the live read,
 * only for a field the frozen projection marks as having a pending suggestion. Organizer-only. */
export function captureFrozenInformation(information: Record<string, CaptureState>,
  steps: Record<string, {information?: CaptureState['values']; fieldMeta?: CaptureState['meta']; notes?: unknown[]}>) {
  return Object.fromEntries(Object.entries(information).map(([id, state]) => {
    const frozen = steps[id];
    if (!frozen) throw new Error('OPC_CAPTURE_MATERIAL_MISMATCH');
    const meta = Object.fromEntries(Object.entries(frozen.fieldMeta ?? {}).map(([fieldId, item]) => {
      const live = state.meta?.[fieldId]?.suggestion;
      return [fieldId, item?.hasPendingSuggestion && typeof live?.value === 'string' && live.value.trim()
        ? {...item, pendingSuggestion: {value: live.value, nature: live.nature, basis: live.basis}} : item];
    }));
    return [id, {schema: state.schema, values: frozen.information ?? {}, meta, notes: frozen.notes ?? []}];
  }));
}
