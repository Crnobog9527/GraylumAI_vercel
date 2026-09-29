/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { unstable_getResponseFromNextConfig } from 'next/experimental/testing/server';
vi.mock('@sentry/nextjs', () => ({ withSentryConfig: (config: unknown) => config }));
import config from '../../../next.config';

describe('legacy chat redirect before page/authentication', () => {
  it.each(['/chat', '/chat?conversation=old', '/chat?module=old', '/chat?mode=skill&conversation=old'])(
    'redirects %s to positioning with a reversible 307', async path => {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://graylum.test${path}`, nextConfig: config,
      });
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get('location')!).pathname).toBe('/positioning');
    },
  );
});
