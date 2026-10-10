/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { wordFilename, wordSegments } from './wordContent';
const split = (text: string, headings: Parameters<typeof wordSegments>[1] = []) => wordSegments(Buffer.from(text), headings);
describe('Word extracted text boundaries', () => {
  it('preserves UTF-16 positions, headings, tables, footnotes and literal markup without parsing', () => {
    const text = '页眉😀\n第一章\n一\t二\n\n<script>x</script>\n脚注\n结尾\n结束';
    const result = split(text, [{ offset: text.indexOf('第一章'), level: 1, text: '第一章' },
      { offset: text.indexOf('结尾'), level: 9, text: '结尾' }]);
    expect(result.map(s => s.body).join('')).toBe(text);
    expect(result.map(s => s.title)).toEqual(['', '第一章', '第一章', '结尾']);
  });
  it('accepts LIB-2b normalized labels while preserving heading tabs and line breaks', () => {
    const text = '  一\t二\n三\n正文';
    const parts = split(text, [{ offset: 0, level: 1, text: '一 二 三' }]);
    expect(parts.map(s => s.body).join('')).toBe(text);
    expect(parts[0].title).toBe('一 二 三');
  });
  it('escapes regexp metacharacters in labels', () => {
    expect(split('标题 [.*] (a+)\n正文', [{ offset: 0, level: 1, text: '标题 [.*] (a+)' }])[0].title).toBe('标题 [.*] (a+)');
    expect(() => split('标题 XXX\n正文', [{ offset: 0, level: 1, text: '标题 .*' }])).toThrow('LIBRARY_HEADINGS');
  });
  it('preserves BOM bytes and emoji when splitting at 8192 bytes', () => {
    const text = '\ufeff' + '😀'.repeat(6000);
    const parts = split(text);
    expect(parts.map(s => s.body).join('')).toBe(text);
    expect(parts.every(s => Buffer.byteLength(s.body) <= 8192 && s.body.isWellFormed())).toBe(true);
  });
  it.each([
    [{ offset: -1, level: 1, text: '标题' }],
    [{ offset: 0, level: 0, text: '标题' }],
    [{ offset: 0, level: 10, text: '标题' }],
    [{ offset: 1, level: 1, text: '题' }],
    [{ offset: 0, level: 1, text: '标' }],
    [{ offset: 0, level: 1, text: '错' }],
    [{ offset: 0, level: 1, text: '标题' }, { offset: 0, level: 1, text: '标题' }],
    [{ offset: 3, level: 1, text: '末尾' }, { offset: 0, level: 1, text: '标题' }],
    [{ offset: 99, level: 1, text: '标题' }],
  ])('rejects invalid, overlapping or unordered headings %j', (...headings) => {
    expect(() => split('标题\n末尾', headings)).toThrow('LIBRARY_HEADINGS');
  });
  it('rejects surrogate boundaries, oversized titles and excess heading counts', () => {
    expect(() => split('😀\n', [{ offset: 1, level: 1, text: '\ude00' }])).toThrow('LIBRARY_HEADINGS');
    expect(() => split('中'.repeat(171), [{ offset: 0, level: 1, text: '中'.repeat(171) }])).toThrow('LIBRARY_HEADINGS');
    expect(() => split('a', Array.from({ length: 10001 }, () => ({ offset: 0, level: 1, text: 'a' })))).toThrow('LIBRARY_HEADINGS');
  });
  it('rejects invalid UTF-8, NUL, empty, byte/line and segment overflow', () => {
    expect(() => wordSegments(new Uint8Array([255]), [])).toThrow('LIBRARY_ENCODING');
    expect(() => split('a\0b')).toThrow('LIBRARY_TYPE');
    expect(() => split('')).toThrow('LIBRARY_TEXT_LIMIT');
    expect(() => wordSegments(new Uint8Array(10_000_001), [])).toThrow('LIBRARY_TEXT_LIMIT');
    expect(() => split('a'.repeat(65537))).toThrow('LIBRARY_LINE_LIMIT');
    expect(() => split('\n'.repeat(10001))).toThrow('LIBRARY_TEXT_LIMIT');
  });
  it('accepts only safe docx filenames', () => {
    expect(() => wordFilename('我的文档.DOCX')).not.toThrow();
    for (const name of ['a.pdf', 'a.doc', '../a.docx', 'a\0.docx']) expect(() => wordFilename(name)).toThrow('LIBRARY_TYPE');
  });
});
