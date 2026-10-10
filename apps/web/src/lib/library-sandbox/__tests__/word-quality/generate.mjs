#!/usr/bin/env node
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Regenerates the fixed Word quality corpus (fixtures/*.docx + gold.json). Needs LibreOffice
// (`soffice`) and macOS `textutil`; CI only reads the committed output. Run with Node 24:
//   node apps/web/src/lib/library-sandbox/__tests__/word-quality/generate.mjs
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_SAMPLES, specGold } from './corpus.mjs';
import { RAW_SAMPLES } from './raw-samples.mjs';
import { buildDocx } from '../docx-fixture.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const esc = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FODT_HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"
 xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"
 xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.3" office:mimetype="application/vnd.oasis.opendocument.text">
<office:styles>
${[1, 2, 3].map((n) => `<style:style style:name="Heading_20_${n}" style:display-name="Heading ${n}" style:family="paragraph" `
  + `style:default-outline-level="${n}"/>`).join('\n')}
<text:list-style style:name="Num">${[1, 2, 3].map((n) =>
  `<text:list-level-style-number text:level="${n}" style:num-suffix="." style:num-format="1"/>`).join('')}</text:list-style>
<text:list-style style:name="Bul">${[1, 2, 3].map((n) =>
  `<text:list-level-style-bullet text:level="${n}" text:bullet-char="•"/>`).join('')}</text:list-style>
</office:styles>
<office:automatic-styles><style:page-layout style:name="pm1"><style:header-style/><style:footer-style/></style:page-layout></office:automatic-styles>`;

function fodtInline(segments, counter) {
  return (typeof segments === 'string' ? [segments] : segments).map((segment) => {
    if (typeof segment === 'string') return esc(segment);
    if (segment.link) return `<text:a xlink:type="simple" xlink:href="${esc(segment.href)}">${esc(segment.link)}</text:a>`;
    counter.n += 1;
    const kind = segment.note ? 'footnote' : 'endnote';
    return `<text:note text:id="n${counter.n}" text:note-class="${kind}"><text:note-citation>${counter.n}</text:note-citation>`
      + `<text:note-body><text:p>${esc(segment.note ?? segment.endnote)}</text:p></text:note-body></text:note>`;
  }).join('');
}

function fodtCell(cell) {
  const inner = typeof cell === 'string' ? `<text:p>${esc(cell)}</text:p>` : fodtTable(cell.table);
  return `<table:table-cell office:value-type="string">${inner}</table:table-cell>`;
}

let tables = 0;
function fodtTable(rows) {
  tables += 1;
  const columns = Math.max(...rows.map((row) => row.length));
  return `<table:table table:name="T${tables}"><table:table-column table:number-columns-repeated="${columns}"/>`
    + rows.map((row) => `<table:table-row>${row.map(fodtCell).join('')}</table:table-row>`).join('') + '</table:table>';
}

function fodtList(items, ordered) {
  const body = items.map((item) => typeof item === 'string'
    ? `<text:list-item><text:p>${esc(item)}</text:p></text:list-item>`
    : `<text:list-item>${fodtList(item.list, ordered)}</text:list-item>`).join('');
  return `<text:list text:style-name="${ordered ? 'Num' : 'Bul'}">${body}</text:list>`;
}

function fodt(spec) {
  const counter = { n: 0 };
  const header = spec.header ? `<style:header><text:p>${esc(spec.header)}</text:p></style:header>` : '';
  const footer = spec.footer === 'page'
    ? '<style:footer><text:p>第 <text:page-number text:select-page="current">1</text:page-number> 页</text:p></style:footer>' : '';
  const body = spec.blocks.map((block) => {
    if (block.h) return `<text:h text:style-name="Heading_20_${block.h}" text:outline-level="${block.h}">${esc(block.text)}</text:h>`;
    if (block.p !== undefined) return `<text:p>${fodtInline(block.p, counter)}</text:p>`;
    if (block.table) return fodtTable(block.table);
    return fodtList(block.list, block.ordered);
  }).join('\n');
  return `${FODT_HEAD}<office:master-styles><style:master-page style:name="Standard" style:page-layout-name="pm1">${header}${footer}`
    + `</style:master-page></office:master-styles><office:body><office:text>${body}</office:text></office:body></office:document>`;
}

function html(spec) {
  const body = spec.blocks.map((block) => `<p>${esc(typeof block.p === 'string' ? block.p : '')}</p>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
}

rmSync(fixtures, { recursive: true, force: true });
mkdirSync(fixtures, { recursive: true });
const work = mkdtempSync(path.join(tmpdir(), 'word-quality-'));
const gold = [];
const libreoffice = SPEC_SAMPLES.filter((spec) => spec.producer === 'libreoffice');
for (const spec of libreoffice) writeFileSync(path.join(work, `${spec.id}.fodt`), fodt(spec));
execFileSync('soffice', ['--headless', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', fixtures,
  ...libreoffice.map((spec) => path.join(work, `${spec.id}.fodt`))], { stdio: 'ignore' });
for (const spec of SPEC_SAMPLES.filter((item) => item.producer === 'textutil')) {
  const source = path.join(work, `${spec.id}.html`);
  writeFileSync(source, html(spec));
  execFileSync('textutil', ['-convert', 'docx', source, '-output', path.join(fixtures, `${spec.id}.docx`)]);
}
for (const spec of SPEC_SAMPLES) gold.push({ id: spec.id, producer: spec.producer, ...specGold(spec) });
for (const sample of RAW_SAMPLES) {
  writeFileSync(path.join(fixtures, `${sample.id}.docx`), buildDocx(sample.parts));
  gold.push({ id: sample.id, producer: 'raw-ooxml', text: sample.lines.join('\n'), headings: sample.headings });
}
rmSync(work, { recursive: true, force: true });
for (const item of gold) readFileSync(path.join(fixtures, `${item.id}.docx`));
writeFileSync(path.join(here, 'gold.json'), `${JSON.stringify(gold, null, 1)}\n`);
console.log(`word quality corpus: ${gold.length} samples`);
