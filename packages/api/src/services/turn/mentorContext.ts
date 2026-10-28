/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { MethodInformationField } from '../../shared/opcMethodPolicy';
import { captureHostContext, captureOrganizerInput, type CaptureState } from '../opc/captureContext';
import type { HostTurnContext } from '../runtime/hostTurn';

/*
 * CORE-PATH-V2 kind=mentor: the draft state turn_open read for this turn (turn_mentor_context, 0422). The checklist the mentor
 * and the organizer see is the frozen work projection of the round (values, field provenance, protection), exactly what the old
 * path froze as the turn's scope material; the step versions read here are handed back to turn_close, which applies the
 * organizer's patches only when no step changed in between (opc_capture_apply's material check).
 */
const uuid = z.string().uuid();
const field = z.object({ id: z.string().min(1).max(128), title: z.string().max(256).optional(), description: z.string().optional(),
  required: z.boolean().optional(), elicitation: z.enum(['user_fact', 'agent_proposal']).optional() }).passthrough();
const step = z.object({ id: z.string().min(1).max(128), title: z.string().max(256), information: z.array(field).max(100).default([]),
  resources: z.array(z.string().min(1).max(240)).min(1).max(64) }).passthrough();
const workStep = z.object({ information: z.record(z.string(), z.any()).optional(), fieldMeta: z.record(z.string(), z.any()).optional(),
  notes: z.array(z.unknown()).optional(), valid: z.boolean().optional(), version: z.number().int().nonnegative() }).passthrough();
export const mentorContextSchema = z.object({
  draftId: uuid, projectId: uuid, roundId: uuid, mode: z.string(), moduleId: uuid, skillId: uuid, revisionId: uuid,
  packageHash: z.string().regex(/^[a-f0-9]{64}$/), steps: z.array(step).min(1).max(32),
  work: z.object({ roundId: uuid, steps: z.record(z.string(), workStep) }).passthrough(),
}).strict();
export type MentorContext = z.infer<typeof mentorContextSchema>;

export type MentorState = {
  context: MentorContext; information: Record<string, CaptureState>; confirmed: Record<string, boolean>;
  versions: Record<string, number>;
  /** The old path's scope material shape ({content:{brief, material, roundId, work}}), given to the model as data. */
  scopeMaterial: unknown;
};

export function mentorState(raw: unknown, stepId: string): MentorState {
  const context = mentorContextSchema.parse(raw);
  const information: Record<string, CaptureState> = {}, confirmed: Record<string, boolean> = {}, versions: Record<string, number> = {};
  for (const s of context.steps) {
    const work = context.work.steps[s.id];
    if (!work) throw new Error('TURN_MENTOR_CONTEXT_INVALID');
    information[s.id] = { schema: s.information as MethodInformationField[], values: work.information ?? {}, meta: work.fieldMeta ?? {},
      notes: work.notes ?? [] };
    confirmed[s.id] = work.valid === true;
  }
  for (const [id, work] of Object.entries(context.work.steps)) versions[id] = work.version;
  return { context, information, confirmed, versions,
    scopeMaterial: { content: { brief: 'mentor:' + stepId, material: '', roundId: context.roundId, work: context.work } } };
}

export function mentorHost(state: MentorState, stepId: string, opening: boolean): HostTurnContext {
  return captureHostContext(state.context.steps, state.information, stepId, opening, undefined, state.confirmed);
}

/** The organizer's checklist input (captureFormat v2) and the object turn_close binds withdrawals to. */
export function mentorOrganizerInput(state: MentorState, host: HostTurnContext, text: string): { text: string; value: unknown } {
  const input = captureOrganizerInput(host, state.information, state.confirmed, text);
  return { text: input, value: JSON.parse(input) };
}

export function resourcesOf(state: MentorState, stepId: string): readonly string[] {
  const s = state.context.steps.find(item => item.id === stepId);
  if (!s) throw new Error('TURN_MENTOR_STEP_DENIED');
  return s.resources;
}
