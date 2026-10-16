/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { zipFixture } from '@/lib/library-sandbox/__tests__/docx-fixture';
import { buildRows, parseDate, parseNumber, suggestMapping } from './mapping';
import { parseCsv, parseTable, parseXlsx, TABLE_LIMITS, TableImportError } from './table';

const utf8 = (text: string) => new TextEncoder().encode(text);
const code = async (work: () => unknown) => {
  try { await work(); } catch (error) { return error instanceof TableImportError ? error.code : String(error); }
  return 'NO_ERROR';
};
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function xlsx(sheet: string, shared?: string[], extra: Array<{ name: string; body: string | Buffer; deflate?: boolean;
  declaredSize?: number }> = []) {
  return new Uint8Array(zipFixture([
    { name: '[Content_Types].xml', body: `${HEAD}<Types xmlns="x"/>` },
    { name: 'xl/workbook.xml', body: `${HEAD}<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', body: `${HEAD}<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>` },
    ...(shared ? [{ name: 'xl/sharedStrings.xml', body: `${HEAD}<sst>${shared.map(s => `<si><t>${s}</t></si>`).join('')}</sst>` }] : []),
    { name: 'xl/worksheets/sheet1.xml', body: `${HEAD}<worksheet><sheetData>${sheet}</sheetData></worksheet>`, deflate: true },
    ...extra,
  ]));
}

describe('CSV', () => {
  it('reads quoted fields, doubled quotes, embedded newlines, BOM and semicolons; drops blank lines', () => {
    const grid = parseCsv(utf8('﻿标题;播放量\r\n"a; ""b""\nc";"1,234"\r\n\r\n"x";5\n'));
    expect(grid).toEqual({ header: ['标题', '播放量'], rows: [['a; "b"\nc', '1,234'], ['x', '5']] });
  });

  it('falls back to GB18030 for Chinese exports', () => {
    const gbk = new Uint8Array([0xb2, 0xa5, 0xb7, 0xc5, 0x2c, 0x61, 0x0a, 0x31, 0x2c, 0x32]); // "播放,a\n1,2"
    expect(parseCsv(gbk).header).toEqual(['播放', 'a']);
  });

  it('enforces file, row, column and cell limits, and refuses an unterminated quote', async () => {
    expect(await code(() => parseCsv(new Uint8Array(TABLE_LIMITS.maxFileBytes + 1).fill(97)))).toBe('TABLE_TOO_LARGE');
    expect(await code(() => parseCsv(utf8(`h\n${'1\n'.repeat(TABLE_LIMITS.maxRows + 1)}`)))).toBe('TABLE_TOO_MANY_ROWS');
    expect(await code(() => parseCsv(utf8(`${Array(TABLE_LIMITS.maxColumns + 1).fill('h').join(',')}\n`))))
      .toBe('TABLE_TOO_MANY_COLUMNS');
    expect(await code(() => parseCsv(utf8(`h\n"${'x'.repeat(TABLE_LIMITS.maxCellChars + 1)}"`)))).toBe('TABLE_CELL_TOO_LONG');
    expect(await code(() => parseCsv(utf8('h\n"open')))).toBe('TABLE_MALFORMED');
    expect(await code(() => parseCsv(utf8('\n \n')))).toBe('TABLE_EMPTY');
  });
});

describe('XLSX', () => {
  it('reads shared, inline, numeric and sparse cells from the first worksheet', async () => {
    const sheet = '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
      + '<row r="2"><c r="A1" t="inlineStr"><is><t>A &amp; B</t></is></c><c r="C2"><v>1200</v></c></row>';
    expect(await parseXlsx(xlsx(sheet, ['标题', '播放量']))).toEqual({ header: ['标题', '', '播放量'], rows: [['A & B', '', '1200']] });
  });

  it('refuses a zip bomb, a DTD, a non-zip file named .xlsx and a sheet path outside the package', async () => {
    const bomb = xlsx('<row r="1"><c r="A1"><v>1</v></c></row>', undefined,
      [{ name: 'xl/bomb.xml', body: Buffer.alloc(30_000_000, 0x20), deflate: true }]);
    expect(await code(() => parseXlsx(bomb))).toBe('TABLE_TOO_LARGE');
    const dtd = xlsx('<row r="1"><c r="A1"><v>1</v></c></row>', undefined,
      [{ name: 'xl/sharedStrings.xml', body: `${HEAD}<!DOCTYPE x [<!ENTITY a "b">]><sst/>` }]);
    expect(await code(() => parseXlsx(dtd))).toBe('TABLE_MALFORMED');
    expect(await code(() => parseTable('a.xlsx', utf8('not a zip')))).toBe('TABLE_MALFORMED');
    const escape = new Uint8Array(zipFixture([
      { name: 'xl/workbook.xml', body: `${HEAD}<workbook xmlns:r="r"><sheets><sheet r:id="rId1"/></sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', body: `${HEAD}<Relationships><Relationship Id="rId1" Target="../../etc/x.xml"/></Relationships>` },
    ]));
    expect(await code(() => parseXlsx(escape))).toBe('TABLE_MALFORMED');
    expect(await code(() => parseTable('a.pdf', utf8('x')))).toBe('TABLE_FORMAT_UNSUPPORTED');
  });

  it('caps rows in a worksheet', async () => {
    const rows = Array.from({ length: TABLE_LIMITS.maxRows + 2 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`);
    expect(await code(() => parseXlsx(xlsx(rows.join(''))))).toBe('TABLE_TOO_MANY_ROWS');
  });
});

describe('column mapping and rows', () => {
  it('suggests fields from common Chinese and English headers and leaves unknown columns unmapped', () => {
    expect(suggestMapping(['作品链接', '发布时间', '作品标题', '播放量', '点赞数', '评论', '收藏', '完播率', '奇怪的列', 'Shares']))
      .toEqual(['url', 'postedAt', 'title', 'views', 'likes', 'comments', 'saves', 'completion_rate', null, 'shares']);
  });

  it('parses Chinese units and percentages; blanks stay absent; nonsense is reported, never guessed', () => {
    expect([parseNumber('1.2万', false), parseNumber('3,400', false), parseNumber('2k', false), parseNumber('', false),
      parseNumber('-', false), parseNumber('45%', true), parseNumber('45%', false), parseNumber('abc', false)])
      .toEqual([12000, 3400, 2000, undefined, undefined, 45, null, null]);
    expect([parseDate('2026年10月1日'), parseDate('2026/10/01 08:30'), parseDate('46296'), parseDate('昨天')])
      // Dates without a zone are read in the browser's local time, as the user's export shows them.
      .toEqual([new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 1, 8, 30).toISOString(), expect.stringMatching(/^2026-/), null]);
  });

  it('builds confirmable rows: needs a post ID or link and a metric; bad cells are listed by line', () => {
    const grid = { header: ['链接', '播放量', '点赞'], rows: [
      ['https://www.douyin.com/video/1', '1.5万', ''],
      ['', '10', '1'],
      ['https://x.com/a', '', ''],
      ['https://x.com/b', 'lots', '2'],
      ['javascript:alert(1)', '1', '1'],
    ] };
    const built = buildRows(grid, suggestMapping(grid.header));
    expect(built.rows).toEqual([{ postKey: 'https://www.douyin.com/video/1', url: 'https://www.douyin.com/video/1',
      postedAt: null, titleExcerpt: null, metrics: { views: 15000 } }]);
    expect(built.errors.map(e => [e.line, e.code])).toEqual([[3, 'POST_KEY_MISSING'], [4, 'METRICS_EMPTY'],
      [5, 'NUMBER_INVALID'], [6, 'URL_INVALID']]);
    expect(buildRows(grid, ['url', 'views', 'views']).duplicateFields).toEqual(['views']);
  });
});
