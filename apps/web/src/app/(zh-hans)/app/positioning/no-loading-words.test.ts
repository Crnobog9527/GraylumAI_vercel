/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// UI-FINISH (Owner 2026-11-03): after sign-in, a refresh shows no "reading/loading" words or spinner for a page-level read, only grey
// placeholders (PageSkeleton). Progress words after a click ("正在建立定位草稿…") stay. These files had slipped through #1709/#1720.
const FILES = ['page.tsx', '[draftId]/page.tsx', '[draftId]/draft-archive-gate.tsx', '[draftId]/topics/page.tsx',
  '../../../../components/opc/profile-archive/profile-archive.ts'];

describe('positioning pages: no page-level loading words', () => {
  for (const file of FILES) {
    it(file, () => {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
      expect(source).not.toMatch(/正在(读取|加载|恢复定位)|读取中…|加载中/);
    });
  }
});
