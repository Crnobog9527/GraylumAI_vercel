/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { publicWorkflowSchema } from '../artifacts/public';

const uuid = z.string().uuid();
const projectFlag = publicWorkflowSchema.shape.reportGeneration;
type Draft = { snapshot?: { projectId?: unknown; roundId?: unknown; workflow?: Record<string, unknown> } | null };

/**
 * opc_query rebuilds snapshot.workflow field by field in SQL and leaves out reportGeneration, so the page could
 * not tell a report flow (R5). Add the read-only flag from the round's frozen workflow (artifact_query 'resolve',
 * the same ownership checks as the read). Only whether a report is configured leaves the server, never the
 * manifest. A failed lookup is not "no report": answering false would show the legacy confirm action that
 * report_final_snapshot then rejects. The error goes up, so the read fails and the page's query retry/error UI applies.
 */
export async function withReportFlag<T extends Draft>(draft: T, rpc: Rpc): Promise<T> {
  return (await withFrozenRound(draft, rpc)).draft;
}

type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;
/** What artifact_query 'resolve' answers for the round of a read: its frozen workflow and the module it runs. */
export type FrozenRound = { workflow?: { reportGeneration?: unknown }; moduleId?: unknown } | null;

/**
 * The draft with its report flag, and the frozen round the flag was read from (`round` is absent when the read has no
 * snapshot to look up, so no query was made). The draft read needs the round's module too: one lookup serves both.
 */
export async function withFrozenRound<T extends Draft>(draft: T, rpc: Rpc): Promise<{ draft: T; round?: FrozenRound; projectId?: string; roundId?: string }> {
  const workflow = draft.snapshot?.workflow;
  const projectId = uuid.safeParse(draft.snapshot?.projectId), roundId = uuid.safeParse(draft.snapshot?.roundId);
  if (!workflow || !projectId.success || !roundId.success) return { draft };
  const round = await rpc('artifact_query', { p_action: 'resolve', p_project_id: projectId.data, p_round_id: roundId.data }) as FrozenRound;
  const configured = projectFlag.parse(round?.workflow?.reportGeneration);
  return {
    draft: { ...draft, snapshot: { ...draft.snapshot, workflow: { ...workflow, reportGeneration: configured } } },
    round, projectId: projectId.data, roundId: roundId.data,
  };
}
