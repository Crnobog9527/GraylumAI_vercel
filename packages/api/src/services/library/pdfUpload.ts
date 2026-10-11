/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { LibraryStorage } from './storage';
import { extractedUpload } from './extractedUpload';
import { PDF_MIME, pdfBeginInput, pdfCompleteInput, pdfFilename, pdfContent } from './pdfContent';

export function pdfUpload(client: SupabaseClient, actorId: string, storage: LibraryStorage) {
  const upload = extractedUpload(client, actorId, storage, {
    format: 'pdf', mime: PDF_MIME, magic: Buffer.from('%PDF-'),
  });
  return {
    beginPdf(raw: z.infer<typeof pdfBeginInput>) {
      const input = pdfBeginInput.parse(raw);
      pdfFilename(input.filename);
      return upload.begin(input);
    },
    beginPdfText: upload.beginText,
    completePdf(raw: z.infer<typeof pdfCompleteInput>) {
      const input = pdfCompleteInput.parse(raw);
      return upload.complete(input.documentId, bytes => ({ rpc: 'library_pdf_publish', args: pdfContent(bytes, input.pages) }));
    },
  };
}
