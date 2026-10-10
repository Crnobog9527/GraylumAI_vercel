/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isLibraryDocxExtractionEnabled } from '@/lib/library-sandbox/feature-flag';

/** Same limits as the LIB-2a backend (packages/api/src/services/library/content.ts). */
export const LIBRARY_MAX_BYTES = 10_000_000;
/** The backend reserves a full 10 MB before issuing an upload link, so less free space blocks uploads. */
export const LIBRARY_UPLOAD_HEADROOM = 10_000_000;
/** Word reserves both of its paths up front (original + extracted text), 10 MB each. */
export const LIBRARY_WORD_HEADROOM = 20_000_000;

export type LibraryPurpose = 'authored' | 'reference';
export const PURPOSE_LABEL: Record<LibraryPurpose, string> = { authored: '我本人写的', reference: '参考资料' };

export const WORD_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export type UploadContentType = 'text/plain' | 'text/markdown' | 'image/jpeg' | 'image/png' | 'image/webp' | typeof WORD_MIME;

/** Formats the backend accepts today. The content type comes from the extension, never from the browser. */
const READY_FORMATS: Record<string, UploadContentType> = {
  txt: 'text/plain', md: 'text/markdown', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

/**
 * Word uses the two-object upload from #796 (original + browser-extracted UTF-8 text + headings), so it
 * opens only with the LIB-2b extraction build flag. PDF stays closed until the server has a PDF upload API.
 */
export function isWordUploadReady(): boolean {
  return isLibraryDocxExtractionEnabled();
}
export function libraryAccept(): string {
  return [...Object.keys(READY_FORMATS), ...(isWordUploadReady() ? ['docx'] : [])].map((extension) => '.' + extension).join(',');
}

export type FileCheck =
  | { ok: true; contentType: UploadContentType }
  | { ok: false; message: string };

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** `freeBytes`, when known, is capacity minus used space; Word needs more of it than other formats. */
export function checkLibraryFile(file: { name: string; size: number }, freeBytes?: number): FileCheck {
  const extension = extensionOf(file.name);
  if (extension === 'docx' && !isWordUploadReady()) return { ok: false, message: 'Word 文件暂时还不能上传，即将开放。' };
  if (extension === 'pdf') return { ok: false, message: 'PDF 暂时还不能上传，即将开放。' };
  if (extension === 'heic' || extension === 'heif') return { ok: false, message: '不支持 HEIC 图片，请导出为 JPG 后再上传。' };
  const contentType = extension === 'docx' ? WORD_MIME : READY_FORMATS[extension];
  if (!contentType) return { ok: false, message: '不支持这种文件。目前可以上传' + supportedText() + '。' };
  if (file.size <= 0) return { ok: false, message: '文件是空的。' };
  if (file.size > LIBRARY_MAX_BYTES) return { ok: false, message: '单个文件不能超过 10 MB，请拆分后再上传。' };
  if (file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) {
    return { ok: false, message: '文件名太长或含有不能使用的字符，请改名后再上传。' };
  }
  if (contentType === WORD_MIME && freeBytes !== undefined && freeBytes < LIBRARY_WORD_HEADROOM) {
    return { ok: false, message: 'Word 文件上传时原文件和提取的文字各先占 10 MB，需要至少 20 MB 剩余空间。删除部分文件或升级会员后再试。' };
  }
  return { ok: true, contentType };
}

/** The formats line shown in the upload panel and in the unsupported-file message. */
export function supportedText(): string {
  return (isWordUploadReady() ? ' txt、md、Word（.docx）' : ' txt、md ') + '文本和 jpg、png、webp 图片';
}

/** Decimal units, matching how membership space is defined (1 MB = 1,000,000 bytes). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1_000_000_000) return trim(bytes / 1_000_000_000) + ' GB';
  if (bytes >= 1_000_000) return trim(bytes / 1_000_000) + ' MB';
  if (bytes >= 1_000) return trim(bytes / 1_000) + ' KB';
  return bytes + ' B';
}
function trim(value: number) {
  return value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10);
}

export type SpaceState = 'ok' | 'low' | 'over';
/** `over`: a downgrade/refund left more stored than the plan allows. View and delete still work. */
export function spaceState(usedBytes: number, capacityBytes: number): SpaceState {
  if (usedBytes > capacityBytes) return 'over';
  if (capacityBytes - usedBytes < LIBRARY_UPLOAD_HEADROOM) return 'low';
  return 'ok';
}

const MESSAGES: Record<string, string> = {
  LIBRARY_DISABLED: '上传暂未开放。',
  LIBRARY_SPACE: '剩余空间不足，暂时不能上传。删除一些文件或升级会员后再试。',
  LIBRARY_FILE_LIMIT: '文件数量已达到系统上限，请删除一些文件后再上传。',
  LIBRARY_INFLIGHT_LIMIT: '同时上传的文件太多，请等前面的文件完成后再试。',
  LIBRARY_TYPE: '文件内容和扩展名不一致，或不是支持的格式，已拒绝。',
  LIBRARY_SIZE: '文件大小不符合要求（单个文件不超过 10 MB），已拒绝。',
  LIBRARY_ENCODING: '文本文件需要是 UTF-8 编码，请另存为 UTF-8 后再上传。',
  LIBRARY_LINE_LIMIT: '文本里有一行太长，无法处理，请分行后再上传。',
  LIBRARY_TEXT_LIMIT: '文字内容太多，超出了可以处理的上限，请拆分后再上传。',
  LIBRARY_INVALID: '文件信息不符合要求，请检查后重试。',
  LIBRARY_NOT_FOUND: '这个文件已不可用（可能已删除或还没处理完）。',
  LIBRARY_VERSION_CHANGED: '文件内容已更新，请重新打开。',
  LIBRARY_ACCOUNT_CLOSED: '账号当前不可用，不能使用资料库。',
  LIBRARY_FORBIDDEN: '没有权限访问这个文件。',
  LIBRARY_HEADINGS: 'Word 文件的标题结构无法识别，已拒绝。请另存为普通 Word 文档后再上传。',
  LIBRARY_UPLOAD_INCOMPLETE: '文件还没有传完整，请重试。',
  LIBRARY_UPLOAD_UNAVAILABLE: '暂时无法上传，请稍后重试。',
  LIBRARY_UPLOAD_EXPIRED: '上传准备超时，请重试。',
  LIBRARY_INVALID_CURSOR: '列表已经变化，请刷新后再加载。',
};
const FALLBACK = '暂时无法完成，请稍后重试。';

/** The backend's stable LIBRARY_* code, if this error carries one. Raw messages are never shown. */
export function libraryErrorCode(error: unknown): string | null {
  const message = error && typeof error === 'object' && 'message' in error ? (error as { message: unknown }).message : null;
  return typeof message === 'string' && /^LIBRARY_[A-Z_]+$/.test(message) ? message : null;
}
export function libraryErrorMessage(error: unknown): string {
  const code = libraryErrorCode(error);
  if (code) return MESSAGES[code] ?? FALLBACK;
  const trpcCode = (error as { data?: { code?: unknown } } | null)?.data?.code;
  if (trpcCode === 'TOO_MANY_REQUESTS') return '操作太频繁，请稍后再试。';
  return FALLBACK;
}
