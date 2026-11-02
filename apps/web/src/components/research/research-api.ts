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

/** A turn's row has no call arguments, only the subcall's own query and platform: rebuild the shape describeRequest reads. */
function argsOf(row: ToolChargeRow): unknown {
  if (row.args) return row.args;
  const query = row.query ?? "";
  switch (row.toolName) {
    case "web_search": return { query };
    case "web_fetch": return { url: query };
    case "social_search": return { platform: row.platform ?? "", keywords: query ? [query] : [] };
    case "social_account": return { platform: row.platform ?? "", account: query };
    default: return {};
  }
}

export function toSearchCharges(rows: ToolChargeRow[]): SearchCharge[] {
  return rows.flatMap(row => row.toolName
    ? [{ callId: row.callId, tool: row.toolName, args: argsOf(row), settlement: row.source, userCredits: row.credits }]
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
