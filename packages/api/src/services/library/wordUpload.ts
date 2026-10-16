/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { LibraryStorage } from './storage';
import { extractedUpload } from './extractedUpload';
import { WORD_MIME, wordBeginInput, wordCompleteInput, wordFilename, wordSegments, wordSegmentsWithImages } from './wordContent';

export function wordUpload(client: SupabaseClient, actorId: string, storage: LibraryStorage) {
  const upload = extractedUpload(client, actorId, storage, {
    format: 'docx', mime: WORD_MIME, magic: Buffer.from([80, 75, 3, 4]),
  });
  return {
    beginWord(raw: z.infer<typeof wordBeginInput>) {
      const input = wordBeginInput.parse(raw);
      wordFilename(input.filename);
      return upload.begin(input);
    },
    beginWordText: upload.beginText,
    completeWord(raw: z.infer<typeof wordCompleteInput>) {
      const input = wordCompleteInput.parse(raw);
      return upload.complete(input.documentId, bytes => {
        if (input.images === undefined) return { rpc: 'library_word_publish', args: { segments: wordSegments(bytes, input.headings) } };
        // LIB-2d (0280): segments also end at each image, and the publisher creates one recognition unit per image.
        const { segments, anchors } = wordSegmentsWithImages(bytes, input.headings, input.images);
        return { rpc: 'library_word_publish', args: { segments, images: anchors } };
      });
    },
  };
}
