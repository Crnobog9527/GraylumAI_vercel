/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * CORE-PATH-V2 V2-10: a report's turn id arrives with the first event of the stream that started it. A 停止 pressed before that (the
 * stream was only just opened, the id is still on its way) must not fail as "unconfirmed" and leave the report running: the stop
 * waits for the id, a short while, then names the turn as any other stop.
 */
export async function waitForTurnId(read: () => number | null, wait: (ms: number) => Promise<void>, limitMs = 10_000, stepMs = 100):
  Promise<number | null> {
  for (let waited = 0; ; waited += stepMs) {
    const id = read();
    if (id !== null) return id;
    if (waited >= limitMs) return null;
    await wait(stepMs);
  }
}

/**
 * Which turn a 停止 names (Owner 11-05 bug: a stop pressed 35 ms after 重新生成 reached the previous, already stopped report, the page
 * showed "stopped" while the new report ran to its end and was charged 500 credits). The rule is one thing: while this page has a
 * stream in flight, only that stream's own turn id can be named, never an earlier report's (the id a past stream left behind, or the
 * saved report read before this one began). The flag and the reset happen when the stream is *requested*, not when its first event
 * is pulled, so no stop can fall in between.
 */
export function reportTurnTracker(wait: (ms: number) => Promise<void>, limitMs = 10_000) {
  let streaming = false, own: number | null = null;
  return {
    /** A new stream is requested: the earlier report's id no longer stands for anything. */
    begin() { streaming = true; own = null; },
    /** The server opened this stream's turn. */
    opened(turnId: number) { own = turnId; },
    end() { streaming = false; },
    streaming: () => streaming,
    /** The turn a stop names: this stream's (waiting for its id), else a saved report that is still open; never a closed one. */
    async stopTarget(saved: { turnId: number; state: string } | null | undefined): Promise<number | null> {
      if (own !== null) return own;
      if (streaming) return waitForTurnId(() => own, wait, limitMs);
      return saved && saved.state !== "closed" ? saved.turnId : null;
    },
  };
}
