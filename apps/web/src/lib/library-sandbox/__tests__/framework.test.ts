/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractDocxInBrowser } from '../docx/client';
import { validateDocxExtraction } from '../docx/result';
import { SANDBOX_ERROR_CODES, SandboxError, sandboxErrorMessage, toSandboxErrorCode } from '../errors';
import { isLibraryDocxExtractionEnabled } from '../feature-flag';
import { buildSandboxSrcdoc, RELAY_SCRIPT, SANDBOX_FRAME_ATTRIBUTES, sandboxCsp, scriptHashSource } from '../frame-document';
import { MESSAGE, parseFrameMessage, parseWorkerReply } from '../protocol';
import { runSandboxedWorker } from '../sandbox-host';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('feature flag', () => {
  it('is off unless the build sets it to exactly "true"', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION', '');
    expect(isLibraryDocxExtractionEnabled()).toBe(false);
    await expect(extractDocxInBrowser(new Blob(['x']))).rejects.toMatchObject({ code: 'FEATURE_DISABLED' });
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION', '1');
    expect(isLibraryDocxExtractionEnabled()).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION', 'true');
    expect(isLibraryDocxExtractionEnabled()).toBe(true);
  });

  it('checks size before loading anything', async () => {
    vi.stubEnv('NEXT_PUBLIC_LIBRARY_DOCX_EXTRACTION', 'true');
    await expect(extractDocxInBrowser(new Blob([]))).rejects.toMatchObject({ code: 'INPUT_EMPTY' });
    await expect(extractDocxInBrowser(new Blob([new Uint8Array(10_000_001)]))).rejects.toMatchObject({ code: 'INPUT_TOO_LARGE' });
  });
});

describe('sandbox frame document', () => {
  it('denies everything except the hash-pinned relay and blob workers', async () => {
    const hash = await scriptHashSource(RELAY_SCRIPT);
    expect(hash).toBe(`sha256-${createHash('sha256').update(RELAY_SCRIPT).digest('base64')}`);
    const csp = sandboxCsp(hash);
    for (const directive of ["default-src 'none'", "connect-src 'none'", "img-src 'none'", "form-action 'none'",
      "frame-src 'none'", "object-src 'none'", "base-uri 'none'", 'worker-src blob:', `script-src '${hash}'`]) {
      expect(csp).toContain(directive);
    }
    expect(csp).not.toMatch(/unsafe|https?:|\*/);
    expect(SANDBOX_FRAME_ATTRIBUTES.sandbox).toBe('allow-scripts');
  });

  it('puts the CSP before the only script and escapes the token', () => {
    const html = buildSandboxSrcdoc('a"b<c', 'sha256-x');
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'));
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('content="a&quot;b&lt;c"');
    expect(RELAY_SCRIPT).not.toMatch(/<\/script/i);
  });

  it('refuses to run outside a browser', async () => {
    await expect(runSandboxedWorker({ workerSource: '', input: new ArrayBuffer(1), timeoutMs: 1 }))
      .rejects.toMatchObject({ code: 'SANDBOX_UNAVAILABLE' });
  });
});

describe('protocol', () => {
  it('accepts only this run\'s messages with known shapes', () => {
    expect(parseFrameMessage({ type: MESSAGE.ready, token: 't' }, 't')).toEqual({ type: MESSAGE.ready });
    expect(parseFrameMessage({ type: MESSAGE.ready, token: 'other' }, 't')).toBeNull();
    expect(parseFrameMessage({ type: MESSAGE.result, token: 't' }, 't')).toBeNull();
    expect(parseFrameMessage({ type: MESSAGE.result, token: 't', data: 1 }, 't')).toEqual({ type: MESSAGE.result, data: 1 });
    expect(parseFrameMessage({ type: 'eval', token: 't' }, 't')).toBeNull();
    expect(parseFrameMessage(['t'], 't')).toBeNull();
    expect(parseWorkerReply({ ok: true, value: 0 })).toEqual({ ok: true, value: 0 });
    expect(parseWorkerReply({ ok: false, code: 'ZIP_CRC' })).toEqual({ ok: false, code: 'ZIP_CRC' });
    expect(parseWorkerReply({ ok: false, code: 'rm -rf' })).toBeNull();
    expect(parseWorkerReply({ ok: 'true', value: 1 })).toBeNull();
  });

  it('maps every failure to a stable code and a plain-language message', () => {
    expect(toSandboxErrorCode(new SandboxError('ZIP_RATIO'), 'WORKER_FAILED')).toBe('ZIP_RATIO');
    expect(toSandboxErrorCode(new Error('secret path /Users/x'), 'WORKER_FAILED')).toBe('WORKER_FAILED');
    for (const code of SANDBOX_ERROR_CODES) expect(sandboxErrorMessage(code)).toMatch(/[一-鿿]/);
  });
});

describe('docx result validation (reply from the sandbox is untrusted)', () => {
  const good = () => ({
    text: '标题\n正文', headings: [{ level: 1, text: '标题', offset: 0 }],
    images: [{ index: 0, contentType: 'image/png', bytes: new ArrayBuffer(3), offset: 3 }], imageCount: 2, warnings: ['IMAGE_LIMIT'],
  });

  it('copies a valid reply field by field', () => {
    const value = { ...good(), extra: 'dropped' };
    const result = validateDocxExtraction(value);
    expect(result).toEqual(good());
    expect(result).not.toHaveProperty('extra');
  });

  it.each([
    ['text not a string', { text: 1 }],
    ['heading level 0', { headings: [{ level: 0, text: 'x', offset: 0 }] }],
    ['heading offset beyond text', { headings: [{ level: 1, text: 'x', offset: 99 }] }],
    ['image index out of order', { images: [{ index: 1, contentType: 'image/png', bytes: new ArrayBuffer(1), offset: 0 }] }],
    ['image bytes not an ArrayBuffer', { images: [{ index: 0, contentType: 'image/png', bytes: 'AAAA', offset: 0 }] }],
    ['script content type', { images: [{ index: 0, contentType: 'text/html<script>', bytes: new ArrayBuffer(1), offset: 0 }] }],
    ['image count below images', { imageCount: 0 }],
    ['unknown warning', { warnings: ['HACKED'] }],
    ['too many images', { images: Array.from({ length: 51 }, (_, index) =>
      ({ index, contentType: 'image/png', bytes: new ArrayBuffer(1), offset: 0 })), imageCount: 51 }],
  ])('rejects %s', (_name, patch) => {
    expect(() => validateDocxExtraction({ ...good(), ...patch })).toThrow(SandboxError);
  });
});
