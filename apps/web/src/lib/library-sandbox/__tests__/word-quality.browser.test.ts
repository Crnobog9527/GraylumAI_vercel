/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB_DOCS_PLAN §4.5 Word quality test, run through the production worker bundle in real Chromium.
// Thresholds (initial values from the plan): character accuracy ≥ 99%, heading order ≥ 95%, no timeouts.
// Added technical check: ≥ 95% of reference lines (paragraphs, list items, table rows with tab-separated
// cells) appear exactly and in order, so lost structure cannot hide behind whitespace folding.
// Set WORD_QUALITY_REPORT=<file> to write the per-sample table as JSON. For a manual spot check with
// real Word files (never user data), set WORD_SPOT_CHECK_DIR=<folder of .docx>; the extracted text of
// each file is written to <folder>/<name>.extracted.txt for a person to compare. Nothing is asserted.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './browser-harness';
import { characterAccuracy, headingOrder, lineStructure } from './word-quality/metrics';

type Gold = { id: string; producer: string; text: string; headings: { level: number; text: string }[] };
type Extracted = { ok: boolean; code?: string; elapsedMs: number; maxGapMs: number;
  value?: { text: string; headings: { level: number; text: string }[] } };

const gold = JSON.parse(readFileSync(new URL('./word-quality/gold.json', import.meta.url), 'utf8')) as Gold[];
let harness: Harness;
let page: Page;

beforeAll(async () => {
  harness = await startHarness();
  for (const sample of gold) {
    harness.samples.set(`word:${sample.id}`, readFileSync(new URL(`./word-quality/fixtures/${sample.id}.docx`, import.meta.url)));
  }
  page = await harness.open();
}, 120_000);
afterAll(async () => { await harness?.close(); }, 30_000);

describe('Word quality corpus (20 fixed CN/EN samples)', () => {
  it('meets the §4.5 thresholds', async () => {
    expect(gold).toHaveLength(20);
    const rows = [];
    for (const sample of gold) {
      const outcome = await page.evaluate((name) =>
        (window as unknown as { sandboxTest: { extractSample(n: string): Promise<unknown> } }).sandboxTest.extractSample(name),
      `word:${sample.id}`) as Extracted;
      const text = outcome.value?.text ?? '';
      const chars = characterAccuracy(text, sample.text);
      const headings = headingOrder(outcome.value?.headings ?? [], sample.headings);
      const lines = lineStructure(text, sample.text);
      rows.push({ id: sample.id, producer: sample.producer, ok: outcome.ok, code: outcome.code ?? null,
        characters: chars.length, errors: chars.errors, accuracy: Number(chars.accuracy.toFixed(4)),
        headings: `${headings.matched}/${headings.total}`, matchedHeadings: headings.matched, totalHeadings: headings.total,
        lines: `${lines.matched}/${lines.total}`, matchedLines: lines.matched, totalLines: lines.total,
        elapsedMs: Math.round(outcome.elapsedMs), maxGapMs: Math.round(outcome.maxGapMs) });
    }
    const characters = rows.reduce((sum, row) => sum + row.characters, 0);
    const errors = rows.reduce((sum, row) => sum + row.errors, 0);
    const matched = rows.reduce((sum, row) => sum + row.matchedHeadings, 0);
    const total = rows.reduce((sum, row) => sum + row.totalHeadings, 0);
    const matchedLines = rows.reduce((sum, row) => sum + row.matchedLines, 0);
    const totalLines = rows.reduce((sum, row) => sum + row.totalLines, 0);
    const summary = { samples: rows.length, characters, errors, accuracy: 1 - errors / characters, headingOrder: matched / total,
      headings: `${matched}/${total}`, lineStructure: matchedLines / totalLines, lines: `${matchedLines}/${totalLines}`, timeouts: rows.filter((row) => row.code === 'SANDBOX_TIMEOUT').length,
      failures: rows.filter((row) => !row.ok).length, slowestMs: Math.max(...rows.map((row) => row.elapsedMs)) };
    console.table(rows.map((row) => ({ id: row.id, accuracy: row.accuracy, errors: row.errors, headings: row.headings, lines: row.lines,
      elapsedMs: row.elapsedMs, maxGapMs: row.maxGapMs })));
    console.log(JSON.stringify(summary));
    if (process.env.WORD_QUALITY_REPORT) writeFileSync(process.env.WORD_QUALITY_REPORT, JSON.stringify({ summary, rows }, null, 1));
    expect(summary.failures).toBe(0);
    expect(summary.timeouts).toBe(0);
    expect(summary.accuracy).toBeGreaterThanOrEqual(0.99);
    expect(summary.headingOrder).toBeGreaterThanOrEqual(0.95);
    expect(summary.lineStructure).toBeGreaterThanOrEqual(0.95);
  }, 300_000);

  it.runIf(Boolean(process.env.WORD_SPOT_CHECK_DIR))('writes spot-check extractions for real Word files', async () => {
    const folder = process.env.WORD_SPOT_CHECK_DIR!;
    for (const file of readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.docx'))) {
      harness.samples.set(`spot:${file}`, readFileSync(path.join(folder, file)));
      const outcome = await page.evaluate((name) =>
        (window as unknown as { sandboxTest: { extractSample(n: string): Promise<unknown> } }).sandboxTest.extractSample(name),
      `spot:${file}`) as Extracted;
      const headings = (outcome.value?.headings ?? []).map((heading) => `${'#'.repeat(heading.level)} ${heading.text}`);
      const body = outcome.ok ? `${headings.join('\n')}\n\n---\n\n${outcome.value?.text ?? ''}` : `FAILED: ${outcome.code}`;
      writeFileSync(path.join(folder, `${file}.extracted.txt`), `${body}\n\n(${Math.round(outcome.elapsedMs)} ms)\n`);
    }
  }, 300_000);
});
