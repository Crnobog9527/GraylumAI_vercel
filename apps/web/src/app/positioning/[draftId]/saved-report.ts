/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReportData, SanitizedReportData } from "@repo/api/src/shared/reportData";

/** The formal version's report as `opc.read` returns it (only what the report entry needs). */
export type FormalReport = {
  available?: boolean; id?: string | null;
  report?: { generatedReport?: { body?: string; data?: unknown; dataFrom?: string; source?: string } | null } | null;
} | null | undefined;

/**
 * The saved report text of the formal version this published round is, or null.
 * Each jury adoption (R14) publishes a new round and version, while the generated report execution stays in the
 * round it was written in, so `reportLatest` finds nothing for the current round. The round is published, so its
 * formal version is the current one: show that saved text instead of offering a new paid report.
 * A revision round (draft) keeps the old version's report out of the way: it gets its own new report.
 */
export function savedFormalReport(published: boolean, report: FormalReport): string | null {
  const body = report?.available ? report.report?.generatedReport?.body : undefined;
  return published && typeof body === "string" && body.length > 0 ? body : null;
}

/**
 * REPORT-VISUAL: the strategy data stored with that formal version at 定稿 (0300), in the shape the page draws, so
 * a saved report shows the checked data (benchmark numbers included) rather than re-reading its raw block.
 * `fromSource`: a jury revision only changed the text and kept the data of the version it revised.
 */
export function savedFormalStrategy(report: FormalReport):
  { data: SanitizedReportData; textEdited: string[]; fromSource: boolean } | null {
  const saved = report?.available ? report.report?.generatedReport : undefined;
  const stored = saved?.data as { data?: unknown; dropped?: unknown; textEdited?: unknown } | undefined;
  if (!stored || typeof stored.data !== "object" || stored.data === null || Array.isArray(stored.data)) return null;
  const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return { data: { v: 1, data: stored.data as ReportData, dropped: list(stored.dropped), fallback: {} },
    textEdited: list(stored.textEdited), fromSource: saved?.dataFrom === "source_version" };
}

/**
 * Only a version made by a jury adoption (R14, `source: "review_revision"`) has no generated report behind it, so only it
 * is edited through R14 (Owner 2026-10-20). An ordinary finalized report carries its `executionId` instead and stays as it is,
 * whatever the separate execution lookup says at the moment.
 */
export const savedFormalEditable = (report: FormalReport) =>
  Boolean(report?.available && report.id && report.report?.generatedReport?.source === "review_revision");
