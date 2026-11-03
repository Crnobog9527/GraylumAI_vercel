/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** The states a paused turn is shown in (the turn path projects a pause for credits as `waiting_credits`). */
const PAUSED = ["waiting_credits", "waiting_resume"];
export function isPaused(state: unknown): state is "waiting_credits" | "waiting_resume" {
  return typeof state === "string" && PAUSED.includes(state);
}

/**
 * The host's fixed notice on a turn result (a server whitelist; never raw details). It goes first in every result notice.
 * A pause keeps its own notice with 继续, so a paused result shows none here.
 */
export function hostNotice(result: unknown): string | null {
  if (!result || typeof result !== "object") return null;
  const { notice, state } = result as { notice?: unknown; state?: unknown };
  return typeof notice === "string" && notice.trim() && !isPaused(state) ? notice.trim() : null;
}

/** Fields of one turn's view this page reads about its position (the turn path leaves them empty). */
export type PausedFields = {
  cursor?: number | null; epoch?: number | null; remainingCalls?: number | null;
  primaryBody?: string | null; organizerComplete?: boolean | null;
};
