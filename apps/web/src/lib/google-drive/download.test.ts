/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { DRIVE_MAX_BYTES, DRIVE_PICKER_MIME_TYPES, DriveError, downloadPicked, driveErrorMessage } from './download';

const ok = (body: string) => vi.fn(async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

describe('a picked Google Drive file as a library upload (VOICE-2 PR-7)', () => {
  it('exports a Google Doc as Word, with the token only in the request header', async () => {
    const fetcher = ok('docx-bytes');
    const file = await downloadPicked({ id: 'd/1', name: '我的笔记', mimeType: 'application/vnd.google-apps.document' }, 'TOKEN', fetcher);
    expect(file.name).toBe('我的笔记.docx');
    expect(file.type).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://www.googleapis.com/drive/v3/files/d%2F1/export?mimeType=application%2Fvnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(url).not.toContain('TOKEN');
    expect(init.headers).toEqual({ Authorization: 'Bearer TOKEN' });
  });
  it('downloads the library\'s own formats as they are', async () => {
    const fetcher = ok('hello');
    const md = await downloadPicked({ id: 'a', name: 'notes.md', mimeType: 'text/markdown' }, 'T', fetcher);
    expect([md.name, md.type, await md.text()]).toEqual(['notes.md', 'text/markdown', 'hello']);
    expect((fetcher as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toBe('https://www.googleapis.com/drive/v3/files/a?alt=media');
    const pdf = await downloadPicked({ id: 'b', name: 'plan', mimeType: 'application/pdf' }, 'T', ok('%PDF'));
    expect(pdf.name).toBe('plan.pdf');
    expect(DRIVE_PICKER_MIME_TYPES).toContain('application/vnd.google-apps.document');
  });
  it('refuses other formats and files over 10 MB, and says which file', async () => {
    await expect(downloadPicked({ id: 'c', name: '表格', mimeType: 'application/vnd.google-apps.spreadsheet' }, 'T', ok('x')))
      .rejects.toMatchObject({ code: 'DRIVE_UNSUPPORTED' });
    await expect(downloadPicked({ id: 'c', name: 'big.pdf', mimeType: 'application/pdf', sizeBytes: DRIVE_MAX_BYTES + 1 }, 'T', ok('x')))
      .rejects.toMatchObject({ code: 'DRIVE_TOO_LARGE' });
    const failing = vi.fn(async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(downloadPicked({ id: 'c', name: 'a.txt', mimeType: 'text/plain' }, 'T', failing)).rejects.toMatchObject({ code: 'DRIVE_DOWNLOAD_FAILED' });
    expect(driveErrorMessage(new DriveError('DRIVE_TOO_LARGE', 'big.pdf'))).toBe('「big.pdf」超过 10 MB，没有导入。');
  });
});
