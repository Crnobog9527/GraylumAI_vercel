/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { TRPCError } from '@trpc/server';
import { withStepConfirmation } from '../../shared/opcStepConfirmation';
import { withReportFlag } from './reportFlag';

type Field = { id?: unknown; title?: unknown };
type Value = { value?: unknown; status?: unknown; nature?: unknown };
type StepState = { version?: unknown; reviewVersion?: unknown; valid?: unknown; body?: unknown };
type Raw = {
  conversationDeleted?: unknown; draftId?: unknown; projectId?: unknown; roundId?: unknown; sessionId?: unknown;
  snapshot?: { state?: unknown; workflow?: { steps?: Field[] }; steps?: Record<string, StepState> };
  information?: Record<string, { schema?: Field[]; values?: Record<string, Value> | null }> | null;
};

const text = (value: unknown) => typeof value === 'string' ? value : '';
const count = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;

/**
 * The only response for a draft whose conversation was deleted (Owner 2026-10-14: confirmed content
 * stays read-only). Built on the server from the full read: step titles, step state, the body of a
 * confirmed step and confirmed field values only. Unconfirmed or suggested values, notes, turns, plans, handoffs and reports never
 * leave the server, so nothing the read-only page does not show can be recovered by calling the API.
 */
export function readonlyDraftProjection(raw: Raw) {
  const steps = (raw.snapshot?.workflow?.steps ?? []).map((step) => ({ id: text(step.id), title: text(step.title) }));
  return {
    conversationDeleted: true as const,
    draftId: text(raw.draftId), projectId: text(raw.projectId), roundId: text(raw.roundId), sessionId: text(raw.sessionId),
    snapshot: {
      state: text(raw.snapshot?.state),
      workflow: { steps },
      steps: Object.fromEntries(steps.map((step) => {
        const state = raw.snapshot?.steps?.[step.id];
        const valid = state?.valid === true;
        return [step.id, { version: count(state?.version), reviewVersion: count(state?.reviewVersion), valid,
          // A confirmed step keeps what was confirmed, even when its fields were not confirmed one by one.
          ...(valid && typeof state?.body === 'string' && state.body.trim() ? { body: state.body } : {}) }];
      })),
    },
    information: Object.fromEntries(steps.map((step) => {
      const info = raw.information?.[step.id];
      const values = Object.entries(info?.values ?? {}).filter(([, value]) => value?.status === 'confirmed' && typeof value.value === 'string');
      return [step.id, {
        schema: (info?.schema ?? []).map((field) => ({ id: text(field.id), title: text(field.title) })),
        values: Object.fromEntries(values.map(([id, value]) => [id, {
          value: value.value as string, status: 'confirmed',
          ...(typeof value.nature === 'string' ? { nature: value.nature } : {}),
        }])),
      }];
    })),
    turns: [], plans: [], handoffs: [], report: null,
  };
}

/** Whether the projection still has anything to show: a confirmed field value or a confirmed step's body. */
function hasConfirmedContent(projection: ReturnType<typeof readonlyDraftProjection>) {
  const bodies = Object.values(projection.snapshot.steps).some((step) => 'body' in step);
  return bodies || Object.values(projection.information).some((info) => Object.keys(info.values).length > 0);
}

/**
 * The sidebar list keeps a read-only draft exactly while SQL finds something confirmed in it, including a published
 * version that the current round no longer shows. Ask the same list; if it cannot be read, keep the page (fail open).
 */
async function retainedInList(raw: Raw, rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  try {
    const list = await rpc('opc_query', {});
    return !Array.isArray(list) || list.some((row) => (row as { draftId?: unknown } | null)?.draftId === raw.draftId);
  } catch { return true; }
}

/**
 * The draft read: the confirmed-only projection when the conversation was deleted, otherwise the full read.
 * A deleted conversation with nothing confirmed has nothing left to show, so it reads as not found.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the RPC result is the untyped opc_query projection.
export async function draftReadResponse(raw: any, rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  if (raw?.conversationDeleted) {
    const projection = readonlyDraftProjection(raw);
    if (!hasConfirmedContent(projection) && !await retainedInList(raw, rpc))
      throw new TRPCError({ code: 'NOT_FOUND', message: 'OPC_DRAFT_NOT_FOUND' });
    return projection;
  }
  return withStepConfirmation(await withReportFlag(raw, rpc));
}
