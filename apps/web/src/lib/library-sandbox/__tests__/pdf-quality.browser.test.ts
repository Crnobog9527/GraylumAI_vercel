/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// LIB_DOCS_PLAN §4.5 text-PDF quality test, run through the production worker bundle in real Chromium.
// Thresholds (initial values from the plan): character accuracy ≥ 98%, pages in correct reading order
// ≥ 90%, no timeouts. Added technical checks: every page reported as a text page, page count exact.
// Set PDF_QUALITY_REPORT=<file> to write the per-sample table as JSON. For a manual spot check with
// real PDF files (never user data), set PDF_SPOT_CHECK_DIR=<folder of .pdf>; the extracted text of
// each file is written to <folder>/<name>.extracted.txt for a person to compare. Nothing is asserted.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './browser-harness';
import { pageInReadingOrder, pdfCharacterAccuracy } from './pdf-quality/metrics';

type Gold = { id: string; producer: string; lang: string; pages: string[][] };
type Extracted = { ok: boolean; code?: string; elapsedMs: number; maxGapMs: number;
  value?: { text: string; pageCount: number; pages: { status: string }[] } };

const gold = JSON.parse(readFileSync(new URL('./pdf-quality/gold.json', import.meta.url), 'utf8')) as Gold[];
let harness: Harness;
let page: Page;

const extract = (name: string) => page.evaluate((sample) =>
  (window as unknown as { sandboxTest: { extractPdfSample(n: string): Promise<unknown> } }).sandboxTest.extractPdfSample(sample),
name) as Promise<Extracted>;

beforeAll(async () => {
  harness = await startHarness();
  for (const sample of gold) {
    harness.samples.set(`pdf:${sample.id}`, readFileSync(new URL(`./pdf-quality/fixtures/${sample.id}.pdf`, import.meta.url)));
  }
  page = await harness.open();
}, 120_000);
afterAll(async () => { await harness?.close(); }, 30_000);

describe('text-PDF quality corpus (20 fixed CN/EN samples)', () => {
  it('meets the §4.5 thresholds', async () => {
    expect(gold).toHaveLength(20);
    const rows = [];
    for (const sample of gold) {
      const outcome = await extract(`pdf:${sample.id}`);
      const pages = outcome.value?.text.split('\f') ?? [];
      const chars = pdfCharacterAccuracy(pages.join('\n'), sample.pages.map((lines) => lines.join('\n')).join('\n'));
      const ordered = sample.pages.filter((lines, index) => pageInReadingOrder(pages[index] ?? '', lines)).length;
      rows.push({ id: sample.id, producer: sample.producer, ok: outcome.ok, code: outcome.code ?? null,
        characters: chars.length, errors: chars.errors, accuracy: Number(chars.accuracy.toFixed(4)),
        pages: sample.pages.length, pageCount: outcome.value?.pageCount ?? 0, orderedPages: ordered,
        textPages: outcome.value?.pages.filter((item) => item.status === 'text').length ?? 0,
        elapsedMs: Math.round(outcome.elapsedMs), maxGapMs: Math.round(outcome.maxGapMs) });
    }
    const characters = rows.reduce((sum, row) => sum + row.characters, 0);
    const errors = rows.reduce((sum, row) => sum + row.errors, 0);
    const totalPages = rows.reduce((sum, row) => sum + row.pages, 0);
    const orderedPages = rows.reduce((sum, row) => sum + row.orderedPages, 0);
    const summary = { samples: rows.length, characters, errors, accuracy: 1 - errors / characters,
      readingOrder: orderedPages / totalPages, pages: `${orderedPages}/${totalPages}`,
      timeouts: rows.filter((row) => row.code === 'SANDBOX_TIMEOUT').length, failures: rows.filter((row) => !row.ok).length,
      pageCountMismatches: rows.filter((row) => row.pageCount !== row.pages).length,
      nonTextPages: rows.reduce((sum, row) => sum + row.pages - row.textPages, 0),
      slowestMs: Math.max(...rows.map((row) => row.elapsedMs)), maxGapMs: Math.max(...rows.map((row) => row.maxGapMs)) };
    console.table(rows.map((row) => ({ id: row.id, accuracy: row.accuracy, errors: row.errors,
      order: `${row.orderedPages}/${row.pages}`, elapsedMs: row.elapsedMs })));
    console.log(JSON.stringify(summary));
    if (process.env.PDF_QUALITY_REPORT) writeFileSync(process.env.PDF_QUALITY_REPORT, JSON.stringify({ summary, rows }, null, 1));
    expect(summary.failures).toBe(0);
    expect(summary.timeouts).toBe(0);
    expect(summary.pageCountMismatches).toBe(0);
    expect(summary.nonTextPages).toBe(0);
    expect(summary.accuracy).toBeGreaterThanOrEqual(0.98);
    expect(summary.readingOrder).toBeGreaterThanOrEqual(0.9);
  }, 300_000);

  it.runIf(Boolean(process.env.PDF_SPOT_CHECK_DIR))('writes spot-check extractions for real PDF files', async () => {
    const folder = process.env.PDF_SPOT_CHECK_DIR!;
    for (const file of readdirSync(folder).filter((name) => name.toLowerCase().endsWith('.pdf'))) {
      harness.samples.set(`spot:${file}`, readFileSync(path.join(folder, file)));
      const outcome = await extract(`spot:${file}`);
      const body = outcome.ok && outcome.value
        ? outcome.value.text.split('\f').map((text, index) => `--- page ${index + 1} (${outcome.value?.pages[index].status}) ---\n${text}`).join('\n')
        : `FAILED: ${outcome.code}`;
      writeFileSync(path.join(folder, `${file}.extracted.txt`), `${body}\n\n(${Math.round(outcome.elapsedMs)} ms)\n`);
    }
  }, 300_000);
});
