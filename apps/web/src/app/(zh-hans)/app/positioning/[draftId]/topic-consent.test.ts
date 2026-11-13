/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { enterTopicWorkspace, topicsEntryShown, TOPIC_SKILL_MISSING_NOTICE, TOPIC_SOURCE_CHANGED_NOTICE, TOPIC_UNVERIFIED_NOTICE } from "./topic-consent";

const run = (answer: () => Promise<{ bound: boolean; sourceVersionId?: string | null }>) => {
  const push = vi.fn(), bind = vi.fn(answer);
  return { push, bind, result: enterTopicWorkspace({ draftId: "d1", sourceVersionId: "v1", bind, push }) };
};

describe("继续生成第一周选题 enters the bound topic workspace (kept when the old plan page was removed)", () => {
  it("binds the shown version, then goes to /topics and nowhere else", async () => {
    const { push, bind, result } = run(async () => ({ bound: true, sourceVersionId: "v1" }));
    expect(await result).toEqual({ entered: true });
    expect(bind).toHaveBeenCalledExactlyOnceWith({ draftId: "d1", sourceVersionId: "v1" });
    expect(push).toHaveBeenCalledExactlyOnceWith("/app/positioning/d1/topics");
  });
  it("stays on the page when the server bound another version or did not bind", async () => {
    for (const answer of [{ bound: true, sourceVersionId: "v2" }, { bound: false, sourceVersionId: "v1" }]) {
      const { push, result } = run(async () => answer);
      expect(await result).toEqual({ entered: false, notice: TOPIC_SOURCE_CHANGED_NOTICE });
      expect(push).not.toHaveBeenCalled();
    }
  });
  it("shows a fixed notice for a refusal, never the server's text, and never navigates", async () => {
    for (const [code, notice] of [["OPC_TOPIC_BOUND", TOPIC_SOURCE_CHANGED_NOTICE], ["OPC_TOPIC_SKILL_MISSING", TOPIC_SKILL_MISSING_NOTICE],
      ["OPC_UNAVAILABLE", TOPIC_UNVERIFIED_NOTICE]] as const) {
      const { push, result } = run(async () => { throw new Error(code); });
      expect(await result).toEqual({ entered: false, notice });
      expect(push).not.toHaveBeenCalled();
    }
  });
});

describe("the positioning page keeps its consent entry after the plan view was removed", () => {
  const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  it("still asks for consent, calls enterTopicWorkspace, and has no plan view left", () => {
    expect(page).toContain('aria-label="是否继续生成第一周选题"');
    expect(page).toContain("继续生成第一周选题");
    expect(page).toContain("enterTopicWorkspace(");
    expect(page).toContain("trpc.opc.consentTopicWorkspace.useMutation()");
    expect(page).not.toMatch(/planView|usePathname|opc-plan-generation/);
  });
});

describe("UI-FINISH: the report page's entry to the topics window", () => {
  it("stays while a revision is open and the topics window is bound to the version in effect", () => {
    expect(topicsEntryShown(false, true)).toBe(true);
    expect(topicsEntryShown(undefined, true)).toBe(true);
    expect(topicsEntryShown(true, false)).toBe(true);
    // Neither a formal report nor a bound window: nothing to enter.
    expect(topicsEntryShown(false, false)).toBe(false);
    expect(topicsEntryShown(undefined, undefined)).toBe(false);
  });
  it("is what the page uses, not the report of the open round alone", () => {
    const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    expect(page).toContain("topicsEntryShown(d.report?.available, topicWorkspace.data?.bound)");
    expect(page).not.toContain("{d.report?.available && <Link href={`/app/positioning/${draftId}/topics`}>");
  });
});
