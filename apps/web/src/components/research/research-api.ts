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
}

export function toSearchCharges(rows: ToolChargeRow[]): SearchCharge[] {
  return rows.flatMap(row => row.toolName
    ? [{ callId: row.callId, tool: row.toolName, args: row.args ?? {}, settlement: row.source, userCredits: row.credits }]
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
