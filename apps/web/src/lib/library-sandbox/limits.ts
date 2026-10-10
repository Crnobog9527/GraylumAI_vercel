/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Limits for parsing untrusted library files in the browser sandbox (LIB-2b, LIB_DOCS_PLAN §4.1).
 * Values follow the #549 qualification and the plan; bytes are decimal (1 MB = 1,000,000 bytes).
 */
export const SANDBOX_LIMITS = {
  /** Single uploaded file (D6). */
  maxInputBytes: 10_000_000,
  /** Extracted UTF-8 text, never silently truncated. */
  maxTextBytes: 10_000_000,
  /** Wall-clock budget for one file; the worker is terminated when it runs out. */
  docxTimeoutMs: 30_000,
} as const;

export const ZIP_LIMITS = {
  maxEntries: 2_000,
  /** Declared and actual size of one inflated member. */
  maxEntryBytes: 20_000_000,
  /** Total actually inflated bytes across all members. */
  maxTotalBytes: 50_000_000,
  /** Declared uncompressed / compressed ratio, checked before inflating. */
  maxRatio: 100,
  /** Members smaller than this skip the ratio check (tiny parts compress oddly). */
  ratioCheckMinBytes: 65_536,
} as const;

export const XML_LIMITS = {
  maxDepth: 64,
  /** One markup token (a tag with its attributes, a comment, a processing instruction). */
  maxTokenChars: 65_536,
} as const;

/** Recognition units per file (LIB_DOCS_PLAN §4.1: Word images and PDF pages share the 50 cap). */
export const MAX_EMBEDDED_IMAGES = 50;
/** Bytes of all returned images together (the same media part may be referenced many times). */
export const MAX_IMAGE_BYTES_TOTAL = 50_000_000;
export const MAX_HEADINGS = 10_000;
export const MAX_HEADING_CHARS = 1_000;
export const MAX_WARNINGS = 50;
