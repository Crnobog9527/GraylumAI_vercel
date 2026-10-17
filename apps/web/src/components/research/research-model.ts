/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-5: what the conversation shows for research tool calls, selection cards and the benchmark
// table (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md §1.2–§1.6, §2.1–§2.2). Shapes follow the host
// contracts: call events and cards from RT-3b `shared/researchTurn.ts`, tool names from RT-3a, card confirmations
// from the RT-3b card functions, account numbers from RT-4a. Pure functions only. Supplier names, route ids and costs never reach
// the page.
import type { ResearchToolName } from "../../../../../packages/api/src/services/research/tools/schemas";
import type { ResearchTurnEvent } from "../../../../../packages/api/src/shared/researchTurn";
import type { SocialPlatform } from "../../../../../packages/api/src/services/research/vendors/types";

/** Owner-approved wording (2026-10-15) wherever the page says where benchmark numbers come from. */
export const DATA_SOURCE_NOTE = "AI 教练通过数据接口，直接抓取对标账号在社交媒体平台上的真实公开数据。";
/** A number the evidence cannot support. Never shown as 0. */
export const MISSING_TEXT = "缺失 / 未取到";

export const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  douyin: "抖音", xiaohongshu: "小红书", bilibili: "B 站", weibo: "微博",
  tiktok: "TikTok", youtube: "YouTube", x: "X", instagram: "Instagram",
};
export const platformLabel = (platform: string): string =>
  PLATFORM_LABELS[platform as SocialPlatform] ?? platform;

// ---------------------------------------------------------------------------
// Research calls in the conversation
// ---------------------------------------------------------------------------

/** One research call as the Agent turn stream reports it (RT-3b `ResearchTurnEvent`, type `research_call`). */
export type ResearchCall = Omit<Extract<ResearchTurnEvent, { type: "research_call" }>, "type">;

export type CallState = "running" | "success" | "missing" | "pending";
export const CALL_STATE_LABELS: Record<CallState, string> = {
  running: "正在搜", success: "成功", missing: "未取到", pending: "待核",
};

export interface CallView {
  /** What was searched: keywords, a query, an account or a page. */
  query: string;
  /** Which kind of data the call reads, e.g. "抖音 · 关键词作品"; never a supplier or route id. */
  line: string;
  state: CallState;
  /** One plain sentence for anything other than a success. */
  detail: string | null;
  /** What the user was charged for this call once it settled, e.g. "0.3 积分"; null while unknown or free. */
  credits: string | null;
}

/** Settled user credits of a finished call ("0.30" → "0.3 积分"); nothing for running, zero or unreadable values. */
export function callCredits(call: Pick<ResearchCall, "state" | "credits">): string | null {
  const value = call.credits;
  if (call.state === "running" || typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value) || Number(value) === 0) return null;
  return `${value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")} 积分`;
}

export const DATA_KIND_LABELS: Record<ResearchCall["dataKind"], string> = {
  keyword_posts: "关键词作品", account_profile: "账号资料", account_posts: "近期作品",
  account_relation: "粉丝数", post_detail: "作品详情", web_search: "网页搜索", web_fetch: "网页正文",
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const text = (value: unknown): string => (typeof value === "string" ? value : "");

function pageLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return url;
  }
}

function accountsLabel(value: unknown): { query: string; platforms: string[]; count: number } {
  const accounts = Array.isArray(value) ? value.map(record) : [];
  return {
    count: accounts.length,
    query: accounts.map(account => text(account.account)).filter(Boolean).join("、"),
    platforms: [...new Set(accounts.map(account => platformLabel(text(account.platform))).filter(Boolean))],
  };
}

/** Query and data kind of a call; null for the free card tools, which are not searches. */
export function describeRequest(tool: ResearchToolName, rawArgs: unknown): { query: string; line: string } | null {
  const args = record(rawArgs);
  switch (tool) {
    case "social_search":
      return { query: strings(args.keywords).join("、"), line: `${platformLabel(text(args.platform))} · 关键词作品` };
    case "social_account":
      return { query: text(args.account), line: `${platformLabel(text(args.platform))} · 账号资料和近期作品` };
    case "web_search":
      return { query: text(args.query), line: "网页搜索" };
    case "web_fetch":
      return { query: pageLabel(text(args.url)), line: "网页正文" };
    case "benchmark_discover": {
      const platforms = strings(args.platforms).map(platformLabel);
      return {
        query: typeof args.discoveryId === "string" ? "继续找对标候选" : "按你确认的关键词找对标候选",
        line: platforms.length > 0 ? `${platforms.join("、")} · 找对标账号` : "找对标账号",
      };
    }
    case "benchmark_fetch": {
      // Charge and evidence rows store the whole tool call's arguments, so one billed lookup cannot tell which of
      // several selected accounts it read: name the account only when there is just one.
      const { query, platforms, count } = accountsLabel(args.accounts);
      return {
        query: count > 1 ? `选中的对标账号（共 ${count} 个）` : query,
        line: `${platforms.join("、") || "对标账号"} · 账号资料和近期作品`,
      };
    }
    default:
      return null;
  }
}

/**
 * The row a call shows. The host already reduced the result to four states: an unknown supplier result is
 * `待核`, a failure `未取到`. Free card tools never arrive as calls.
 */
export function describeCall(call: ResearchCall): CallView {
  const kind = DATA_KIND_LABELS[call.dataKind] ?? "数据";
  const line = call.platform === "web" ? kind : `${platformLabel(call.platform)} · ${kind}`;
  const base = { query: call.query, line, credits: callCredits(call) };
  switch (call.state) {
    case "running": return { ...base, state: "running", detail: null };
    case "succeeded": return { ...base, state: "success", detail: null };
    case "unknown": return { ...base, state: "pending", detail: "这次没有拿到确定结果，正在核对。" };
    default: return { ...base, state: "missing", detail: "这次没有取到数据。" };
  }
}
