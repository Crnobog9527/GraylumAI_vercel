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
export async function withReportFlag<T extends Draft>(draft: T, rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>): Promise<T> {
  const workflow = draft.snapshot?.workflow;
  const projectId = uuid.safeParse(draft.snapshot?.projectId), roundId = uuid.safeParse(draft.snapshot?.roundId);
  if (!workflow || !projectId.success || !roundId.success) return draft;
  const frozen = await rpc('artifact_query', { p_action: 'resolve', p_project_id: projectId.data, p_round_id: roundId.data }) as
    { workflow?: { reportGeneration?: unknown } } | null;
  const configured = projectFlag.parse(frozen?.workflow?.reportGeneration);
  return { ...draft, snapshot: { ...draft.snapshot, workflow: { ...workflow, reportGeneration: configured } } };
}
