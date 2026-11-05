/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
describe('legacy entry replacements', () => {
  it.each([
    ['components/admin/AdminSidebar.tsx', '/app'],
  ])('%s links to %s', (file, destination) => {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    expect(source).toContain(`href="${destination}"`);
    expect(source).not.toMatch(/['"`]\/chat(?:[?'"`])/);
  });
  it('admin guard returns to the logged-in home', () => {
    const source = readFileSync(new URL('../admin/AdminGuard.tsx', import.meta.url), 'utf8');
    expect(source).toContain("router.push('/app')");
    expect(source).not.toContain("router.push('/chat')");
  });
});
