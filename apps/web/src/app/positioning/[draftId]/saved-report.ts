/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** The formal version's report as `opc.read` returns it (only what the report entry needs). */
export type FormalReport = {
  available?: boolean; id?: string | null;
  report?: { generatedReport?: { body?: string } | null } | null;
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
