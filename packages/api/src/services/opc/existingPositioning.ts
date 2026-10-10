/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type {HostTurnContext} from '../runtime/hostTurn';

const REVIEW = [
  'Existing-positioning entry: review the supplied positioning, do not restart the interview.',
  'Use the current user message and recorded material; the organizer maps it across the pinned Skill fields.',
  'Review only this step, ask only genuine gaps or contradictions, and retain the confirmation-card gate.',
  'Never treat supplied positioning or verbal assent as confirmation or advance for the user.',
].join(' ');
const INTAKE = [
  'For this empty opening, override the normal first-gap question: ask the user to paste or describe their existing positioning.',
  'Explain that it will be organized into step notes and checked one step at a time with confirmation cards.',
  'Do not ask the first interview question, propose positioning, or claim anything has been recorded yet.',
].join(' ');

/** `mode` must come from the actor-scoped opc_query, never a turn input or user text.
 * Add the result after the stable mentor prefix, only for newly admitted mentor turns.
 * Use the complete composed string for both additionalInstructions and stableAdditionalInstructions.
 * This does not write fields, grant confirmation, select a Skill or create a second session.
 */
export function existingPositioningInstructions(mode: unknown, host: HostTurnContext): string {
  if (mode !== 'manual') return '';
  const hasMaterial = host.checklist.some(step => step.fields.some(field =>
    field.status !== 'missing' || Boolean(field.value?.trim()) || field.valueOmitted || field.hasPendingSuggestion));
  const intake = host.opening && host.stepId === host.checklist[0]?.id && !hasMaterial &&
    !host.confirmation?.stepConfirmed && !host.confirmation?.stepReady && !host.updatedFieldIds;
  return '\n' + REVIEW + (intake ? '\n' + INTAKE : '');
}
