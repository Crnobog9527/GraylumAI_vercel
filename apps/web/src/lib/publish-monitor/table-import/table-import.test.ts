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

  it('detects the separator outside quotes', () => {
    expect(parseCsv(utf8('"Post, title";Likes\n"a, b";3\n'))).toEqual({ header: ['Post, title', 'Likes'], rows: [['a, b', '3']] });
  });

  it('resolves separator ties by structure: plain text commas in a semicolon file do not win', () => {
    expect(parseCsv(utf8('Revenue, USD;Likes\n10,50;3\n7;1\n'))).toEqual({ header: ['Revenue, USD', 'Likes'],
      rows: [['10,50', '3'], ['7', '1']] });
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
    // A CSV that merely starts with "PK" is still a CSV.
    expect((await parseTable('a.csv', utf8('PK,views\np1,10'))).header).toEqual(['PK', 'views']);
  });

  it('marks a 1904-system workbook so its date serials are read from the right epoch', async () => {
    const book = new Uint8Array(zipFixture([
      { name: 'xl/workbook.xml', body: `${HEAD}<workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet r:id="rId1"/></sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', body: `${HEAD}<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: 'xl/worksheets/sheet1.xml', body: `${HEAD}<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>44834</v></c></row></sheetData></worksheet>` },
    ]));
    const grid = await parseXlsx(book);
    expect(grid.date1904).toBe(true);
    expect(parseDate('44834', true)).toBe(new Date(2026, 9, 1).toISOString());
  });

  it('reads percentage-formatted cells as the user sees them (45% is stored as 0.45)', async () => {
    const book = new Uint8Array(zipFixture([
      { name: 'xl/workbook.xml', body: `${HEAD}<workbook xmlns:r="r"><sheets><sheet r:id="rId1"/></sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', body: `${HEAD}<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>` },
      { name: 'xl/styles.xml', body: `${HEAD}<styleSheet><numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>`
        + '<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="9"/><xf numFmtId="164"/></cellXfs></styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', body: `${HEAD}<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>完播率</t></is></c>`
        + '<c r="B1" t="inlineStr"><is><t>播放量</t></is></c></row><row r="2"><c r="A2" s="1"><v>0.45</v></c><c r="B2" s="0"><v>1200</v></c></row>'
        + '<row r="3"><c r="A3" s="2"><v>0.125</v></c><c r="B3"><v>3</v></c></row></sheetData></worksheet>' },
    ]));
    const grid = await parseXlsx(book);
    expect(grid.rows).toEqual([['45%', '1200'], ['12.5%', '3']]);
    expect(buildRows({ ...grid, rows: grid.rows.map(r => ['https://x.com/a', ...r]), header: ['链接', ...grid.header] },
      ['url', 'completion_rate', 'views']).rows[0]!.metrics).toEqual({ completion_rate: 45, views: 1200 });
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
    // Other measures and identifiers are never guessed from a contained word.
    expect(suggestMapping(['总播放时长', '平均播放量', '账号ID', '发布时间段', '总播放量']))
      .toEqual([null, null, null, null, 'views']);
  });

  it('parses Chinese units and percentages; blanks stay absent; nonsense is reported, never guessed', () => {
    expect([parseNumber('1.2万', false), parseNumber('3,400', false), parseNumber('2k', false), parseNumber('', false),
      parseNumber('-', false), parseNumber('45%', true), parseNumber('45%', false), parseNumber('abc', false)])
      .toEqual([12000, 3400, 2000, undefined, undefined, 45, null, null]);
    expect([parseDate('2026年10月1日'), parseDate('2026/10/01 08:30'), parseDate('46296'), parseDate('昨天')])
      // Dates without a zone are read in the browser's local time, as the user's export shows them.
      .toEqual([new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 1, 8, 30).toISOString(),
        new Date(2026, 9, 1).toISOString(), null]);
    // Impossible dates are refused, not rolled over; an explicit zone is honoured.
    expect([parseDate('2026-02-30'), parseDate('2026-10-01T25:00:00Z'), parseDate('2026-10-01T00:00:00+99:99'),
      parseDate('2026-10-01T08:00:00+08:00')]).toEqual([null, null, null, '2026-10-01T00:00:00.000Z']);
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
    // The server's rules apply per row: credentials or a private host in a link, a value above the cap.
    const strict = buildRows({ header: ['链接', '播放量'], rows: [['https://user:pass@example.com/p', '1'],
      ['https://127.0.0.1/p', '1'], ['https://x.com/ok', '10000000000000']] }, ['url', 'views']);
    expect(strict.errors.map(e => e.code)).toEqual(['URL_INVALID', 'URL_INVALID', 'NUMBER_INVALID']);
    expect(suggestMapping(['净增粉丝'])).toEqual([null]);
    // A post key longer than the stored identity is refused, never shortened into another post's key.
    const long = `https://example.com/${'a'.repeat(300)}`;
    expect(buildRows({ header: ['链接', '播放量'], rows: [[long, '1']] }, ['url', 'views']).errors.map(e => e.code))
      .toEqual(['POST_KEY_TOO_LONG']);
  });
});
