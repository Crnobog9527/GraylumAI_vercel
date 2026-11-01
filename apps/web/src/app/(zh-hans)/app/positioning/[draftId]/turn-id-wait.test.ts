/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { waitForTurnId } from "./turn-id-wait";

describe("a stop pressed before the turn id has arrived", () => {
  it("answers at once when the id is known", async () => {
    let waits = 0;
    expect(await waitForTurnId(() => 7, async () => { waits++; })).toBe(7);
    expect(waits).toBe(0);
  });
  it("waits for the id of the stream that was just opened, then names that turn", async () => {
    let id: number | null = null, waits = 0;
    expect(await waitForTurnId(() => id, async () => { if (++waits === 3) id = 56; })).toBe(56);
    expect(waits).toBe(3);
  });
  it("gives up after the limit, so the stop stays unconfirmed and can be pressed again", async () => {
    let waits = 0;
    expect(await waitForTurnId(() => null, async () => { waits++; }, 1000, 100)).toBeNull();
    expect(waits).toBe(10);
  });
});
