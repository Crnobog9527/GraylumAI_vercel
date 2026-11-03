/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MentorTurnSteps } from "./mentor-turn-steps";

const html = (props: Partial<Parameters<typeof MentorTurnSteps>[0]>) =>
  renderToStaticMarkup(<MentorTurnSteps live={null} reply={{ text: "" }} calls={[]} {...props}/>);
describe("MentorTurnSteps", () => {

  it("stops showing an open organizer as in progress once the grace period is over", () => {
    const open = { executionId: "e1", state: "running", primaryBody: "x", organizerComplete: null } as never;
    expect(html({ reply: { text: "x" }, execution: open, stale: true })).not.toContain("data-turn-steps");
  });
  it("treats a same-tab restored waiting prefix as a reopened turn", () => {
    const live = { executionId: "e1", text: "已写一半", phase: "waiting", card: null, rev: 1, points: 4, stalled: false };
    const running = { executionId: "e1", state: "running", primaryBody: null, organizerComplete: null } as never;
    expect(html({ live, reply: { text: "已写一半" }, execution: running })).toContain("正在写回复");
    expect(html({ live, reply: { text: "已写一半" }, execution: running, stale: true })).not.toContain("data-turn-steps");
  });

  it("shows nothing for a finished turn", () => {
    expect(html({ execution: { executionId: "e1", state: "completed", primaryBody: "x", organizerComplete: true } as never }))
      .not.toContain("data-turn-steps");
  });
});
