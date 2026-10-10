/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** Stable codes returned by the sandbox and the format extractors. Never raw library messages. */
export const SANDBOX_ERROR_CODES = [
  'FEATURE_DISABLED',
  'SANDBOX_UNAVAILABLE',
  'SANDBOX_TIMEOUT',
  'SANDBOX_NAVIGATED',
  'SANDBOX_PROTOCOL',
  'WORKER_FAILED',
  'INPUT_EMPTY',
  'INPUT_TOO_LARGE',
  'ZIP_INVALID',
  'ZIP_UNSUPPORTED',
  'ZIP_ENCRYPTED',
  'ZIP_SYMLINK',
  'ZIP_PATH',
  'ZIP_DUPLICATE',
  'ZIP_ENTRY_COUNT',
  'ZIP_ENTRY_SIZE',
  'ZIP_TOTAL_SIZE',
  'ZIP_RATIO',
  'ZIP_SIZE_MISMATCH',
  'ZIP_CRC',
  'ZIP_OVERLAP',
  'DOCX_NESTED_ARCHIVE',
  'DOCX_MACRO',
  'DOCX_INVALID',
  'XML_DTD',
  'XML_DEPTH',
  'XML_TOKEN',
  'XML_ENCODING',
  'XML_MALFORMED',
  'TEXT_TOO_LARGE',
] as const;

export type SandboxErrorCode = (typeof SANDBOX_ERROR_CODES)[number];

const CODES = new Set<string>(SANDBOX_ERROR_CODES);

export function isSandboxErrorCode(value: unknown): value is SandboxErrorCode {
  return typeof value === 'string' && CODES.has(value);
}

export class SandboxError extends Error {
  constructor(readonly code: SandboxErrorCode) {
    super(code);
    this.name = 'SandboxError';
  }
}

/** Any thrown value becomes a stable code; unknown failures never leak their message. */
export function toSandboxErrorCode(error: unknown, fallback: SandboxErrorCode): SandboxErrorCode {
  return error instanceof SandboxError ? error.code : fallback;
}

const TOO_LARGE = '文件太大或内容太多，超出了可以处理的上限，请拆分后再上传。';
const UNSUPPORTED = '这个 Word 文件含有不支持的内容（加密、宏或嵌入的压缩文件），请另存为普通 Word 文档后再上传。';
const DAMAGED = '这个 Word 文件无法读取，可能已损坏或不是真正的 .docx 文件。';

const USER_MESSAGES: Partial<Record<SandboxErrorCode, string>> = {
  FEATURE_DISABLED: 'Word 文字提取暂未开放。',
  SANDBOX_UNAVAILABLE: '当前浏览器无法安全地读取这个文件，请换用最新版 Chrome、Edge 或 Safari。',
  SANDBOX_TIMEOUT: '读取这个文件用时太长，已停止。请拆分后再上传。',
  INPUT_EMPTY: '文件是空的。',
  INPUT_TOO_LARGE: TOO_LARGE,
  ZIP_ENTRY_COUNT: TOO_LARGE,
  ZIP_ENTRY_SIZE: TOO_LARGE,
  ZIP_TOTAL_SIZE: TOO_LARGE,
  ZIP_RATIO: TOO_LARGE,
  TEXT_TOO_LARGE: TOO_LARGE,
  XML_DEPTH: TOO_LARGE,
  XML_TOKEN: TOO_LARGE,
  ZIP_ENCRYPTED: UNSUPPORTED,
  DOCX_MACRO: UNSUPPORTED,
  DOCX_NESTED_ARCHIVE: UNSUPPORTED,
  XML_DTD: UNSUPPORTED,
};

/** Plain-language message for the library page (LIB-3); limits are reported, never silently cut. */
export function sandboxErrorMessage(code: SandboxErrorCode): string {
  return USER_MESSAGES[code] ?? DAMAGED;
}
