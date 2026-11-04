// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LightFirstPaint } from '@/components/layout/LightFirstPaint';
import { isLightAppPath } from './light-app-paths';

describe('light first paint', () => {
  it.each([
    '/app', '/app/positioning', '/app/positioning/abc', '/app/positioning/abc/topics', '/app/positioning/abc/review/r1',
    '/app/runtime', '/app/library', '/app/publish-monitor', '/app/workbench/marketplace', '/app/workbench/search', '/app/runtime/',
  ])('%s is light', path => expect(isLightAppPath(path)).toBe(true));

  it.each([
    '/app/profile', '/app/marketplace', '/app/expert-consult', '/app/library/scan-check', '/app/publish-monitor/connect',
    '/app/publish-monitor/publish', '/app/workbench/agent-first-preview', '/login', '/', null,
  ])('%s keeps the dark body', path => expect(isLightAppPath(path)).toBe(false));

  it('the marker renders as server HTML and globals.css turns the body light for it, with no script', () => {
    expect(renderToStaticMarkup(<LightFirstPaint />)).toContain('data-first-paint="light"');
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    expect(css).toMatch(/body:has\(\[data-first-paint='light'\]\)\s*\{[^}]*background:\s*#f7f7f7/);
  });

  it('Provider renders the marker outside the mounted swap, so the server HTML has it', () => {
    const src = readFileSync(join(__dirname, '../trpc/provider.tsx'), 'utf8');
    expect(src).toMatch(/isLightAppPath\(pathname\)[^\n]*<LightFirstPaint \/>/);
    expect(src.indexOf('<LightFirstPaint />')).toBeLessThan(src.indexOf('<Fragment key={epoch}>'));
  });
});
