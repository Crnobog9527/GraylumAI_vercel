/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// The public article pages on a phone (under 640px; Owner 2026-11-12, phone plan A), in a real browser: the pages rendered to
// HTML as the server renders them, with the app's compiled CSS (globals.css through Tailwind). Measured on staging before this
// change (2026-11-13, 360px): on /graylum-vs-chatgpt the comparison table was 561px wide in a 328px column, so the Graylum
// column was off the screen with nothing saying so; the crumbs above each page's title were 20px high.
// PUBLIC_PHONE_SHOTS=<dir> saves screenshots.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import { chromium, type Browser, type Page } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { compareHans } from '@/lib/seo/content/compare';
import { ArticlePage } from './ArticlePage';
import { FaqPage } from './FaqPage';
import { RefundPage } from './RefundPage';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => <a href={href} {...rest}>{children}</a>,
}));

let browser: Browser;
let css = '';
const shots = process.env.PUBLIC_PHONE_SHOTS;
const src = fileURLToPath(new URL('../../', import.meta.url));
const compare = compareHans();
const table = compare.sections.find(section => section.table)!.table!;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const { build } = await import(pathToFileURL(createRequire(require.resolve('vitest/package.json')).resolve('vite')).href);
  const entry = fileURLToPath(new URL('./__public_phone_fixture__.js', import.meta.url));
  const bundle = await build({
    configFile: false, logLevel: 'silent', css: { postcss: { plugins: [tailwind({ base: src })] } },
    plugins: [{ name: 'public-phone-css', enforce: 'pre', resolveId(id: string) { if (id === entry) return id; }, load(id: string) {
      if (id === entry) return `import ${JSON.stringify(fileURLToPath(new URL('../../app/globals.css', import.meta.url)))};`;
    } }],
    build: { write: false, minify: false, cssCodeSplit: false, lib: { entry, name: 'PublicPhoneCss', formats: ['iife'] } },
  });
  const output: { fileName: string; source?: string }[] = Array.isArray(bundle) ? bundle[0].output : bundle.output;
  css = String(output.find(item => item.fileName.endsWith('.css'))?.source ?? '');
  browser = await chromium.launch({ headless: true });
  if (shots) mkdirSync(shots, { recursive: true });
}, 60000);
afterAll(async () => { await browser?.close(); }, 30000);

async function open(element: React.ReactElement, width: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 780 } });
  page.setDefaultTimeout(8000);
  await page.route('**/*', route => route.abort());
  await page.setContent('<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<style>${css}</style></head><body>${renderToStaticMarkup(element)}</body></html>`);
  return page;
}
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

for (const width of [390, 360]) {
  it(`${width}px, the comparison page: each row of the table is a card, with every column's answer under its name, all on the screen`, async () => {
    const page = await open(<ArticlePage content={compare} supportEmail="support@example.com" />, width);
    try {
      const region = page.getByRole('region', { name: '对比表格' });
      await region.scrollIntoViewIfNeeded();
      if (shots) await page.screenshot({ path: `${shots}/compare-${width}.png` });
      // Nothing to scroll sideways, in the table or on the page.
      expect(await region.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(0);
      expect(await sideways(page)).toBeLessThanOrEqual(0);
      const cards = await region.locator('tbody tr').evaluateAll(rows => rows.map(row => {
        const box = (element: Element) => {
          const rect = element.getBoundingClientRect();
          return { top: Math.round(rect.top), left: Math.round(rect.left), right: Math.round(rect.right) };
        };
        const cells = [...row.children];
        return { what: (cells[0].textContent ?? '').trim(), boxes: cells.map(box),
          labels: cells.slice(1).map(cell => {
            const label = cell.querySelector('span');
            return label && label.getClientRects().length ? (label.textContent ?? '') : null;
          }),
          text: cells.slice(1).map(cell => (cell.textContent ?? '').trim()) };
      }));
      expect(cards.map(card => card.what)).toEqual(table.rows.map(row => row[0]));
      for (const [index, card] of cards.entries()) {
        // One under the other, each as wide as the card and inside the screen (the last column is Graylum's own).
        expect(card.boxes.map(box => box.top)).toEqual([...card.boxes.map(box => box.top)].sort((a, b) => a - b));
        expect(new Set(card.boxes.map(box => box.top)).size).toBe(card.boxes.length);
        for (const box of card.boxes) { expect(box.left).toBeGreaterThanOrEqual(0); expect(box.right).toBeLessThanOrEqual(width); }
        // Each answer carries its column's name, and the words are the table's own.
        expect(card.labels).toEqual(table.head.slice(1));
        expect(card.text).toEqual(table.rows[index].slice(1).map((cell, column) => table.head[column + 1] + cell));
      }
    } finally { await page.close(); }
  }, 30000);
}

it('1280px, the comparison page: the table it was: a row is one line of cells, the column names in its head only', async () => {
  const page = await open(<ArticlePage content={compare} supportEmail="support@example.com" />, 1280);
  try {
    const row = page.getByRole('region', { name: '对比表格' }).locator('tbody tr').first();
    const tops = await row.locator('th, td').evaluateAll(cells => cells.map(cell => Math.round(cell.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
    expect(await row.locator('td span').evaluateAll(labels => labels.filter(label => label.getClientRects().length).length)).toBe(0);
    expect(await page.getByRole('columnheader').allInnerTexts()).toEqual([...table.head]);
  } finally { await page.close(); }
}, 30000);

const PAGES: [string, () => React.ReactElement][] = [
  ['the comparison page', () => <ArticlePage content={compare} supportEmail="support@example.com" />],
  ['the questions page', () => <FaqPage supportEmail="support@example.com" />],
  ['the refund page', () => <RefundPage supportEmail="support@example.com" />],
];
for (const [name, element] of PAGES) {
  it(`${name}: the crumb back to the home page is a 44px target on a phone and the small link it was on a computer; no sideways scroll at 360px`, async () => {
    const phone = await open(element(), 360);
    try {
      const crumb = phone.locator('nav ol a').first();
      expect((await crumb.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      // The pieces of the row sit on one line.
      const centres = await phone.locator('nav ol').first().locator('li').evaluateAll(items => items.map(item => {
        const rect = item.getBoundingClientRect(); return Math.round(rect.top + rect.height / 2); }));
      expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
      expect(await sideways(phone)).toBeLessThanOrEqual(0);
    } finally { await phone.close(); }
    const computer = await open(element(), 1280);
    try { expect((await computer.locator('nav ol a').first().boundingBox())!.height).toBeLessThan(30); } finally { await computer.close(); }
  }, 30000);
}
