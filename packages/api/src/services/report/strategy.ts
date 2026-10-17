/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { parseReportBody, reportBodyText, type BenchmarkRow, type ReportData, type SanitizedReportData } from '../../shared/reportData';
import { editedReportFields } from '../../shared/reportDataText';

/**
 * REPORT-VISUAL PR-2 (§3.3, §6.2): the report's strategy data as the server checks it. The same shared validator
 * as the page; benchmark numbers come only from the host's table, and only while it is the table the report was
 * written from (same hash as the frozen `benchmarkHash`). What 定稿 stores is exactly this, bound to the body hash.
 */

/** Stored in the formal version as `generatedReport.data` (0300). */
export type StoredReportData = {
  dataVersion: 1;
  validatedAt: string;
  /** Paths only, never content: for the pass-rate statistics. */
  dropped: string[];
  data: ReportData;
  /** Fields whose chapter text the user changed after it was generated. */
  textEdited: string[];
};

/** What the read answer carries: the checked data for the page, or null for a report without a data block. */
export type ReportStrategy = { data: SanitizedReportData; textEdited: string[]; stored: boolean } | null;

const source = z.object({
  sessionId: z.string().uuid().nullable(),
  benchmarkHash: z.string().nullable(),
  generatedBody: z.string().nullable(),
  storedData: z.unknown().nullable(),
}).passthrough();

const benchmarkTable = z.object({
  rows: z.array(z.object({
    platform: z.string(), account: z.string(), followers: z.number().nullable(), medianViews: z.number().nullable(),
    engagementRate: z.number().nullable(), postsPerWeek: z.number().nullable(), fetchedAt: z.string().nullable(),
  }).passthrough()).max(30),
  hash: z.string(),
}).passthrough();

const stored = z.object({
  dataVersion: z.literal(1), validatedAt: z.string(), dropped: z.array(z.string()),
  data: z.record(z.string(), z.unknown()), textEdited: z.array(z.string()),
}).passthrough();

async function benchmarkRows(admin: SupabaseClient, actorId: string, sessionId: string | null, frozenHash: string | null) {
  // A report frozen without a table was written without benchmark accounts: any account it names is not the host's.
  if (!frozenHash || !sessionId) return { rows: [] as BenchmarkRow[], current: true };
  const { data, error } = await admin.rpc('research_benchmark_rows', { a: actorId, s: sessionId });
  const table = benchmarkTable.safeParse(error ? null : data);
  // Unreadable now (the research session was deleted): keep what to learn, show no numbers.
  if (!table.success) return { rows: [] as BenchmarkRow[], current: false };
  return { rows: table.data.rows as BenchmarkRow[], current: table.data.hash === frozenHash };
}

/**
 * The strategy data of a report document. A finalized report answers with what 定稿 stored (its numbers are the
 * ones checked then); a draft is checked now. `body` and `bodyHash` are the document's current ones.
 */
export async function reportStrategy(admin: SupabaseClient, actorId: string, executionId: string,
  doc: { body: string; finalized: boolean; manuallyEdited: boolean }): Promise<ReportStrategy> {
  if (typeof doc.body !== 'string') return null;
  const parsed = parseReportBody(doc.body);
  // Without a data block (every report before the new Skill version) nothing else is read.
  if (!parsed.data) return null;
  const { data, error } = await admin.rpc('report_document_data_source', { a: actorId, eid: executionId });
  if (error) throw error;
  const facts = source.parse(data);
  if (doc.finalized) {
    const saved = stored.safeParse(facts.storedData);
    // Finalized before 0300, or without data: the page still lists what the text carries, without numbers.
    if (!saved.success) return { data: parsed.data, textEdited: [], stored: false };
    return { data: { ...parsed.data, data: saved.data.data as ReportData, dropped: saved.data.dropped },
      textEdited: saved.data.textEdited, stored: true };
  }
  const benchmarks = await benchmarkRows(admin, actorId, facts.sessionId, facts.benchmarkHash);
  const checked = parseReportBody(doc.body, { benchmarks }).data!;
  const textEdited = doc.manuallyEdited && facts.generatedBody
    ? editedReportFields(reportBodyText(facts.generatedBody), parsed.text).filter(field => checked.data[field] !== undefined)
    : [];
  return { data: checked, textEdited, stored: false };
}

/** The value 定稿 passes to the database, bound to the exact body being finalized; null without a data block. */
export function storedReportData(strategy: ReportStrategy, bodyHash: string, now = new Date()) {
  if (!strategy) return null;
  const value: StoredReportData = { dataVersion: 1, validatedAt: now.toISOString(), dropped: strategy.data.dropped,
    data: strategy.data.data, textEdited: strategy.textEdited };
  return { ...value, bodyHash };
}
