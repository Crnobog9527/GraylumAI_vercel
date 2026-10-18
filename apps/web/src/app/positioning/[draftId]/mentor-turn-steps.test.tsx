/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REOPENED_HINT } from "@/components/chat-display/turn-steps-model";
import { MentorTurnSteps } from "./mentor-turn-steps";

const html = (props: Partial<Parameters<typeof MentorTurnSteps>[0]>) =>
  renderToStaticMarkup(<MentorTurnSteps live={null} reply={{ text: "" }} calls={[]} {...props}/>);
describe("MentorTurnSteps", () => {
  it("shows the organizer step for a reloaded turn whose main reply is saved and organizer is open", () => {
    const out = html({ reply: { text: "已写好的回复" },
      execution: { executionId: "e1", state: "running", primaryBody: "x", organizerComplete: null } as never });
    expect(out).toContain("正在整理待核对信息");
  });
  it("says the background-processing line once when the turn notice already says it", () => {
    const open = { executionId: "e1", state: "running", primaryBody: null, organizerComplete: null } as never;
    const withNotice = html({ reply: { text: "", notice: { tone: "status", text: REOPENED_HINT, busy: true } }, execution: open });
    expect(withNotice).toContain("data-turn-steps");
    expect(withNotice).not.toContain(REOPENED_HINT);
    expect(html({ reply: { text: "x" }, execution: { ...(open as object), primaryBody: "x" } as never }).split(REOPENED_HINT).length - 1).toBe(1);
  });
  it("shows nothing for a finished turn", () => {
    expect(html({ execution: { executionId: "e1", state: "completed", primaryBody: "x", organizerComplete: true } as never }))
      .not.toContain("data-turn-steps");
  });
});
