/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MentorTurnSteps } from "./mentor-turn-steps";

const html = (props: Partial<Parameters<typeof MentorTurnSteps>[0]>) =>
  renderToStaticMarkup(<MentorTurnSteps live={null} reply={{ text: "" }} calls={[]} {...props}/>);
const liveReply = (extra: object = {}) => ({ executionId: "e1", text: "", phase: "mentor", card: null, rev: 0, points: 0, stalled: false, ...extra });
describe("MentorTurnSteps", () => {
  it("lists the steps of a reply that is being written, open while no text has come, and 正在思考… before the first step", () => {
    expect(html({ live: liveReply() })).toContain("正在思考…");
    const steps = [{ id: "1", tool: "load_skill", state: "done" }, { id: "2", tool: "research", state: "running", detail: "早起" }];
    const open = html({ live: liveReply({ steps }) });
    expect(open).toContain('data-turn-step-list="open"');
    expect(open).toContain("已读取方法");
    expect(open).toContain("早起");
  });

  it("folds the steps into one line once the text flows", () => {
    const steps = [{ id: "1", tool: "load_skill", state: "done" }];
    const folded = html({ live: liveReply({ steps, text: "你好", points: 2 }), reply: { text: "你好" } });
    expect(folded).toContain('data-turn-step-list="folded"');
    expect(folded).toContain("已完成 1 个步骤");
  });

  it("stops showing an open organizer as in progress once the grace period is over", () => {
    const open = { executionId: "e1", state: "running", primaryBody: "x", organizerComplete: null } as never;
    expect(html({ reply: { text: "x" }, execution: open, stale: true })).not.toContain("data-turn-step-list");
  });
  it("treats a same-tab restored waiting prefix as a reopened turn", () => {
    const live = liveReply({ phase: "waiting", text: "已写一半", rev: 1, points: 4 });
    const running = { executionId: "e1", state: "running", primaryBody: null, organizerComplete: null } as never;
    // The text already on screen is the progress; the page says the turn goes on in the background.
    expect(html({ live, reply: { text: "已写一半" }, execution: running })).toContain("data-turn-hint");
    expect(html({ live, reply: { text: "已写一半" }, execution: running, stale: true })).not.toContain("data-turn-hint");
  });

  it("shows nothing for a finished turn", () => {
    expect(html({ execution: { executionId: "e1", state: "completed", primaryBody: "x", organizerComplete: true } as never }))
      .not.toContain("data-turn-step-list");
  });
});
