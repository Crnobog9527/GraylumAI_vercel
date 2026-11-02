/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2 V2-10: a mentor turn is sent on the path the conversation is on, and that is only known once the switch (runtime.choices)
 * and the turn path's own read of the conversation have answered. A turn sent before that goes to the old path (the opening turn of a
 * new draft fires as soon as the page has its draft), and one old-path turn is enough: the draft then holds old history and stays on the
 * old path for good. So nothing is sent, and the opening is not started, until the gate is ready.
 */
export function mentorPathReady(input: { hasSession: boolean; choicesSettled: boolean; viewLoaded: boolean }): boolean {
  return input.hasSession && input.choicesSettled && input.viewLoaded;
}

export type PathGate = { ready: boolean; on: boolean };
const STEP_MS = 100, LIMIT_MS = 30_000;

/** Waits for the gate, then says whether this turn goes on the turn path. Never answers "old" for a gate that was not ready. */
export async function mentorOnTurnPath(gate: () => PathGate, wait: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
  limitMs = LIMIT_MS): Promise<boolean> {
  for (let waited = 0; !gate().ready; waited += STEP_MS) {
    if (waited >= limitMs) throw new Error("TURN_PATH_UNDECIDED");
    await wait(STEP_MS);
  }
  // With the switch on every draft's mentor talk runs on the turn path, one with old-path turns included (test data only: the real
  // database is built new, plan 5.4); it sees only its new messages. V2-12 removes the old path.
  return gate().on;
}
