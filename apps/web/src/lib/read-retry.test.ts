/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { isMissingRecordError, retryUnlessMissing } from './read-retry';

const trpcError = (code: string, httpStatus: number) => Object.assign(new Error(code), { data: { code, httpStatus } });

async function requests(error: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  let count = 0;
  await client.fetchQuery({ queryKey: ['read'], retry: retryUnlessMissing,
    queryFn: async () => { count += 1; throw error; } }).catch(() => undefined);
  return count;
}

describe('draft reads stop at a missing or forbidden record', () => {
  it('sends one request for NOT_FOUND and FORBIDDEN, and keeps the one retry for other failures', async () => {
    expect(await requests(trpcError('NOT_FOUND', 404))).toBe(1);
    expect(await requests(trpcError('FORBIDDEN', 403))).toBe(1);
    expect(await requests(trpcError('UNAUTHORIZED', 401))).toBe(1);
    expect(await requests(trpcError('INTERNAL_SERVER_ERROR', 500))).toBe(2);
    expect(await requests(new Error('network'))).toBe(2);
  });

  it('recognises only the tRPC codes, not message text', () => {
    expect(isMissingRecordError(trpcError('NOT_FOUND', 404))).toBe(true);
    expect(isMissingRecordError(new Error('NOT_FOUND'))).toBe(false);
    expect(isMissingRecordError(null)).toBe(false);
  });
});
