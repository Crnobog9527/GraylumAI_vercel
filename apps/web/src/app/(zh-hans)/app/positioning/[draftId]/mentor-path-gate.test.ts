/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { mentorOnTurnPath, mentorPathReady, type PathGate } from "./mentor-path-gate";

const noWait = async () => {};
describe("which path a mentor turn goes on", () => {
  it("is ready only with a session, an answered switch and the turn path's read of the conversation", () => {
    expect(mentorPathReady({ hasSession: true, choicesSettled: true, viewLoaded: true })).toBe(true);
    expect(mentorPathReady({ hasSession: false, choicesSettled: true, viewLoaded: true })).toBe(false);
    expect(mentorPathReady({ hasSession: true, choicesSettled: false, viewLoaded: true })).toBe(false);
    expect(mentorPathReady({ hasSession: true, choicesSettled: true, viewLoaded: false })).toBe(false);
  });
  it("waits for the gate instead of falling to the old path (the opening turn of a new draft fires before the switch has answered)", async () => {
    let gate: PathGate = { ready: false, on: false, oldMentorTurns: 0 };
    let waits = 0;
    const answer = mentorOnTurnPath(() => gate, async () => { if (++waits === 3) gate = { ready: true, on: true, oldMentorTurns: 0 }; });
    expect(await answer).toBe(true);
    expect(waits).toBe(3);
  });
  it("goes on the old path only when the answered switch is off or the draft already holds old mentor talk", async () => {
    expect(await mentorOnTurnPath(() => ({ ready: true, on: false, oldMentorTurns: 0 }), noWait)).toBe(false);
    expect(await mentorOnTurnPath(() => ({ ready: true, on: true, oldMentorTurns: 2 }), noWait)).toBe(false);
    expect(await mentorOnTurnPath(() => ({ ready: true, on: true, oldMentorTurns: 0 }), noWait)).toBe(true);
  });
  it("refuses to send when the path is never decided, rather than guess", async () => {
    await expect(mentorOnTurnPath(() => ({ ready: false, on: false, oldMentorTurns: 0 }), noWait, 1000)).rejects.toThrow("TURN_PATH_UNDECIDED");
  });
});
