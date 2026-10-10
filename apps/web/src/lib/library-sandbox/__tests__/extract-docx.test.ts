/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import { extractDocx } from '../docx/extract-docx';
import { inspectZip } from '../docx/zip-guard';
import { rebuildZip } from '../docx/zip-rewrite';
import {
  buildDocx, footnoteRef, hyperlink, para, picture, run, table, TINY_PNG, zipFixture,
} from './docx-fixture';

const extract = (bytes: Buffer) => extractDocx(new Uint8Array(bytes));

async function code(bytes: Buffer): Promise<string> {
  try {
    await extract(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    return (error as SandboxError).code;
  }
  throw new Error('expected a rejection');
}

describe('extractDocx: text, structure and images', () => {
  it('keeps headings in order, tables, headers, footers, footnotes and link text only', async () => {
    const body = [
      para('年度报告', 'Title'),
      para('第一章 概述', 'Heading1'),
      `<w:p>${run('正文第一段，引用')}${footnoteRef(1)}${run('。')}</w:p>`,
      `<w:p>${run('访问 ')}${hyperlink(1, '官方网站')}${run(' 了解更多')}</w:p>`,
      para('1.1 背景', 'Heading2'),
      table([['项目', '金额'], ['收入', '100']]),
      para('Chapter Two', 'Heading1'),
      para('English body text.'),
    ].join('');
    const result = await extract(buildDocx({
      body, header: '机密 Confidential', footer: '第 1 页', footnotes: ['脚注内容 footnote'],
      hyperlinks: ['https://example.invalid/track?x=1'],
    }));
    expect(result.text.split('\n')).toEqual([
      '机密 Confidential',
      '年度报告',
      '第一章 概述',
      '正文第一段，引用[1]。',
      '访问 官方网站 了解更多',
      '1.1 背景',
      '项目\t金额',
      '收入\t100',
      'Chapter Two',
      'English body text.',
      '[1] 脚注内容 footnote',
      '第 1 页',
    ]);
    expect(result.headings.map(({ level, text }) => [level, text])).toEqual([
      [1, '年度报告'], [1, '第一章 概述'], [2, '1.1 背景'], [1, 'Chapter Two'],
    ]);
    for (const heading of result.headings) expect(result.text.slice(heading.offset)).toMatch(new RegExp(`^${heading.text}`));
    expect(result.text).not.toContain('example.invalid');
    expect(result.images).toEqual([]);
  });

  it('returns embedded image bytes with their position but does not recognise them', async () => {
    const result = await extract(buildDocx({
      body: `${para('图前')}<w:p>${picture(1)}</w:p>${para('图后')}`, images: [TINY_PNG],
    }));
    expect(result.text).toBe('图前\n图后');
    expect(result.imageCount).toBe(1);
    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toMatchObject({ index: 0, contentType: 'image/png', offset: 3 });
    expect(Buffer.from(result.images[0].bytes)).toEqual(TINY_PNG);
  });

  it('records each image at its exact inline position, in tables and list items too', async () => {
    const numbering = '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>'
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>';
    const body = [
      `<w:p>${run('前')}${picture(1)}${run('中')}${picture(2)}${run('后\uFDD0' + '9\uFDD1')}</w:p>`,
      para('标题', 'Heading1'),
      `<w:tbl><w:tr><w:tc>${para('格一')}</w:tc><w:tc><w:p>${run('格二')}${picture(3)}</w:p></w:tc></w:tr></w:tbl>`,
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${run('项')}${picture(4)}</w:p>`,
    ].join('');
    const result = await extract(buildDocx({ body, numbering, images: [TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG] }));
    expect(result.text).toBe('前中后9\n标题\n格一\t格二\n1. 项');
    const at = (offset: number) => result.text.slice(0, offset);
    expect(result.images.map((image) => at(image.offset))).toEqual(['前', '前中', '前中后9\n标题\n格一\t格二', '前中后9\n标题\n格一\t格二\n1. 项']);
    expect(result.headings).toEqual([{ level: 1, text: '标题', offset: 5 }]);
  });

  it('numbers contiguous list items and keeps unordered bullets', async () => {
    const level = (format: string) => `<w:lvl w:ilvl="0"><w:numFmt w:val="${format}"/></w:lvl>`;
    const numbering = `<w:abstractNum w:abstractNumId="0">${level('decimal')}</w:abstractNum>`
      + `<w:abstractNum w:abstractNumId="1">${level('bullet')}</w:abstractNum>`
      + '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>';
    const item = (numId: number, text: string) =>
      `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
    const result = await extract(buildDocx({
      body: [item(1, '甲'), item(1, '乙'), para('间隔'), item(1, '丙'), item(2, '点')].join(''), numbering,
    }));
    expect(result.text).toBe('1. 甲\n2. 乙\n间隔\n1. 丙\n• 点');
  });
});

describe('simple fields', () => {
  it('keeps the displayed result of w:fldSimple and never evaluates the instruction', async () => {
    const body = `<w:p>${run('日期：')}<w:fldSimple w:instr=" DATE \\@ &quot;yyyy>MM&quot; ">${run('2026-10-10')}</w:fldSimple>`
      + `<w:fldSimple w:instr="PAGE"/>${run('。')}</w:p>${para('后文')}`;
    const result = await extract(buildDocx({ body, images: [TINY_PNG], footnotes: ['注'] }));
    expect(result.text).toBe('日期：2026-10-10。\n后文');
  });

  it('rebuilds a package the guard accepts with identical untouched members', async () => {
    const bytes = new Uint8Array(buildDocx({ body: para('x'), images: [TINY_PNG] }));
    const zip = await inspectZip(bytes);
    const rebuilt = rebuildZip(zip.members, new Map([['word/document.xml', '<w:document/>']]));
    const again = await inspectZip(rebuilt);
    expect(again.names).toEqual(zip.names);
    expect(new TextDecoder().decode(again.xmlParts.get('word/document.xml'))).toBe('<w:document/>');
    const image = (z: typeof zip) => z.members.find((member) => member.name.endsWith('.png'))!.raw;
    expect(Buffer.from(image(again))).toEqual(Buffer.from(image(zip)));
  });
});

describe('extractDocx: rejects unsafe or broken input before the parser runs', () => {
  it('rejects empty and oversized input', async () => {
    expect(await code(Buffer.alloc(0))).toBe('INPUT_EMPTY');
    expect(await code(Buffer.alloc(10_000_001))).toBe('INPUT_TOO_LARGE');
  });

  it('rejects macros, nested archives, DTDs and missing packages', async () => {
    expect(await code(buildDocx({ body: para('x'), extra: [{ name: 'word/vbaProject.bin', body: 'x' }] }))).toBe('DOCX_MACRO');
    expect(await code(buildDocx({ body: para('x'), contentTypesExtra: '<Default Extension="bin" ContentType="macroEnabled"/>' })))
      .toBe('DOCX_MACRO');
    expect(await code(buildDocx({ body: para('x'), extra: [{ name: 'word/embeddings/a.xlsx', body: 'x' }] })))
      .toBe('DOCX_NESTED_ARCHIVE');
    const nested = zipFixture([{ name: 'inner.xml', body: '<x/>' }]);
    expect(await code(buildDocx({ body: para('x'), extra: [{ name: 'word/media/image9.png', body: nested }] })))
      .toBe('DOCX_NESTED_ARCHIVE');
    expect(await code(buildDocx({ body: '<!DOCTYPE x [<!ENTITY e "boom">]>' }))).toBe('XML_DTD');
    expect(await code(zipFixture([{ name: 'word/document.xml', body: '<!DOCTYPE x SYSTEM "https://example.invalid/x"><x/>' }])))
      .toBe('XML_DTD');
    expect(await code(zipFixture([{ name: 'word/document.xml', body: '<x/>' }]))).toBe('DOCX_INVALID');
  });

  it('reports text over 10,000,000 UTF-8 bytes instead of truncating', async () => {
    let seed = 7;
    const random = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
    const chunk = () => Array.from({ length: 100_000 }, () => String.fromCharCode(0x4e00 + Math.floor(random() * 20_000))).join('');
    const body = Array.from({ length: 34 }, () => para(chunk())).join('');
    expect(await code(buildDocx({ body }))).toBe('TEXT_TOO_LARGE');
  });
});
