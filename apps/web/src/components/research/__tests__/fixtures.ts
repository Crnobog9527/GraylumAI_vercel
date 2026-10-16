/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Local mock data in the host shapes (RT-3a envelope, RT-3b cards, RT-4a metrics) until the RT-3b wiring
// delivers real records. Synthetic accounts only.
import type { BenchmarkRow } from "../benchmark-table-model";
import type { ResearchCall } from "../research-model";
import type { CandidateCard, KeywordCard } from "../selection-card-model";
import type { EvidenceEntry } from "../evidence-list";
import type { SearchCharge } from "../search-charges";

export const NOW = new Date("2026-10-15T08:00:00Z");

export const CALLS: ResearchCall[] = [
  { callId: "c1", toolName: "web_search", args: { query: "小红书 职场穿搭 博主 2026" }, query: "小红书 职场穿搭 博主 2026",
    platform: "web", dataKind: "web_search", state: "succeeded", evidenceId: "ev30" },
  { callId: "c2", toolName: "benchmark_discover", args: { platforms: ["douyin"] }, query: "职场穿搭",
    platform: "douyin", dataKind: "keyword_posts", state: "succeeded", evidenceId: "ev31" },
  { callId: "c3", toolName: "benchmark_fetch", args: {}, query: "sample_style_a",
    platform: "douyin", dataKind: "account_posts", state: "unknown" },
  { callId: "c4", toolName: "social_account", args: {}, query: "sample_b",
    platform: "bilibili", dataKind: "account_relation", state: "failed" },
  { callId: "c5", toolName: "social_search", args: {}, query: "office outfit、capsule wardrobe",
    platform: "tiktok", dataKind: "keyword_posts", state: "running" },
];

export const KEYWORD_CARD: KeywordCard = {
  cardId: "33333333-3333-4333-8333-333333333333", kind: "keywords", minSelect: 1, maxSelect: 5,
  options: [{ id: "k1", text: "职场穿搭" }, { id: "k2", text: "通勤穿搭" }, { id: "k3", text: "胶囊衣橱" }],
};

const names = ["通勤衣橱研究所", "小个子穿搭日记", "职场新人穿什么", "极简衣橱 Lily", "每天一套通勤",
  "平价西装测评", "上班族配色课", "衣橱整理师阿宁", "三十岁穿搭笔记", "办公室显瘦穿法"];
export const CANDIDATE_CARD: CandidateCard = {
  cardId: "44444444-4444-4444-8444-444444444444", kind: "candidates", minSelect: 3, maxSelect: 5,
  options: [
    ...names.map((label, index) => ({ id: `c${index + 1}`, platform: index % 3 === 2 ? "xiaohongshu" as const : "douyin" as const,
      account: `sample_${index + 1}`, evidenceRef: `ev${index + 1}#1`, label, selectable: true })),
    { id: "h1", platform: "douyin", account: "sample_head_1", evidenceRef: "ev20#1", label: "头部穿搭大号", selectable: false },
    { id: "h2", platform: "xiaohongshu", account: "sample_head_2", evidenceRef: "ev21#1", label: "时尚主编说", selectable: false },
  ],
};

export const FOLLOW_UP_CARD: CandidateCard = {
  cardId: "55555555-5555-4555-8555-555555555555", kind: "candidates", minSelect: 1, maxSelect: 2, followUp: true,
  options: CANDIDATE_CARD.options.slice(5, 7).concat(CANDIDATE_CARD.options.slice(10, 11)),
};

const metric = (value: number | null, refs: string[]) => ({ value, refs: value === null ? [] : refs });
export const ROWS: BenchmarkRow[] = [
  { platform: "douyin", account: "sample_1", category: "fast_rising", qualified: true, metrics: {
    followers: metric(38200, ["ev1#1"]), medianViews: metric(52000, ["ev2#1", "ev2#2"]),
    engagementRate: metric(0.0634, ["ev2#1"]), postsPerWeek: metric(4.2, ["ev2#1"]),
    lastPublishedAt: { value: "2026-10-13T10:00:00Z", refs: ["ev2#1"] } } },
  { platform: "xiaohongshu", account: "sample_3", category: "imitable", qualified: true, metrics: {
    followers: metric(126000, ["ev3#1"]), medianViews: metric(null, []), engagementRate: metric(null, []),
    postsPerWeek: metric(2, ["ev4#1"]), lastPublishedAt: { value: "2026-10-08T03:00:00Z", refs: ["ev4#2"] } } },
  { platform: "douyin", account: "sample_4", category: "imitable", qualified: true, metrics: {
    followers: metric(15800, ["ev5#1"]), medianViews: metric(9800, ["ev6#1"]), engagementRate: metric(0.112, ["ev6#1"]),
    postsPerWeek: metric(null, []), lastPublishedAt: { value: "2026-10-15T06:00:00Z", refs: ["ev6#1"] } } },
  { platform: "douyin", account: "sample_head_1", category: "head_reference", qualified: false, metrics: {
    followers: metric(2_350_000, ["ev20#1"]), medianViews: metric(410000, ["ev22#1"]), engagementRate: metric(0.021, ["ev22#1"]),
    postsPerWeek: metric(7, ["ev22#1"]), lastPublishedAt: { value: null, refs: [] } } },
];

export const CHARGES: SearchCharge[] = [
  { callId: "b1", tool: "social_search", args: { platform: "douyin", keywords: ["职场穿搭"] }, settlement: "tool_usage", userCredits: "0.30" },
  { callId: "b2", tool: "web_search", args: { query: "通勤穿搭 趋势" }, settlement: "tool_usage", userCredits: "1.00" },
  { callId: "b3", tool: "social_account", args: { platform: "bilibili", account: "sample_b" }, settlement: "tool_failed_charged", userCredits: "0" },
  { callId: "b4", tool: "web_fetch", args: { url: "https://example.com/article" }, settlement: "tool_unknown", userCredits: null },
  { callId: "b5", tool: "web_search", args: { query: "胶囊衣橱" }, settlement: "tool_no_usage", userCredits: null },
];

export const EVIDENCE: EvidenceEntry[] = [
  { evidenceId: "ev1", tool: "social_account", args: { platform: "douyin", account: "sample_1" }, state: "succeeded",
    fetchedAt: "2026-10-14T09:30:00Z", itemCount: 28, truncated: false,
    sourceUrls: ["https://www.douyin.com/user/sample_1", "https://www.douyin.com/video/1", "https://www.douyin.com/video/2",
      "https://www.douyin.com/video/3", "javascript:alert(1)"],
    conversationTitle: "职场穿搭账号定位", conversationHref: "/positioning/draft-1" },
  { evidenceId: "ev9", tool: "web_search", args: { query: "通勤穿搭 趋势" }, state: "unknown", fetchedAt: null, itemCount: null,
    truncated: false, sourceUrls: [], conversationTitle: "职场穿搭账号定位", conversationHref: "/positioning/draft-1" },
  { evidenceId: "ev10", tool: "web_fetch", args: { url: "https://example.com/a/very/long/path/that/keeps/going/and/going/for/the/phone/width" },
    state: "failed", fetchedAt: "2026-10-14T09:31:00Z", itemCount: null, truncated: false, sourceUrls: [],
    conversationTitle: "自由对话", conversationHref: "/runtime?session=s1" },
];
