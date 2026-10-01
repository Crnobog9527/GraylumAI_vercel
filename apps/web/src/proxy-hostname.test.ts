import { describe, expect, it } from 'vitest';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import {
  config,
  isDevEnvironment,
  isLocalhost,
  isPublicSiteDomain,
  isPreviewDeployment,
  normalizeHostname,
  requiresAppAuth,
} from './proxy';

describe('proxy hostname classification', () => {
  const cases = [
    {
      hostname: 'app.graylum.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'www.graylum.com',
      appAuth: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: true,
    },
    {
      hostname: 'graylumai-staging.vercel.app',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: true,
      publicSite: false,
    },
    {
      hostname: 'app.evil.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'localhost',
      appAuth: false,
      localhost: true,
      dev: true,
      preview: false,
      publicSite: false,
    },
    {
      hostname: '127.0.0.1',
      appAuth: false,
      localhost: true,
      dev: true,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'localhost.evil.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'my-localhost.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'foo.github.dev',
      appAuth: false,
      localhost: false,
      dev: true,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'github.dev.evil.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'app.graylum.com.',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'www.graylum.com.',
      appAuth: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: true,
    },
    {
      hostname: 'localhost.',
      appAuth: false,
      localhost: true,
      dev: true,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'app.graylum.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'app.evil.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'www.evil.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'www.graylum.com',
      appAuth: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: true,
    },
    {
      hostname: 'graylum.com',
      appAuth: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: true,
    },
    {
      hostname: 'localhost.evil.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'github.dev.evil.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'auth-staging.graylum.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'evilgraylum.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'shop.www.graylum.com',
      appAuth: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
  ] as const;

  it.each(cases)('$hostname has the expected classification', ({
    hostname,
    appAuth,
    localhost,
    dev,
    preview,
    publicSite,
  }) => {
    const normalizedHostname = normalizeHostname(hostname);

    expect(requiresAppAuth(normalizedHostname)).toBe(appAuth);
    expect(isLocalhost(normalizedHostname)).toBe(localhost);
    expect(isDevEnvironment(normalizedHostname)).toBe(dev);
    expect(isPreviewDeployment(normalizedHostname)).toBe(preview);
    expect(isPublicSiteDomain(normalizedHostname)).toBe(publicSite);
  });
});


describe('public font resources', () => {
  it('bypasses auth only for the public MiSans resource directory', () => {
    for (const url of ['/fonts/misans/abc.woff2', '/fonts/misans/misans-abc.css', '/fonts/misans/LICENSE.pdf']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(false);
    }
    for (const url of ['/positioning', '/profile', '/admin', '/fonts/private.woff2', '/fonts/misans-private/secret']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });
});


describe('public crawler resources', () => {
  it('serves robots directly on every host without bypassing neighboring paths', () => {
    for (const host of ['app.graylum.com', 'www.graylum.com', 'preview.vercel.app', 'localhost']) {
      for (const path of ['/robots.txt', '/robots.txt?crawler=1']) {
        expect(unstable_doesMiddlewareMatch({ config, url: `https://${host}${path}` })).toBe(false);
      }
    }
    for (const url of ['/robotsXtxt', '/robots.txt/private', '/robots.txt-backup', '/profile', '/admin']) {
      expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true);
    }
  });
});
