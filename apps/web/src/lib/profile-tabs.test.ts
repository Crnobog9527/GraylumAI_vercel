/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isProfileTab, profileTabHref, withProfileTab } from './profile-tabs';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('profile tabs', () => {
  it('recognises only real tabs', () => {
    expect(isProfileTab('security')).toBe(true);
    expect(isProfileTab('settings')).toBe(false);
    expect(isProfileTab(null)).toBe(false);
  });

  it('builds links to a tab', () => {
    expect(profileTabHref('security')).toBe('/profile?tab=security');
    expect(profileTabHref('profile')).toBe('/profile');
  });

  it('switches tab while keeping other query parameters', () => {
    const href = 'https://x.test/profile?tab=subscription&checkout=success#top';
    expect(withProfileTab(href, 'security')).toBe('/profile?tab=security&checkout=success#top');
    expect(withProfileTab(href, 'profile')).toBe('/profile?checkout=success#top');
  });

  it('has no hard-coded /profile?tab= link pointing at a missing tab', () => {
    const srcDir = path.resolve(__dirname, '..');
    const bad: string[] = [];
    for (const file of sourceFiles(srcDir)) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\/profile\?tab=([a-z_-]+)/g)) {
        if (!isProfileTab(match[1])) bad.push(`${path.relative(srcDir, file)}: ${match[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
