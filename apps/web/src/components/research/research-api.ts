/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Server rows of the RT-3b user endpoints (`research.toolCharges`, `research.evidence`) → what the research
// components show. Rows the server could not attribute to a research tool (toolName null) are left out; missing
// metadata stays missing.
import type { EvidenceEntry, EvidenceState } from "./evidence-list";
import type { ResearchToolName } from "../../../../../packages/api/src/services/research/tools/schemas";
import type { SearchCharge, ToolSettlement } from "./search-charges";

export interface ToolChargeRow {
  callId: string;
  toolName: ResearchToolName | null;
  args: unknown;
  source: ToolSettlement | null;
  credits: string | null;
  /** What the one subcall asked for (turn rows keep it per subcall instead of the whole call's arguments). */
  query?: string | null;
  platform?: string | null;
}

/**
 * A turn's row has no call arguments, only the subcall's own query and platform: rebuild what describeRequest reads. A benchmark
 * discovery subcall is one keyword search, so it is shown as that, with its own keyword.
 */
function requestOf(row: ToolChargeRow & { toolName: ResearchToolName }): Pick<SearchCharge, "tool" | "args"> {
  if (row.args) return { tool: row.toolName, args: row.args };
  const query = row.query ?? "";
  const platform = row.platform ?? "";
  switch (row.toolName) {
    case "web_search": return { tool: row.toolName, args: { query } };
    case "web_fetch": return { tool: row.toolName, args: { url: query } };
    case "social_search": return { tool: row.toolName, args: { platform, keywords: query ? [query] : [] } };
    case "social_account": return { tool: row.toolName, args: { platform, account: query } };
    case "benchmark_fetch": return { tool: row.toolName, args: { accounts: query ? [{ platform, account: query }] : [] } };
    case "benchmark_discover": return query ? { tool: "social_search", args: { platform, keywords: [query] } }
      : { tool: row.toolName, args: {} };
    default: return { tool: row.toolName, args: {} };
  }
}

export function toSearchCharges(rows: ToolChargeRow[]): SearchCharge[] {
  return rows.flatMap(row => row.toolName
    ? [{ callId: row.callId, ...requestOf({ ...row, toolName: row.toolName }), settlement: row.source, userCredits: row.credits }]
    : []);
}

export interface EvidenceRow {
  operationId: string;
  toolName: ResearchToolName | null;
  args: unknown;
  state: EvidenceState;
  fetchedAt: string | null;
  itemCount: number | null;
  truncated: boolean | null;
  sources: string[];
  sessionId: string;
  sessionTitle: string | null;
}

export function toEvidenceEntries(rows: EvidenceRow[]): EvidenceEntry[] {
  return rows.flatMap(row => row.toolName ? [{
    evidenceId: row.operationId, tool: row.toolName, args: row.args ?? {}, state: row.state,
    fetchedAt: row.fetchedAt, itemCount: row.itemCount, truncated: row.truncated === true,
    sourceUrls: row.sources, conversationTitle: row.sessionTitle?.trim() || "未命名对话",
  }] : []);
}
