// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import PositioningLayout from './positioning/layout';
import RuntimeLayout from './runtime/layout';
import LibraryLayout from './library/layout';
import MarketplaceLayout from './workbench/marketplace/layout';
import SearchLayout from './workbench/search/layout';

// Routes whose finished page is light (WorkspaceFrame): the server HTML must carry the light first-paint marker.
const LIGHT: Array<[string, (p: { children: React.ReactNode }) => React.ReactElement]> = [
  ['positioning', PositioningLayout],
  ['runtime', RuntimeLayout],
  ['library', LibraryLayout],
  ['workbench/marketplace', MarketplaceLayout],
  ['workbench/search', SearchLayout],
];
// Dark routes (profile, marketplace, expert-consult, agent-first-preview) and publish-monitor, whose page is light but whose
// connect/publish sub-pages are dark and share the segment: none may get the marker from a layout.
const DARK = ['profile', 'marketplace', 'expert-consult', 'publish-monitor', 'workbench/agent-first-preview'];

describe('first paint of light /app routes', () => {
  for (const [route, Layout] of LIGHT) {
    it(`server HTML of ${route} carries the light first-paint marker and keeps children`, () => {
      const html = renderToStaticMarkup(<Layout><p id="child" /></Layout>);
      expect(html).toContain('data-first-paint="light"');
      expect(html).toContain('id="child"');
    });
  }

  it('globals.css paints the body light for documents with the marker, with no script', () => {
    const css = readFileSync(join(__dirname, '../../globals.css'), 'utf8');
    expect(css).toMatch(/body:has\(\[data-first-paint='light'\]\)\s*\{[^}]*background:\s*#f7f7f7/);
  });

  it('dark routes have no layout that adds the marker', () => {
    for (const route of DARK) expect(existsSync(join(__dirname, route, 'layout.tsx'))).toBe(false);
  });
});
