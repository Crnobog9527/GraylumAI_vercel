import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetUser = vi.hoisted(() => vi.fn());
const mockCookieSet = vi.hoisted(() => vi.fn());

vi.mock('@supabase/ssr', () => ({
  createServerClient: vi.fn(() => ({
    auth: {
      getUser: mockGetUser,
    },
  })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { value: false }, error: null }),
    })),
  })),
}));

vi.mock('@/lib/auth', () => ({
  isEmailVerified: vi.fn(() => true),
  sanitizeRedirectTarget: vi.fn((target: string | null) => target || '/profile'),
}));

vi.mock('@/lib/server-log', () => ({
  logServerError: vi.fn(),
}));

vi.mock('@/lib/site-config', () => ({
  resolveAuthAppUrl: vi.fn(() => 'https://app.graylum.com'),
  resolveSupabaseCookieOptions: vi.fn(() => ({})),
}));

const ORIGINAL_ENV = process.env;

function createNextUrl(url: string): URL & { clone: () => URL } {
  const nextUrl = new URL(url) as URL & { clone: () => URL };
  nextUrl.clone = () => createNextUrl(nextUrl.toString());
  return nextUrl;
}

function createProxyRequest(url: string, method = 'GET'): unknown {
  const nextUrl = createNextUrl(url);

  return {
    headers: new Headers({ host: nextUrl.host }),
    method,
    nextUrl,
    url: nextUrl.toString(),
    cookies: {
      getAll: vi.fn(() => []),
      set: mockCookieSet,
    },
  };
}

async function runProxy(url: string, method = 'GET') {
  const { proxy } = await import('../../../../../apps/web/src/proxy');
  return proxy(createProxyRequest(url, method) as Parameters<typeof proxy>[0]);
}

describe('web proxy monitoring tunnel routing', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
      NODE_ENV: 'test',
    };
    delete process.env.VERCEL_ENV;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null });
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('allows www POST /monitoring without redirecting to the app domain', async () => {
    const response = await runProxy('https://www.graylum.com/monitoring', 'POST');

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('allows app POST /monitoring without redirecting to login', async () => {
    const response = await runProxy('https://app.graylum.com/monitoring', 'POST');

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('treats nested monitoring tunnel paths as public telemetry paths', async () => {
    const response = await runProxy('https://app.graylum.com/monitoring/envelope', 'POST');

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });

  it('keeps marketplace and chat protected for unauthenticated app users', async () => {
    const marketplaceResponse = await runProxy('https://app.graylum.com/marketplace');
    const chatResponse = await runProxy('https://app.graylum.com/chat');

    expect(marketplaceResponse.status).toBe(307);
    expect(marketplaceResponse.headers.get('location')).toBe(
      'https://app.graylum.com/login?redirect=%2Fmarketplace',
    );
    expect(chatResponse.status).toBe(307);
    expect(chatResponse.headers.get('location')).toBe(
      'https://app.graylum.com/login?redirect=%2Fchat',
    );
  });

  it('keeps existing public and basic path routing unchanged', async () => {
    const rootResponse = await runProxy('https://www.graylum.com/');
    const termsResponse = await runProxy('https://www.graylum.com/terms');
    const privacyResponse = await runProxy('https://www.graylum.com/privacy');
    const appLoginResponse = await runProxy('https://app.graylum.com/login');
    const wwwLoginResponse = await runProxy('https://www.graylum.com/login');

    expect(rootResponse.headers.get('x-middleware-rewrite')).toBe(
      'https://www.graylum.com/landing',
    );
    expect(termsResponse.headers.get('location')).toBeNull();
    expect(privacyResponse.headers.get('location')).toBeNull();
    expect(appLoginResponse.headers.get('location')).toBeNull();
    expect(wwwLoginResponse.status).toBe(307);
    expect(wwwLoginResponse.headers.get('location')).toBe('https://app.graylum.com/login');
  });

  it('bypasses maintenance redirects for the monitoring tunnel', async () => {
    process.env.VERCEL_ENV = 'production';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const response = await runProxy('https://app.graylum.com/monitoring', 'POST');

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
  });
});
