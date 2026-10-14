import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/j/page';
import { HERO, HERO_H, VOICE_WALL } from '@/lib/landing/landing-copy';
import * as copyJ from '@/lib/landing/landing-copy-j';
import { J_ID_PLACEHOLDER, J_NOTE_HEADS, J_TAKEOVER, noteSource } from '@/lib/landing/landing-copy-j';
import { LANDING_FEATURES, type LandingFlags } from '@/lib/landing/landing-flags';
import { buildLandingPageData } from '@/lib/landing/landing-page-data';
import { APP_SEGMENTS } from '@/lib/sentry-scrub';
import { SampleJ } from './SampleJ';
import { chapterAt, CHAPTERS } from './TakeoverJ';

const ALL_ON = Object.fromEntries(Object.keys(LANDING_FEATURES).map(key => [key, true])) as LandingFlags;
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function render() {
  const data = buildLandingPageData(ALL_ON, []);
  return { data, html: renderToStaticMarkup(createElement(SampleJ, { data, siteName: 'Graylum', membershipHref: '/profile' })) };
}

describe('style sample J', () => {
  it('is never indexed, never listed in the sitemap, and its segment is known to the Sentry scrubber', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
    expect(APP_SEGMENTS.has('j')).toBe(true);
  });

  it('keeps the first screen to the final title, promise, button and note, with one H1', () => {
    const { html } = render();
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const hero = html.slice(html.indexOf('aria-labelledby="hero-title"'), html.indexOf('aria-labelledby="voice-title"'));
    for (const copy of [HERO.promise, HERO.primaryCta, HERO_H.ctaNote]) expect(hero).toContain(escape(copy));
    expect(hero.replace(/<[^>]+>/g, '')).toContain(HERO.title.replace(' 自', '自'));
    expect(hero).not.toContain(HERO.secondaryCta);
    // The Owner's edit mode exists only in a local development server, never in a build.
    expect(html).not.toContain('改字模式');
  });

  it('puts every voice-wall note, verbatim, beside a heading of its own and P7 first', () => {
    const { data, html } = render();
    const wall = html.slice(html.indexOf('aria-labelledby="voice-title"'), html.indexOf('id="how-it-works"'));
    for (const note of data.notes) {
      expect(wall).toContain(escape(note.quote));
      expect(J_NOTE_HEADS[note.id]).toBeTruthy();
      expect(wall).toContain(J_NOTE_HEADS[note.id]);
    }
    expect(wall.indexOf(escape(data.notes.find(note => note.id === 'p7')?.quote ?? '-'))).toBeLessThan(wall.indexOf(escape(data.notes[0].quote)));
    expect(wall).not.toMatch(/href="https?:/);
    expect(wall).not.toContain(VOICE_WALL.lede);
  });

  it('cites forum quotes as platform · user ID · date and news quotes as they were', () => {
    expect(noteSource('p7', 'Reddit r/socialmedia，2026-04')).toBe(`Reddit r/socialmedia · ${J_ID_PLACEHOLDER} · 2026-04`);
    expect(noteSource('p1', '北京日报报道中的受访者，2024-11')).toBe('北京日报报道中的受访者，2024-11');
  });

  it('tells the story as static steps in the server HTML, with the Owner\'s benchmark wording and no old claim', () => {
    const { html } = render();
    expect(html).toContain(J_TAKEOVER.positioningTitle);
    expect(html).toContain(J_TAKEOVER.benchmarkLine);
    for (const promise of J_TAKEOVER.promises) expect(html).toContain(promise.title);
    expect(html).toContain(J_TAKEOVER.promiseClose);
    // The long promise paragraph is never shown in one block any more.
    expect(html).not.toContain('你不用再分心研究运营技术，不用自己想选题');
    expect(JSON.stringify(copyJ)).not.toContain('程序算出来');
  });
});

describe('sample J story timing', () => {
  it('maps the scroll to the three chapters in order, ending inside the last', () => {
    expect(CHAPTERS.map(chapter => chapter.id)).toEqual(['positioning', 'jury', 'promises']);
    expect(chapterAt(0)).toEqual({ id: 'positioning', local: 0 });
    expect(chapterAt(0.5).id).toBe('jury');
    expect(chapterAt(1)).toEqual({ id: 'promises', local: 1 });
    expect(chapterAt(-1).id).toBe('positioning');
  });
});
