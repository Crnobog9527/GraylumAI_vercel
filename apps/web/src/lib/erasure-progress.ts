/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

export const ERASURE_PROGRESS_PATH = '/account-erasure';
const SESSION_KEY = 'graylum:erasure-progress';
// Navigation hold only, not an auth/session grant. It also works when sessionStorage is denied.
let handoffActive = false;
export const isErasureHandoffActive = () => handoffActive;
export function setErasureHandoffActive(active: boolean) { handoffActive = active; }
const credentialSchema = z.object({
  requestId: z.string().uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();
export type ProgressCredential = z.infer<typeof credentialSchema>;
export type ErasureHandoff = { credential: ProgressCredential | null; closed: boolean };

export function parseProgressCredential(text: string): ProgressCredential | null {
  const [requestId, token, extra] = text.trim().split('.');
  if (extra !== undefined) return null;
  const parsed = credentialSchema.safeParse({ requestId, token });
  return parsed.success ? parsed.data : null;
}

export function formatProgressCredential(credential: ProgressCredential): string {
  return `${credential.requestId}.${credential.token}`;
}

/** A convenience copy only, never authority for progress or expiry. */
export function saveErasureHandoff(handoff: ErasureHandoff): boolean {
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(handoff));
    return true;
  } catch { return false; }
}

export function readErasureHandoff(): ErasureHandoff | null {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? 'null');
    const parsed = z.object({ credential: credentialSchema.nullable(), closed: z.boolean() }).strict().safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

export function clearErasureHandoff(): boolean {
  try { window.sessionStorage.removeItem(SESSION_KEY); return true; } catch { return false; }
}

export function describeProgressError(error: unknown): string {
  const code = (error as { data?: { code?: string } } | null)?.data?.code;
  if (code === 'NOT_FOUND') return '凭证无效或已过期，无法查询进度。这不代表注销未发生，请勿再次申请注销。';
  if (code === 'TOO_MANY_REQUESTS') return '查询过于频繁，请稍后手动查询。';
  return '暂时无法查询进度，请保管好凭证，稍后手动查询。';
}
