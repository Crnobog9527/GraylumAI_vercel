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

  it("lists a search step once: the benchmark's research rows already show it", () => {
    const steps = [{ id: "1", tool: "research", state: "running", detail: "早起" }, { id: "2", tool: "load_skill", state: "done" }];
    const calls = [{ id: "c1", state: "running" }] as never;
    const shown = html({ live: liveReply({ steps }), calls });
    expect(shown).not.toContain("正在联网搜索");
    expect(shown).toContain("已读取方法");
  });

  it("does not keep thinking once a card-only reply is being organized or saved", () => {
    expect(html({ live: liveReply({ phase: "organizer" }) })).not.toContain("正在思考");
    expect(html({ live: liveReply({ phase: "saving", steps: [{ id: "1", tool: "load_skill", state: "done" }] }) })).toContain("已完成 1 个步骤");
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

  // TURN-STEPS for the positioning coach: the folded line stays after the reply ended, and after a reload.
  it("keeps the folded steps line above a reply that has ended, from the steps this page watched", () => {
    const steps = [{ id: "method", tool: "load_skill", state: "done", label: "选定位方向" }];
    const ended = html({ live: liveReply({ steps, text: "好", finished: true, phase: "done" }), reply: { text: "好" },
      execution: { executionId: "e1", state: "completed" } });
    expect(ended).toContain('data-turn-step-list="folded"');
    expect(ended).toContain("已完成 1 个步骤");
  });

  it("shows the steps the server kept after a reload (no live reply), folded, without the research the research rows already list", () => {
    const saved = [{ id: "method", tool: "load_skill", state: "done", label: "选定位方向" }, { id: "1", tool: "research", state: "done", count: 3 }];
    const reloaded = html({ reply: { text: "好" }, execution: { executionId: "e1", state: "completed", steps: saved as never } });
    expect(reloaded).toContain('data-turn-step-list="folded"');
    expect(reloaded).toContain("已完成 2 个步骤");
    expect(html({ reply: { text: "好" }, calls: [{ id: "c1", state: "done" }] as never,
      execution: { executionId: "e1", state: "completed", steps: saved as never } })).toContain("已完成 1 个步骤");
  });

  it("shows nothing for a finished turn", () => {
    expect(html({ execution: { executionId: "e1", state: "completed", primaryBody: "x", organizerComplete: true } as never }))
      .not.toContain("data-turn-step-list");
  });
});
