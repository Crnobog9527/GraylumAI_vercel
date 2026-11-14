/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * VOICE-2 PR-7: a file the user picked in Google Drive becomes a browser File for the library's own upload. The download runs in the
 * browser with the one-time drive.file token (only the picked files are readable); the token is never sent to Graylum. Google Docs
 * are exported as Word; other files are downloaded as they are, only in the formats the library takes.
 */
export const DRIVE_MAX_BYTES = 10_000_000;
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TYPES: Record<string, string> = { 'text/plain': 'txt', 'text/markdown': 'md', [DOCX]: 'docx', 'application/pdf': 'pdf' };
/** What the picker offers: the library's text formats and Google Docs. */
export const DRIVE_PICKER_MIME_TYPES = [GOOGLE_DOC, ...Object.keys(TYPES)].join(',');

export type PickedFile = { id: string; name: string; mimeType: string; sizeBytes?: number };
export type DriveFailure = 'DRIVE_UNSUPPORTED' | 'DRIVE_TOO_LARGE' | 'DRIVE_DOWNLOAD_FAILED';
export class DriveError extends Error { constructor(readonly code: DriveFailure, readonly fileName: string) { super(code); } }

const withExtension = (name: string, extension: string) => name.toLowerCase().endsWith('.' + extension) ? name : `${name}.${extension}`;

export async function downloadPicked(file: PickedFile, token: string, fetcher: typeof fetch = fetch): Promise<File> {
  const doc = file.mimeType === GOOGLE_DOC;
  const extension = doc ? 'docx' : TYPES[file.mimeType] ?? (/\.md$/i.test(file.name) ? 'md' : /\.txt$/i.test(file.name) ? 'txt' : null);
  if (!extension) throw new DriveError('DRIVE_UNSUPPORTED', file.name);
  if ((file.sizeBytes ?? 0) > DRIVE_MAX_BYTES) throw new DriveError('DRIVE_TOO_LARGE', file.name);
  const id = encodeURIComponent(file.id);
  const url = doc ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(DOCX)}`
    : `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
  const response = await fetcher(url, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null);
  if (!response?.ok) throw new DriveError('DRIVE_DOWNLOAD_FAILED', file.name);
  const blob = await response.blob();
  if (blob.size > DRIVE_MAX_BYTES) throw new DriveError('DRIVE_TOO_LARGE', file.name);
  const type = doc ? DOCX : file.mimeType in TYPES ? file.mimeType : extension === 'md' ? 'text/markdown' : 'text/plain';
  return new File([blob], withExtension(file.name, extension), { type });
}

export function driveErrorMessage(error: unknown): string {
  if (!(error instanceof DriveError)) return '没能从 Google 云端硬盘取到文件，请稍后再试。';
  return { DRIVE_UNSUPPORTED: `「${error.fileName}」的格式暂不支持，只能选 Google 文档、Word、PDF、txt 或 md。`,
    DRIVE_TOO_LARGE: `「${error.fileName}」超过 10 MB，没有导入。`,
    DRIVE_DOWNLOAD_FAILED: `「${error.fileName}」下载失败，请稍后再试。` }[error.code];
}
