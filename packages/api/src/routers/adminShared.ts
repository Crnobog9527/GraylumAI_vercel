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
