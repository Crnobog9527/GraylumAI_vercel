/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { isUnauthorizedError } from '@/lib/auth-recovery';

/** The server's answer for a record that is missing or someone else's: asking again cannot change it. */
export function isMissingRecordError(error: unknown): boolean {
  const data = error && typeof error === 'object' && 'data' in error ? (error as { data?: unknown }).data : null;
  const code = data && typeof data === 'object' ? (data as { code?: unknown }).code : undefined;
  return code === 'NOT_FOUND' || code === 'FORBIDDEN';
}

/** The app's default (one retry, none for a missing login), and no retry for a missing or forbidden record. */
export function retryUnlessMissing(failureCount: number, error: unknown): boolean {
  return !isUnauthorizedError(error) && !isMissingRecordError(error) && failureCount < 1;
}
