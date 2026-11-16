/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUser = vi.fn();
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser } }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('@/lib/rateLimit', () => ({ checkRateLimit: vi.fn(async () => ({ success: true })) }));
vi.mock('@/lib/server-log', () => ({ logServerError: vi.fn() }));
const { proxy } = await import('./proxy');

describe('home routing with the canonical redirect enabled', () => {
  it.each([null, { id: 'user-1', email: 'a@example.com', email_confirmed_at: '2026-10-01T00:00:00Z', app_metadata: {} }])(
    'serves the root without rewriting into the redirected /landing path for user %s', async user => {
      getUser.mockResolvedValue({ data: { user } });
      const response = await proxy(new NextRequest('https://auth-staging.graylum.com/?domain=www&_rsc=abc'));
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    },
  );
});
