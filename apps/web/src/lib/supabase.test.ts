import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@supabase/ssr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/ssr')>()),
  createBrowserClient: vi.fn(() => ({})),
}));

// The parser the browser client uses for document.cookie; with duplicate names it keeps the first.
async function readCookie(header: string, name: string) {
  const { parseCookieHeader } = await vi.importActual<typeof import('@supabase/ssr')>('@supabase/ssr');
  return parseCookieHeader(header).find(cookie => cookie.name === name)?.value;
}

const VERIFIER = 'sb-stagingref-auth-token-code-verifier';

// Minimal browser cookie jar: a host-only cookie and a .graylum.com cookie with the same name are
// separate entries, and document.cookie lists older entries first, as browsers do for equal paths.
function installCookieJar(hostname: string) {
  let created = 0;
  const jar: { name: string; value: string; domain: string | null; created: number }[] = [];
  const document = {
    get cookie() {
      return [...jar].sort((a, b) => a.created - b.created).map(c => `${c.name}=${c.value}`).join('; ');
    },
    set cookie(line: string) {
      const [pair, ...attributes] = line.split(';').map(part => part.trim());
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      const domainAttribute = attributes.find(a => a.toLowerCase().startsWith('domain='));
      const domain = domainAttribute ? domainAttribute.slice('domain='.length) : null;
      const index = jar.findIndex(c => c.name === name && c.domain === domain);
      if (index >= 0) jar.splice(index, 1);
      if (!attributes.some(a => a.toLowerCase() === 'max-age=0')) jar.push({ name, value, domain, created: created++ });
    },
  };
  vi.stubGlobal('document', document);
  vi.stubGlobal('window', { location: { hostname, origin: `https://${hostname}` } });
  return { document, jar };
}

describe('legacy parent-domain session cookies on graylum.com hosts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://stagingref.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('removes a stale .graylum.com code verifier that the browser would otherwise read first', async () => {
    const { document, jar } = installCookieJar('auth-staging.graylum.com');
    document.cookie = `${VERIFIER}=OLD_PARENT; Domain=.graylum.com; Path=/`;
    document.cookie = `${VERIFIER}=NEW_HOST; Path=/`;
    document.cookie = 'sb-prodref-auth-token=PROD; Domain=.graylum.com; Path=/';
    // Duplicate names: the browser client keeps the first one, i.e. the stale parent copy.
    expect(await readCookie(document.cookie, VERIFIER)).toBe('OLD_PARENT');

    const { createClient } = await import('./supabase');
    createClient();

    expect(await readCookie(document.cookie, VERIFIER)).toBe('NEW_HOST');
    expect(jar.map(c => `${c.name}@${c.domain ?? 'host'}`)).toEqual([
      `${VERIFIER}@host`,
      'sb-prodref-auth-token@.graylum.com',
    ]);
  });

  it('clears the old copy before a new flow writes its verifier', async () => {
    const { document } = installCookieJar('auth-staging.graylum.com');
    document.cookie = `${VERIFIER}=OLD_PARENT; Domain=.graylum.com; Path=/`;

    const { createClient } = await import('./supabase');
    createClient();
    document.cookie = `${VERIFIER}=NEW_FLOW; Path=/`;

    expect(await readCookie(document.cookie, VERIFIER)).toBe('NEW_FLOW');
  });

  // E1: production moved to host-only cookies on www, so its old shared copies are expired the same way; nothing is
  // left for the browser to read first.
  it.each(['www.graylum.com', 'app.graylum.com'])('expires the old .graylum.com copies on %s too', async host => {
    const { document, jar } = installCookieJar(host);
    document.cookie = `${VERIFIER}=SHARED; Domain=.graylum.com; Path=/`;
    document.cookie = `${VERIFIER}=HOST; Path=/`;

    const { createClient } = await import('./supabase');
    createClient();

    expect(await readCookie(document.cookie, VERIFIER)).toBe('HOST');
    expect(jar.map(c => `${c.name}@${c.domain ?? 'host'}`)).toEqual([`${VERIFIER}@host`]);
  });

  it.each(['www.graylum.com', 'app.graylum.com'])('keeps a visitor signed in whose only session was shared, on %s', async host => {
    const { document, jar } = installCookieJar(host);
    const token = 'sb-stagingref-auth-token.0';
    document.cookie = `${token}=base64-SESSION=PART; Domain=.graylum.com; Path=/`;
    document.cookie = 'sb-otherref-auth-token=OTHER; Domain=.graylum.com; Path=/';

    const { createClient } = await import('./supabase');
    createClient();

    // The value moves to a host-only cookie unchanged (including "=" inside it); other projects' cookies stay.
    expect(await readCookie(document.cookie, token)).toBe('base64-SESSION=PART');
    expect(jar.map(c => `${c.name}@${c.domain ?? 'host'}`).sort()).toEqual([
      'sb-otherref-auth-token@.graylum.com',
      `${token}@host`,
    ]);
  });

  it('leaves cookies alone on a host outside graylum.com', async () => {
    const { document } = installCookieJar('example-alias.vercel.app');
    document.cookie = `${VERIFIER}=HOST; Path=/`;

    const { createClient } = await import('./supabase');
    createClient();

    expect(await readCookie(document.cookie, VERIFIER)).toBe('HOST');
  });
});
