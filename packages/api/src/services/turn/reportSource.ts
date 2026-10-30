/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { snapshotSchema, type ArtifactSnapshot } from '../artifacts/public';
import { workflowSchema } from '../artifacts/workflow';
import { benchmarkReportFacts, benchmarkShortfallNote, confirmedReportFacts, frozenReport, type FrozenReport,
  type reportManifest } from '../report/contract';
import type { TurnDatabase } from './db';

/*
 * CORE-PATH-V2 V2-7a, controller 10-30 (B1): what a report reads before it opens, on the read client and by the actor's own
 * keys, so turn_open's closure stays the core path's. The round's confirmed source (report_source: every step confirmed, its
 * evidence still readable, the round bound to this conversation), the session's benchmark table, and the benchmark gate of the
 * old report admission (enough qualified accounts, or the user's frozen "generate" choice after a short sample, 0268/0320).
 * turn_open re-checks under its locks only the round's module, the membership level and one paid report per round. The reads
 * and the open are not one transaction: an evidence deleted in between (milliseconds) still yields a report the user pays for,
 * which cannot be repeated to Graylum's loss (AGENTS 5); the deletion itself is never undone by it.
 */
export type ReportSource = { snapshot: ArtifactSnapshot; manifest: z.infer<typeof reportManifest>; facts: string;
  benchmarks: string | null; shortfall: string | null; frozen: FrozenReport; moduleId: string };

const shortfallRead = z.object({ rounds: z.number().int(), qualified: z.number().int(),
  card: z.object({ required: z.number().int(), choice: z.enum(['continue', 'generate']).nullable() }).passthrough().nullable() })
  .passthrough();

export async function readReportSource(db: TurnDatabase, input: { actorId: string; sessionId: string; projectId: string;
  roundId: string; moduleId: string }): Promise<ReportSource> {
  const source = await db.reportSource(input);
  const snapshot = snapshotSchema.parse(source.snapshot);
  const manifest = workflowSchema.parse(source.workflow).reportGeneration;
  if (!manifest) throw new Error('REPORT_MANIFEST_REQUIRED');
  // The model (and so the call's bound) was quoted for the module the page named: it must be the round's.
  if (source.moduleId !== input.moduleId) throw new Error('REPORT_SOURCE_CONFLICT');
  const facts = confirmedReportFacts(snapshot);
  const table = benchmarkReportFacts(await db.benchmarkRows(input));
  // The same minimum as the preflight and SQL research_benchmark_required for a positioning report (never below 3).
  const required = Math.max(3, manifest.minQualifiedBenchmarks ?? 3);
  const rows = table.serialized ? z.array(z.object({ platform: z.string(), account: z.string(), qualified: z.boolean() }).passthrough())
    .parse(JSON.parse(table.serialized)) : [];
  const qualified = new Set(rows.filter(row => row.qualified).map(row => `${row.platform}:${row.account}`)).size;
  if (qualified < required) {
    // Short: only the user's frozen "generate" choice, with at least one qualified account and two rounds (0320).
    const short = shortfallRead.parse(await db.benchmarkShortfall(input));
    if (!(short.qualified >= 1 && short.rounds >= 2 && short.card?.choice === 'generate' && short.card.required >= required))
      throw new Error('REPORT_BENCHMARKS_REQUIRED');
  }
  const frozen = frozenReport.parse({ version: 1, projectId: input.projectId, roundId: input.roundId,
    snapshotHash: source.snapshotHash, packageHash: snapshot.packageHash, workflowHash: snapshot.workflowHash,
    templateHash: snapshot.templateHash, sections: manifest.sections, maxCharacters: manifest.maxCharacters,
    benchmarkHash: table.hash, ...(manifest.data ? { data: manifest.data } : {}) });
  return { snapshot, manifest, facts: facts.serialized, benchmarks: table.serialized, moduleId: input.moduleId,
    shortfall: benchmarkShortfallNote(table.serialized, required), frozen };
}
