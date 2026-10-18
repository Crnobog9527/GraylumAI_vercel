/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/** Local only (see app/api/dev/owner-edits): the variable naming the file the Owner's edits are appended to. */
export const OWNER_EDITS_ENV = 'OWNER_EDITS_FILE';

export const ownerEditsSchema = z.object({
  page: z.string().max(200),
  edits: z.array(z.object({
    module: z.string().max(200),
    original: z.string().max(4000),
    edited: z.string().max(4000),
  })).min(1).max(300),
});
export type OwnerEdits = z.infer<typeof ownerEditsSchema>;

/** Where edits may be saved: only in a development server started with OWNER_EDITS_FILE set (a .jsonl path). */
export function ownerEditsTarget(env: { NODE_ENV?: string; [key: string]: string | undefined }): string | null {
  if (env.NODE_ENV !== 'development') return null;
  const file = env[OWNER_EDITS_ENV];
  return file && file.endsWith('.jsonl') ? file : null;
}
