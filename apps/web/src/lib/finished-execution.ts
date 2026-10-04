/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** The parts of a `runtime.execute` mutation this reads. */
type ExecuteCall = { isSuccess: boolean; data?: unknown; variables?: { executionId: string } };

/**
 * The execution whose last execute call returned a final state, or null.
 *
 * The page re-reads the session view only after that call returns, so for a moment the
 * view can still show the turn open while nothing is running any more. Such a turn keeps
 * showing "正在回复…" until the view catches up, instead of briefly reading 回复尚未完成.
 * A `pending` result is not final: the server left the turn unfinished, and the page keeps
 * its usual unfinished notice.
 */
export function finishedExecution(call: ExecuteCall): string | null {
  if (!call.isSuccess || !call.variables) return null;
  const state = call.data && typeof call.data === 'object' && 'state' in call.data ? call.data.state : undefined;
  return typeof state === 'string' && state !== 'pending' ? call.variables.executionId : null;
}
