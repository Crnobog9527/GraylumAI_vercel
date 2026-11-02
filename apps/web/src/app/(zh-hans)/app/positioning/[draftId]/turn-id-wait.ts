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
