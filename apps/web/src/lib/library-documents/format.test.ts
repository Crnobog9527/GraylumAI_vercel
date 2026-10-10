/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkLibraryFile, formatBytes, libraryAccept, libraryErrorMessage, spaceState, WORD_MIME } from './format';

afterEach(() => vi.unstubAllEnvs());

describe('checkLibraryFile', () => {
  it('accepts the formats the backend supports, typed by extension', () => {
    expect(checkLibraryFile({ name: '笔记.md', size: 10 })).toEqual({ ok: true, contentType: 'text/markdown' });
    expect(checkLibraryFile({ name: 'a.TXT', size: 10 })).toEqual({ ok: true, contentType: 'text/plain' });
    expect(checkLibraryFile({ name: 'p.jpg', size: 10 })).toEqual({ ok: true, contentType: 'image/jpeg' });
    expect(checkLibraryFile({ name: 'p.webp', size: 10_000_000 })).toEqual({ ok: true, contentType: 'image/webp' });
  });
  it('keeps Word closed without the extraction flag, and PDF closed either way', () => {
    expect(checkLibraryFile({ name: 'a.docx', size: 10 })).toMatchObject({ ok: false, message: expect.stringContaining('Word') });
    expect(libraryAccept()).toBe('.txt,.md,.jpg,.jpeg,.png,.webp');
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION', 'true');
    expect(checkLibraryFile({ name: 'a.pdf', size: 10 })).toMatchObject({ ok: false, message: expect.stringContaining('PDF') });
  });
  it('opens Word with the extraction flag, typed as the Word MIME by extension', () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION', 'true');
    expect(checkLibraryFile({ name: '报告.DOCX', size: 10 })).toEqual({ ok: true, contentType: WORD_MIME });
    expect(checkLibraryFile({ name: 'big.docx', size: 10_000_001 })).toMatchObject({ ok: false, message: expect.stringContaining('10 MB') });
    expect(libraryAccept()).toContain('.docx');
    expect(checkLibraryFile({ name: 'x.svg', size: 1 })).toMatchObject({ message: expect.stringContaining('Word（.docx）') });
  });
  it.each([
    [{ name: 'x.svg', size: 1 }, '不支持'], [{ name: 'x.heic', size: 1 }, 'JPG'], [{ name: 'x.gif', size: 1 }, '不支持'],
    [{ name: 'x.txt', size: 0 }, '空'], [{ name: 'x.png', size: 10_000_001 }, '10 MB'],
    [{ name: 'a\u0001.txt', size: 1 }, '文件名'], [{ name: 'a'.repeat(260) + '.txt', size: 1 }, '文件名'],
  ])('rejects %o', (file, text) => {
    expect(checkLibraryFile(file)).toMatchObject({ ok: false, message: expect.stringContaining(text) });
  });
});

it('uses decimal units', () => {
  expect(formatBytes(50_000_000)).toBe('50 MB');
  expect(formatBytes(2_000_000_000)).toBe('2 GB');
  expect(formatBytes(1_500)).toBe('1.5 KB');
  expect(formatBytes(12)).toBe('12 B');
});

it('reports space: ok, low (< 10 MB free blocks upload), over (downgrade)', () => {
  expect(spaceState(0, 50_000_000)).toBe('ok');
  expect(spaceState(40_000_001, 50_000_000)).toBe('low');
  expect(spaceState(60_000_000, 50_000_000)).toBe('over');
});

it('maps only stable codes and never shows raw messages', () => {
  expect(libraryErrorMessage({ message: 'LIBRARY_SPACE' })).toContain('剩余空间不足');
  expect(libraryErrorMessage({ message: 'LIBRARY_DISABLED' })).toBe('上传暂未开放。');
  expect(libraryErrorMessage({ message: 'relation "x" does not exist' })).toBe('暂时无法完成，请稍后重试。');
  expect(libraryErrorMessage({ message: 'x', data: { code: 'TOO_MANY_REQUESTS' } })).toContain('频繁');
});
