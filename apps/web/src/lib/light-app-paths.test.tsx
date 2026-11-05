// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LightFirstPaint } from '@/components/layout/LightFirstPaint';
import { isLightAppPath, LIGHT_FIRST_PAINT_SCRIPT, syncLightFirstPaint } from './light-app-paths';

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

  it('the head script decides exactly as isLightAppPath for every path (it runs before the first paint, when the body may still be empty)', () => {
    const paths = ['/app', '/app/', '/app/positioning', '/app/positioning/abc', '/app/positioning/abc/topics', '/app/positioning/abc/review/r1',
      '/app/positioning/', '/app/runtime', '/app/runtime/', '/app/library', '/app/library/scan-check', '/app/library/scan-check/x',
      '/app/publish-monitor', '/app/publish-monitor/connect', '/app/publish-monitor/publish', '/app/workbench/marketplace',
      '/app/workbench/search', '/app/workbench/agent-first-preview', '/app/profile', '/app/marketplace', '/app/expert-consult',
      '/app/positioningx', '/login', '/', '/pricing'];
    for (const path of paths) {
      const marked: string[] = [];
      new Function('location', 'document', LIGHT_FIRST_PAINT_SCRIPT)({ pathname: path },
        { documentElement: { setAttribute: (name: string, value: string) => marked.push(`${name}=${value}`) } });
      expect(marked, path).toEqual(isLightAppPath(path) ? ['data-first-paint=light'] : []);
    }
  });

  it('RootDocument puts that script in the <head> and globals.css turns the body light for it', () => {
    const src = readFileSync(join(__dirname, '../components/layout/RootDocument.tsx'), 'utf8');
    expect(src).toMatch(/<head>[\s\S]*LIGHT_FIRST_PAINT_SCRIPT[\s\S]*<\/head>\s*<body/);
    expect(src).toContain('suppressHydrationWarning');
    const css = readFileSync(join(__dirname, '../app/globals.css'), 'utf8');
    expect(css).toMatch(/html\[data-first-paint='light'\] body[^{]*\{[^}]*background:\s*#f7f7f7/);
  });

  it('a client navigation moves the mark with the path: light to dark takes it off, dark to light puts it on', () => {
    const attrs = new Map<string, string>();
    const root = { setAttribute: (name: string, value: string) => { attrs.set(name, value); }, removeAttribute: (name: string) => { attrs.delete(name); } };
    const at = (path: string | null) => { syncLightFirstPaint(root, path); return attrs.get('data-first-paint') ?? null; };
    expect(at('/app/positioning/abc')).toBe('light');
    expect(at('/app/profile')).toBeNull();
    expect(at('/app/library')).toBe('light');
    expect(at('/app/library/scan-check')).toBeNull();
    expect(at('/app')).toBe('light');
    expect(at(null)).toBeNull();
    // The Provider calls it on every path change.
    const src = readFileSync(join(__dirname, '../trpc/provider.tsx'), 'utf8');
    expect(src).toMatch(/useEffect\(\(\) => \{ syncLightFirstPaint\(document\.documentElement[^}]*\}, \[pathname, signedInArea\]\)/);
  });
});
