import { describe, expect, it } from 'vitest';
import {
  isAppDomain,
  isDevEnvironment,
  isLocalhost,
  isPreviewDeployment,
} from './proxy';

describe('proxy hostname classification', () => {
  const cases = [
    {
      hostname: 'app.graylum.com',
      app: true,
      localhost: false,
      dev: false,
      preview: false,
    },
    {
      hostname: 'www.graylum.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
    },
    {
      hostname: 'graylumai-staging.vercel.app',
      app: false,
      localhost: false,
      dev: false,
      preview: true,
    },
    {
      hostname: 'app.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
    },
    {
      hostname: 'localhost',
      app: false,
      localhost: true,
      dev: true,
      preview: false,
    },
    {
      hostname: '127.0.0.1',
      app: false,
      localhost: true,
      dev: true,
      preview: false,
    },
    {
      hostname: 'localhost.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
    },
    {
      hostname: 'my-localhost.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
    },
    {
      hostname: 'foo.github.dev',
      app: false,
      localhost: false,
      dev: true,
      preview: false,
    },
    {
      hostname: 'github.dev.evil.com',
      app: false,
      localhost: false,
      dev: false,
      preview: false,
    },
  ] as const;

  it.each(cases)('$hostname has the expected classification', ({ hostname, app, localhost, dev, preview }) => {
    expect(isAppDomain(hostname)).toBe(app);
    expect(isLocalhost(hostname)).toBe(localhost);
    expect(isDevEnvironment(hostname)).toBe(dev);
    expect(isPreviewDeployment(hostname)).toBe(preview);
  });
});
