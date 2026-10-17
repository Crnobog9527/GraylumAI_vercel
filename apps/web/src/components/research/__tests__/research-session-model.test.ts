/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import {
  isResearchEvent, MAX_CALLS_PER_EXECUTION, openCards, REPORT_MIN_QUALIFIED, toBenchmarkRows, toSessionCards, withResearchCall,
  type StoredBenchmark, type StoredCard,
} from "../research-session-model";

type CallEvent = Parameters<typeof withResearchCall>[2];
const call = (callId: string, state: CallEvent["state"], extra: Partial<CallEvent> = {}): CallEvent => ({
  type: "research_call", callId, toolName: "social_search", args: {}, query: "职场穿搭", platform: "douyin",
  dataKind: "keyword_posts", state, ...extra,
});

describe("research calls per execution", () => {
  it("keeps research events only", () => {
    expect(isResearchEvent({ type: "research_call" })).toBe(true);
    expect(isResearchEvent({ type: "research_card" })).toBe(true);
    expect(isResearchEvent({ type: "textDelta" })).toBe(false);
    expect(isResearchEvent({ type: "card" })).toBe(false);
  });

  it("appends new calls in order and replaces a known call in place", () => {
    let calls = withResearchCall(new Map(), "e1", call("c1", "running"));
    calls = withResearchCall(calls, "e1", call("c2", "running"));
    calls = withResearchCall(calls, "e1", call("c1", "succeeded", { evidenceId: "ev1", credits: "1.25" }));
    expect(calls.get("e1")!.map(item => [item.callId, item.state])).toEqual([["c1", "succeeded"], ["c2", "running"]]);
    expect(calls.get("e1")![0]).not.toHaveProperty("type");
    expect(calls.get("e1")![0]!.credits).toBe("1.25");
  });

  it("keeps executions apart", () => {
    let calls = withResearchCall(new Map(), "e1", call("c1", "running"));
    calls = withResearchCall(calls, "e2", call("c1", "failed"));
    expect(calls.get("e1")![0]!.state).toBe("running");
    expect(calls.get("e2")![0]!.state).toBe("failed");
  });

  it("never moves a finished call back to running, and returns the same map when nothing changed", () => {
    const done = withResearchCall(new Map(), "e1", call("c1", "succeeded"));
    expect(withResearchCall(done, "e1", call("c1", "running"))).toBe(done);
    expect(withResearchCall(done, "e1", call("c1", "succeeded"))).toBe(done);
  });

  it("resumes a paused call with the same id (running → succeeded)", () => {
    let calls = withResearchCall(new Map(), "e1", call("c1", "running"));
    calls = withResearchCall(calls, "e1", call("c1", "running"));
    calls = withResearchCall(calls, "e1", call("c1", "succeeded"));
    expect(calls.get("e1")!.map(item => item.state)).toEqual(["succeeded"]);
  });

  it("stops at the stream's own cap", () => {
    let calls: ReturnType<typeof withResearchCall> = new Map();
    for (let index = 0; index < MAX_CALLS_PER_EXECUTION + 3; index++) calls = withResearchCall(calls, "e1", call(`c${index}`, "running"));
    expect(calls.get("e1")).toHaveLength(MAX_CALLS_PER_EXECUTION);
  });
});

const KEYWORDS: StoredCard = {
  cardId: "33333333-3333-4333-8333-333333333333", kind: "keywords", minSelect: 1, maxSelect: 5,
  options: [{ id: "k1", text: "职场穿搭" }, { id: "k2", text: "通勤穿搭" }], confirmationId: null, items: null,
};
const option = (id: string, selectable = true) => ({ id, platform: "douyin", account: `sample_${id}`, evidenceRef: `ev${id}#1`,
  label: `账号 ${id}`, selectable });
const CANDIDATES: StoredCard = {
  cardId: "44444444-4444-4444-8444-444444444444", kind: "candidates", minSelect: 3, maxSelect: 5,
  options: [option("c1"), option("c2"), option("c3"), option("h1", false)],
  confirmationId: "66666666-6666-4666-8666-666666666666",
  items: [option("c1"), option("c2"), option("c3")].map(({ id, platform, account, evidenceRef }) => ({ id, platform, account, evidenceRef })),
};
const FOLLOW_UP: StoredCard = { ...CANDIDATES, cardId: "55555555-5555-4555-8555-555555555555", minSelect: 1, maxSelect: 2,
  options: [option("c4"), option("c5")], confirmationId: null, items: null };

describe("stored cards", () => {
  it("maps cards and their stored confirmation", () => {
    const [keywords, candidates] = toSessionCards([{ ...KEYWORDS, confirmationId: "77777777-7777-4777-8777-777777777777",
      items: ["职场穿搭", "通勤"] }, CANDIDATES]);
    expect(keywords!.card).toEqual({ cardId: KEYWORDS.cardId, kind: "keywords", minSelect: 1, maxSelect: 5, options: KEYWORDS.options });
    expect(keywords!.confirmation).toEqual({ cardId: KEYWORDS.cardId, confirmationId: "77777777-7777-4777-8777-777777777777",
      kind: "keywords", items: ["职场穿搭", "通勤"] });
    expect(candidates!.confirmation).toMatchObject({ kind: "candidates", items: CANDIDATES.items });
    expect(candidates!.card).not.toHaveProperty("followUp");
  });

  it("an open card has no confirmation", () => {
    const cards = toSessionCards([KEYWORDS, CANDIDATES, FOLLOW_UP]);
    expect(openCards(cards).map(item => item.card.cardId)).toEqual([KEYWORDS.cardId, FOLLOW_UP.cardId]);
  });

  it("a later candidate card of the session is a follow-up card", () => {
    const cards = toSessionCards([KEYWORDS, CANDIDATES, FOLLOW_UP]);
    expect(cards[2]!.card).toMatchObject({ kind: "candidates", followUp: true });
  });
});

describe("stored benchmark rows", () => {
  const stored = (account: string, extra: Partial<StoredBenchmark> = {}): StoredBenchmark => ({
    platform: "douyin", account, followers: 38200, medianViews: null, engagementRate: 0.05, postsPerWeek: 3,
    lastPublishedAt: "2026-10-13T10:00:00Z", category: "imitable", qualified: true, fetchedAt: "2026-10-15T08:00:00Z",
    refs: { followers: [`ev-${account}#1`], medianViews: [], engagementRate: [`ev-${account}#2`], postsPerWeek: [`ev-${account}#2`],
      lastPublishedAt: [`ev-${account}#2`] }, ...extra,
  });

  it("keeps nulls missing, carries each number's refs and reports the newest fetch", () => {
    const { rows, fetchedAt } = toBenchmarkRows([stored("a"), stored("b", { fetchedAt: "2026-10-16T09:30:00Z", qualified: false,
      category: null, followers: null })]);
    expect(rows[0]!.metrics.medianViews).toEqual({ value: null, refs: [] });
    expect(rows[0]!.metrics.followers).toEqual({ value: 38200, refs: ["ev-a#1"] });
    expect(rows[0]!.metrics.lastPublishedAt.refs).toEqual(["ev-a#2"]);
    expect(rows[1]!.metrics.followers.value).toBeNull();
    expect(rows.map(row => [row.account, row.qualified, row.category])).toEqual([["a", true, "imitable"], ["b", false, null]]);
    expect(fetchedAt).toBe("2026-10-16T09:30:00.000Z");
    expect(REPORT_MIN_QUALIFIED).toBe(3);
  });

  it("has no fetch time without rows", () => {
    expect(toBenchmarkRows([])).toEqual({ rows: [], fetchedAt: null });
  });
});
