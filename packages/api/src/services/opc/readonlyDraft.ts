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
    const drafts = ((await rpc('opc_query', {})) as { drafts?: unknown } | null)?.drafts;
    return !Array.isArray(drafts) || drafts.some((row) => (row as { draftId?: unknown } | null)?.draftId === raw.draftId);
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

type Clients = { auth: { getUser(): Promise<{ data: { user: { id: string } | null } }> } };
/** CORE-PATH-V2 V2-10: with the draft's module, which the page names on a mentor turn. A read-only draft has no turn. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the RPC result is the untyped opc_query projection.
export async function draftReadWithModule(raw: any, rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>, user: Clients,
  admin: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: { moduleId?: string } | null }> }) {
  const response = await draftReadResponse(raw, rpc);
  if (raw.conversationDeleted) return { ...response, moduleId: null };
  const actor = (await user.auth.getUser()).data.user?.id;
  const resolved = actor ? await admin.rpc('artifact_query', { p_actor_id: actor, p_action: 'resolve', p_project_id: raw.projectId,
    p_round_id: raw.roundId }) : null;
  return { ...response, moduleId: resolved?.data?.moduleId ?? null };
}
