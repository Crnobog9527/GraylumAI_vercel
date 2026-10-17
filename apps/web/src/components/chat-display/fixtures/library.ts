/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { LibraryDocument } from '@/hooks/use-library-documents';
import type { UploadItem } from '@/hooks/use-library-uploads';

/**
 * Sample data for the library page display components (`@/components/library/my-documents-view`:
 * `DocumentList`, `UploadPanel`, `SpacePanel`), shared by the landing page and the component tests.
 * One document per existing status. Made-up example content only.
 */

const base = { kind: 'document', format: 'md', purpose: 'authored', original_bytes: 48_000, text_bytes: 12_000, content_version: 1 } as const;

export const SAMPLE_LIBRARY_DOCUMENTS: LibraryDocument[] = [
  { ...base, id: 'sample-doc-1', format: 'pdf', purpose: 'reference', filename: '品牌介绍.pdf', status: 'ready', created_at: '2026-10-12T12:00:00Z' },
  { ...base, id: 'sample-doc-2', filename: '去年爆款笔记.md', status: 'ready', created_at: '2026-10-11T12:00:00Z' },
  { ...base, id: 'sample-doc-3', format: 'docx', filename: '客户常见问题.docx', status: 'processing', created_at: '2026-10-10T12:00:00Z' },
  { ...base, id: 'sample-doc-4', kind: 'image', format: 'png', purpose: 'reference', filename: '店铺门头.png', status: 'ready',
    created_at: '2026-10-09T12:00:00Z' },
  { ...base, id: 'sample-doc-5', filename: '旧版价目表.md', status: 'failed', created_at: '2026-10-08T12:00:00Z' },
];

export const SAMPLE_LIBRARY_SPACE = { usedBytes: 18_400_000, capacityBytes: 500_000_000 };

/** Upload queue rows: one being read in the browser, one transferring. */
export const SAMPLE_LIBRARY_UPLOADS: UploadItem[] = [
  { key: 'sample-upload-1', filename: '新品介绍.pdf', purpose: 'reference', status: 'extract', progress: 0 },
  { key: 'sample-upload-2', filename: '我的文章合集.md', purpose: 'authored', status: 'transfer', progress: 0.42 },
];
