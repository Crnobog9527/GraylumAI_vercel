import { describe, expect, it } from 'vitest';
import {
  isAppDomain,
  isDevEnvironment,
  isLocalhost,
  isPublicSiteDomain,
  isPreviewDeployment,
  normalizeHostname,
} from './proxy';

describe('proxy hostname classification', () => {
  const cases = [
    {
      hostname: 'app.graylum.com',
      app: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'www.graylum.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: true,
    },
    {
      hostname: 'graylumai-staging.vercel.app',
      app: false,
      localhost: false,
      dev: false,
      preview: true,
      publicSite: false,
    },
    {
      hostname: 'app.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'localhost',
      app: false,
      localhost: true,
      dev: true,
      preview: false,
      publicSite: false,
    },
    {
      hostname: '127.0.0.1',
      app: false,
      localhost: true,
      dev: true,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'localhost.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'my-localhost.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'foo.github.dev',
      app: false,
      localhost: false,
      dev: true,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'github.dev.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'app.graylum.com.',
      app: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'www.graylum.com.',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: true,
    },
    {
      hostname: 'localhost.',
      app: false,
      localhost: true,
      dev: true,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'app.graylum.com',
      app: true,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'app.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'www.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'www.graylum.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: true,
    },
    {
      hostname: 'graylum.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: true,
    },
    {
      hostname: 'localhost.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
    {
      hostname: 'github.dev.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
      publicSite: false,
    },
  ] as const;

  it.each(cases)('$hostname has the expected classification', ({
    hostname,
    app,
    localhost,
    dev,
    preview,
    publicSite,
  }) => {
    const normalizedHostname = normalizeHostname(hostname);

    expect(isAppDomain(normalizedHostname)).toBe(app);
    expect(isLocalhost(normalizedHostname)).toBe(localhost);
    expect(isDevEnvironment(normalizedHostname)).toBe(dev);
    expect(isPreviewDeployment(normalizedHostname)).toBe(preview);
    expect(isPublicSiteDomain(normalizedHostname)).toBe(publicSite);
  });
});
