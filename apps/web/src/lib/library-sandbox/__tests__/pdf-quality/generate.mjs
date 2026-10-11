#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Regenerates the fixed text-PDF quality corpus (fixtures/*.pdf + gold.json) and the encrypted PDF
// samples (../pdf-fixtures/). Needs LibreOffice (`soffice`), the Playwright Chromium and the open-licence
// font "Noto Sans S Chinese" (Noto Sans CJK SC, SIL OFL) installed; CI only reads the committed
// output. Run with Node 24:
//   node apps/web/src/lib/library-sandbox/__tests__/pdf-quality/generate.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { footerText, SPEC_SAMPLES, specGold } from './corpus.mjs';
import { encodeFor, textDocument, textLine } from '../pdf-fixture.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const encrypted = path.join(here, '..', 'pdf-fixtures');
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const CJK = /[　-鿿＀-￯]/;

// ---------- LibreOffice ----------

function fodt(spec) {
  const header = spec.header ? `<style:header><text:p>${esc(spec.header)}</text:p></style:header>` : '';
  const footer = spec.footer === 'cn-page'
    ? '<style:footer><text:p>第 <text:page-number text:select-page="current">1</text:page-number> 页</text:p></style:footer>'
    : spec.footer === 'en-page'
      ? '<style:footer><text:p>Page <text:page-number text:select-page="current">1</text:page-number> of '
        + '<text:page-count>1</text:page-count></text:p></style:footer>'
      : '';
  let tables = 0;
  let sections = 0;
  const block = (item, first) => {
    const style = first ? 'PB' : 'Body';
    if (item.h !== undefined) return `<text:h text:style-name="${first ? 'HPB' : 'H'}" text:outline-level="1">${esc(item.h)}</text:h>`;
    if (item.p !== undefined) return `<text:p text:style-name="${style}">${esc(item.p)}</text:p>`;
    if (item.table) {
      tables += 1;
      const rows = item.table.map((row) => `<table:table-row>${row.map((cell) =>
        `<table:table-cell office:value-type="string"><text:p>${esc(cell)}</text:p></table:table-cell>`).join('')}</table:table-row>`);
      const columns = item.table[0].length;
      const lead = first ? '<text:p text:style-name="PB"/>' : '';
      return `${lead}<table:table table:name="T${tables}"><table:table-column table:number-columns-repeated="${columns}"/>${rows.join('')}</table:table>`;
    }
    sections += 1;
    const lead = first ? '<text:p text:style-name="PB"/>' : '';
    return `${lead}<text:section text:style-name="Cols" text:name="S${sections}">${item.columns.map((inner) => block(inner, false)).join('')}</text:section>`;
  };
  const body = spec.pages.map((blocks, page) => blocks.map((item, index) => block(item, page > 0 && index === 0)).join('\n')).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:font-face-decls>
 <style:font-face style:name="DejaVu Sans" svg:font-family="'DejaVu Sans'" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"/>
 <style:font-face style:name="Noto Sans S Chinese" svg:font-family="'Noto Sans S Chinese'" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0"/>
</office:font-face-decls>
<office:styles>
 <style:default-style style:family="paragraph"><style:text-properties style:font-name="DejaVu Sans" fo:font-size="10.5pt"
  style:font-name-asian="Noto Sans S Chinese" style:font-size-asian="10.5pt" fo:language="en" fo:country="US" fo:hyphenate="false"/>
 <style:paragraph-properties fo:margin-bottom="0.15cm"/></style:default-style>
 <style:style style:name="Body" style:family="paragraph"/>
 <style:style style:name="H" style:family="paragraph"><style:text-properties fo:font-size="16pt" style:font-size-asian="16pt" fo:font-weight="bold"/></style:style>
</office:styles>
<office:automatic-styles>
 <style:style style:name="PB" style:family="paragraph" style:parent-style-name="Body"><style:paragraph-properties fo:break-before="page"/></style:style>
 <style:style style:name="HPB" style:family="paragraph" style:parent-style-name="H"><style:paragraph-properties fo:break-before="page"/></style:style>
 <style:style style:name="Cols" style:family="section"><style:section-properties><style:columns fo:column-count="2" fo:column-gap="0.8cm"/>
 </style:section-properties></style:style>
 <style:page-layout style:name="pm1"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" fo:margin="2cm"/>
 <style:header-style/><style:footer-style/></style:page-layout>
</office:automatic-styles>
<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">${header}${footer}</style:master-page></office:master-styles>
<office:body><office:text>${body}</office:text></office:body></office:document>`;
}

// ---------- Chromium ----------

function html(spec) {
  const block = (item) => {
    if (item.h !== undefined) return `<h1>${esc(item.h)}</h1>`;
    if (item.p !== undefined) return `<p>${esc(item.p)}</p>`;
    if (item.table) return `<table>${item.table.map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</table>`;
    return `<div class="cols">${item.columns.map(block).join('')}</div>`;
  };
  const pages = spec.pages.map((blocks) => `<section>${blocks.map(block).join('')}</section>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { font-family: 'Noto Sans S Chinese'; font-size: 11pt; margin: 0; }
  section { break-after: page; } section:last-child { break-after: auto; }
  h1 { font-size: 18pt; margin: 0 0 10pt; } p { margin: 0 0 8pt; line-height: 1.5; }
  table { border-collapse: collapse; margin: 0 0 10pt; } td { border: 1px solid #888; padding: 3pt 8pt; }
  .cols { column-count: 2; column-gap: 24pt; }
  </style></head><body>${pages}</body></html>`;
}

function template(text) {
  return `<div style="font-family: 'Noto Sans S Chinese'; font-size: 9pt; width: 100%; text-align: center;">${text}</div>`;
}

async function chromiumPdf(browser, spec, file) {
  const page = await browser.newPage();
  await page.setContent(html(spec));
  const footer = spec.footer === 'cn-page' ? '第 <span class="pageNumber"></span> 页'
    : spec.footer === 'en-page' ? 'Page <span class="pageNumber"></span> of <span class="totalPages"></span>' : '';
  await page.pdf({
    path: file, format: 'A4', margin: { top: '22mm', bottom: '22mm', left: '20mm', right: '20mm' },
    displayHeaderFooter: Boolean(spec.header || spec.footer),
    headerTemplate: template(spec.header ? esc(spec.header) : ''), footerTemplate: template(footer),
  });
  await page.close();
}

// ---------- Hand-written PDF ----------

function wrap(text, width) {
  if (CJK.test(text)) return Array.from({ length: Math.ceil(Array.from(text).length / width) }, (_, index) =>
    Array.from(text).slice(index * width, (index + 1) * width).join(''));
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && `${line} ${word}`.length > width * 2) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function rawPdf(spec) {
  const fontFor = (text) => (CJK.test(text) ? spec.font : 'F1');
  const pages = spec.pages.map((blocks, index) => {
    let content = '';
    let y = 770;
    const line = (text, size, x = 72) => {
      content += textLine(fontFor(text), size, x, y, encodeFor(fontFor(text), text));
      y -= size * 1.6;
    };
    if (spec.header) {
      content += textLine(fontFor(spec.header), 9, 72, 810, encodeFor(fontFor(spec.header), spec.header));
    }
    const flow = (item, width, x) => {
      if (item.h !== undefined) line(item.h, 16, x);
      else if (item.p !== undefined) for (const part of wrap(item.p, width)) line(part, 11, x);
      else if (item.table) {
        // Column x positions from the widest cell (CID fonts here advance 1 em per character).
        const widths = item.table[0].map((_, column) => Math.max(...item.table.map((row) => Array.from(row[column]).length * 10)) + 14);
        for (const row of item.table) {
          let left = x;
          row.forEach((cell, column) => {
            content += textLine(fontFor(cell), 10, left, y, encodeFor(fontFor(cell), cell));
            left += widths[column];
          });
          y -= 18;
        }
      }
      y -= 6;
    };
    for (const item of blocks) {
      if (!item.columns) {
        flow(item, 38, 72);
        continue;
      }
      const top = y;
      const half = Math.ceil(item.columns.length / 2);
      item.columns.slice(0, half).forEach((inner) => flow(inner, 18, 72));
      y = top;
      item.columns.slice(half).forEach((inner) => flow(inner, 18, 318));
    }
    const footer = footerText(spec.footer, index + 1, spec.pages.length);
    if (footer) content += textLine(fontFor(footer), 9, 280, 30, encodeFor(fontFor(footer), footer));
    return { content };
  });
  return textDocument({ pages, deflate: true });
}

// ---------- Encrypted samples (LibreOffice export options) ----------

function encryptedSamples(work) {
  mkdirSync(encrypted, { recursive: true });
  const source = path.join(work, 'locked.fodt');
  writeFileSync(source, fodt({ pages: [[{ p: '这份文件加了密码，应该被拒绝。 This file is encrypted and must be refused.' }]] }));
  const variants = {
    'encrypted-open-password': { EncryptFile: { type: 'boolean', value: 'true' }, DocumentOpenPassword: { type: 'string', value: 'graylum' } },
    'encrypted-permissions-only': { RestrictPermissions: { type: 'boolean', value: 'true' }, PermissionPassword: { type: 'string', value: 'owner' } },
  };
  for (const [name, options] of Object.entries(variants)) {
    const out = path.join(work, name);
    mkdirSync(out);
    execFileSync('soffice', ['--headless', '--convert-to', `pdf:writer_pdf_Export:${JSON.stringify(options)}`, '--outdir', out, source],
      { stdio: 'ignore' });
    writeFileSync(path.join(encrypted, `${name}.pdf`), readFileSync(path.join(out, 'locked.pdf')));
  }
}

const pageCount = (bytes) => Math.max(...[...bytes.toString('latin1').matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)]
  .map((match) => Number(match[1])), 0);

rmSync(fixtures, { recursive: true, force: true });
mkdirSync(fixtures, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'pdf-quality-'));
const libreoffice = SPEC_SAMPLES.filter((spec) => spec.producer === 'libreoffice');
for (const spec of libreoffice) writeFileSync(path.join(work, `${spec.id}.fodt`), fodt(spec));
execFileSync('soffice', ['--headless', '--convert-to', 'pdf', '--outdir', fixtures,
  ...libreoffice.map((spec) => path.join(work, `${spec.id}.fodt`))], { stdio: 'ignore' });
const browser = await chromium.launch({ headless: true });
for (const spec of SPEC_SAMPLES.filter((item) => item.producer === 'chromium')) {
  await chromiumPdf(browser, spec, path.join(fixtures, `${spec.id}.pdf`));
}
await browser.close();
for (const spec of SPEC_SAMPLES.filter((item) => item.producer === 'raw')) writeFileSync(path.join(fixtures, `${spec.id}.pdf`), rawPdf(spec));
encryptedSamples(work);
rmSync(work, { recursive: true, force: true });
const gold = SPEC_SAMPLES.map((spec) => ({ id: spec.id, producer: spec.producer, lang: spec.lang, pages: specGold(spec) }));
for (const item of gold) {
  const pages = pageCount(readFileSync(path.join(fixtures, `${item.id}.pdf`)));
  if (pages !== item.pages.length) throw new Error(`${item.id}: ${pages} pages, expected ${item.pages.length}; shorten the spec`);
}
writeFileSync(path.join(here, 'gold.json'), `${JSON.stringify(gold, null, 1)}\n`);
console.log(`pdf quality corpus: ${gold.length} samples, ${gold.reduce((sum, item) => sum + item.pages.length, 0)} pages`);
