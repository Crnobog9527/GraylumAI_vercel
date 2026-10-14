/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// RESEARCH-TOOLS RT-5: what the conversation shows for research tool calls, selection cards and the benchmark
// table (docs/launch/implementation/RESEARCH_TOOLS_PLAN.md §1.2–§1.6, §2.1–§2.2). Shapes follow the host
// contracts: tool names and the result envelope from RT-3a, card and confirmation shapes from the RT-3b card
// functions, account numbers from RT-4a. Pure functions only. Supplier names, route ids and costs never reach
// the page.
import type { ResearchToolName } from "../../../../../packages/api/src/services/research/tools/schemas";
import type { ToolEnvelope } from "../../../../../packages/api/src/services/research/tools/envelope";
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

/** One research tool call as the conversation knows it: the model's arguments and, once done, the envelope. */
export interface ResearchCall {
  id: string;
  tool: ResearchToolName;
  args: unknown;
  /** Absent while the call is still running. */
  result?: Pick<ToolEnvelope, "status" | "reason"> & Partial<Pick<ToolEnvelope, "truncated" | "continue">>;
}

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
  /** One plain sentence for anything other than a full success. */
  detail: string | null;
}

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

function accountsLabel(value: unknown): { query: string; platforms: string[] } {
  const accounts = Array.isArray(value) ? value.map(record) : [];
  return {
    query: accounts.map(account => text(account.account)).filter(Boolean).join("、"),
    platforms: [...new Set(accounts.map(account => platformLabel(text(account.platform))).filter(Boolean))],
  };
}

/** Query and data kind of a call; null for the free card tools, which are not searches. */
function describeRequest(tool: ResearchToolName, rawArgs: unknown): { query: string; line: string } | null {
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
      const { query, platforms } = accountsLabel(args.accounts);
      return { query, line: `${platforms.join("、") || "对标账号"} · 账号资料和近期作品` };
    }
    default:
      return null;
  }
}

const BUDGET_DETAIL = "这一轮的查询次数已用完，没有发出请求。";
const MISSING_DETAILS: Record<string, string> = {
  PROVIDER_FAILED: "这次没有取到数据。",
  PLATFORM_NOT_VERIFIED: "暂不支持这个平台的数据。",
  ROUTE_NOT_SUPPORTED: "暂不支持这个平台的数据。",
  NO_PUBLISH_TIME: "这个平台拿不到作品发布时间，暂不支持对标。",
  BALANCE_LOW: "余额不足，没有发出请求。",
  VENDOR_RATE_LIMITED: "查询太频繁，这次没有发出请求，请稍后再试。",
};

/** The row a call shows. Statuses follow RT-3a `statusForOutcome`: an unknown supplier result is `待核`. */
export function describeCall(call: ResearchCall): CallView | null {
  const request = describeRequest(call.tool, call.args);
  if (!request) return null;
  const result = call.result;
  if (!result) return { ...request, state: "running", detail: null };
  const reason = result.reason ?? "";
  switch (result.status) {
    case "ok":
      return { ...request, state: "success", detail: reason === "NO_RESULTS" ? "没有找到相关内容。" : null };
    case "partial":
      return {
        ...request, state: "success",
        detail: result.continue ? "已取到一部分，还在继续找。" : "只取到一部分，缺的部分没有补。",
      };
    case "unavailable":
      return reason === "PROVIDER_RESULT_UNKNOWN"
        ? { ...request, state: "pending", detail: "这次没有拿到确定结果，正在核对。" }
        : { ...request, state: "missing", detail: MISSING_DETAILS[reason] ?? "这次没有取到数据。" };
    case "not_supported":
      return { ...request, state: "missing", detail: MISSING_DETAILS[reason] ?? "暂不支持这个平台的数据。" };
    case "not_confirmed":
      return { ...request, state: "missing", detail: "需要你先在卡片里确认，或贴出账号主页链接。" };
    case "budget_exhausted":
      return { ...request, state: "missing", detail: MISSING_DETAILS[reason] ?? BUDGET_DETAIL };
    default:
      return { ...request, state: "missing", detail: "这次没有取到数据。" };
  }
}
