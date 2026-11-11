/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Helpers shared by the admin router files (./admin*.ts).
import { z } from 'zod';
import { createSafeInternalError } from '../lib/publicError';
import { logger } from '../lib/logger';

export const adminDateStringSchema = z.string().refine(
  (value) => Number.isFinite(new Date(value).getTime()),
  'Invalid admin date',
);

export function createAdminOperationError(operation: string, cause: unknown) {
  return createSafeInternalError(cause, `${operation}失败，请稍后重试`);
}

export function assertValidAdminRows<T>(
  value: unknown,
  rowSchema: z.ZodType<T>,
  operation: string,
  source: string,
): asserts value is T[] {
  const result = z.array(rowSchema).safeParse(value);

  if (!result.success) {
    throw createAdminOperationError(
      operation,
      new Error(`Admin ${source} query returned invalid data`),
    );
  }
}

export function logAdminEndpointMetric(
  endpoint: string,
  startedAt: number,
  context: Record<string, unknown> = {},
) {
  if (process.env.NODE_ENV === 'test') {
    return;
  }

  logger.info('api', 'admin_endpoint_profile', {
    endpoint,
    durationMs: Date.now() - startedAt,
    ...context,
  });
}

/**
 * The one place the admin router files read system_settings rows directly. The two reads (finance, settings page) sat in one
 * file before the router was split; the pattern ratchet counts files that read the table, and that count may not grow.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- generic over the request's client; the caller keeps its own builder type.
export const systemSettingsTable = <T extends { from: (table: string) => any }>(db: T): ReturnType<T['from']> =>
  db.from('system_settings');
