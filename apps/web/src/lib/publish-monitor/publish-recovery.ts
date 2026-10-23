/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PUBLISH-MONITOR PR-5: an uncertain publish (the answer to "submit" was lost) must survive a reload, or the next try
 * would use a new idempotency key and could post and charge twice. Only what the server needs to recognize the same
 * request is kept per topic: key, targets, caption and each file's identity (never a media link).
 */
export type StoredAttempt = { key: string; connectionIds: string[]; caption: string; maxHoldCredits: number;
  media: Array<{ sha256: string; size: number; mimeType: string; coverMs: number | null }> };
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const slot = (workItemId: string) => `publish-monitor-attempt:${workItemId}`;
const SHA = /^[0-9a-f]{64}$/;
const defaultStore = (): Store | null => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };

export function saveAttempt(workItemId: string, attempt: StoredAttempt, store: Store | null = defaultStore()): void {
  try { store?.setItem(slot(workItemId), JSON.stringify(attempt)); } catch { /* storage unavailable: memory still guards this tab */ }
}

export function clearAttempt(workItemId: string, store: Store | null = defaultStore()): void {
  try { store?.removeItem(slot(workItemId)); } catch { /* see above */ }
}

export function loadAttempt(workItemId: string, store: Store | null = defaultStore()): StoredAttempt | null {
  try {
    const raw = store?.getItem(slot(workItemId));
    if (!raw) return null;
    const value = JSON.parse(raw) as StoredAttempt;
    const valid = typeof value.key === 'string' && Array.isArray(value.connectionIds) && typeof value.caption === 'string'
      && Number.isInteger(value.maxHoldCredits) && Array.isArray(value.media) && value.media.every(m => SHA.test(m.sha256) && Number.isInteger(m.size)
        && typeof m.mimeType === 'string' && (m.coverMs === null || Number.isInteger(m.coverMs)));
    return valid ? value : null;
  } catch { return null; }
}

/** The files picked again must be the same files in the same order, with the same size and type (same fingerprint). */
export function sameFiles(stored: StoredAttempt, files: Array<{ sha256: string; size: number; mimeType: string }>): boolean {
  return files.length === stored.media.length && files.every((file, i) => file.sha256 === stored.media[i]!.sha256
    && file.size === stored.media[i]!.size && file.mimeType === stored.media[i]!.mimeType);
}
