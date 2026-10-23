/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from "vitest";
import { relevanceLabel } from "../benchmark-table-model";
import { toBenchmarkRows, type StoredBenchmark } from "../research-session-model";

describe("benchmark topic relevance label (BENCHMARK-COVERAGE)", () => {
  it("says 高/中/低 from the host's share and nothing when unknown", () => {
    expect([relevanceLabel(0.8), relevanceLabel(0.5), relevanceLabel(0.3), relevanceLabel(0.19), relevanceLabel(0)])
      .toEqual(["主题相关度：高", "主题相关度：高", "主题相关度：中", "主题相关度：低", "主题相关度：低"]);
    expect([relevanceLabel(null), relevanceLabel(undefined), relevanceLabel(Number.NaN)]).toEqual([null, null, null]);
  });

  it("keeps the stored relevance on the table row; rows from before 0351 have none", () => {
    const stored = { platform: "tiktok", account: "a", followers: 1, medianViews: null, engagementRate: null, postsPerWeek: null,
      lastPublishedAt: null, category: "imitable", qualified: true, fetchedAt: "2026-10-24T00:00:00Z",
      refs: { followers: [], medianViews: [], engagementRate: [], postsPerWeek: [], lastPublishedAt: [] } } as StoredBenchmark;
    expect(toBenchmarkRows([{ ...stored, topicRelevance: 0.6 }, stored]).rows.map(row => row.topicRelevance)).toEqual([0.6, null]);
  });
});
