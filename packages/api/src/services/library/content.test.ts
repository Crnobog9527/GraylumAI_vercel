/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { formatFor, textSegments, verifyHeader, canonicalPath } from './content';

describe('library untrusted content', () => {
  it('checks extension and MIME; rejects active/unsupported and unsafe names', () => {
    expect(formatFor('照片.JPG','image/jpeg')).toBe('jpeg');
    for(const name of ['a.svg','a.gif','a.heic','a.mp4','a.mp3','a.pdf','a.docx','../a.png','a\n.png']) {
      expect(()=>formatFor(name,'image/png')).toThrow('LIBRARY_TYPE');
    }
    expect(()=>formatFor('a.png','text/plain')).toThrow('LIBRARY_TYPE');
  });
  it('accepts only matching image magic and never decodes or changes original bytes', () => {
    const png=Uint8Array.from([137,80,78,71,13,10,26,10,1]);
    const saved=png.slice(); verifyHeader('png',png); expect(png).toEqual(saved);
    verifyHeader('jpeg',Uint8Array.from([255,216,255,225,0,0]));
    verifyHeader('webp',Buffer.from('RIFF0000WEBP'));
    expect(()=>verifyHeader('png',Buffer.from('<svg><script>'))).toThrow('LIBRARY_TYPE');
    expect(()=>verifyHeader('jpeg',png)).toThrow('LIBRARY_TYPE');
  });
  it('strict UTF-8 and size/line bounds reject rather than truncate', () => {
    expect(()=>textSegments(Uint8Array.from([0xff]))).toThrow('LIBRARY_ENCODING');
    expect(()=>textSegments(Buffer.from('a\0b'))).toThrow('LIBRARY_TYPE');
    expect(()=>textSegments(Buffer.from('a'.repeat(65_537)))).toThrow('LIBRARY_LINE_LIMIT');
    expect(()=>textSegments(new Uint8Array(10_000_001))).toThrow('LIBRARY_TEXT_LIMIT');
  });
  it('splits on byte boundaries without losing multibyte characters or markup', () => {
    const text='# 标题\r\n\n'+ '中文🪴'.repeat(4000)+'\n<script>data only</script>';
    const segments=textSegments(Buffer.from(text));
    expect(segments.map(s=>s.body).join('')).toBe(text);
    expect(segments.every(s=>Buffer.byteLength(s.body)<=8192)).toBe(true);
    expect(segments.at(-1)?.body).toContain('<script>data only</script>');
  });
  it('never accepts a caller-controlled external or other bucket path', () => {
    expect(canonicalPath('https://example.test/file')).toBe(false);
    expect(canonicalPath('../other')).toBe(false);
    expect(canonicalPath('11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/original')).toBe(true);
  });
});
