import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEMO_LABEL } from '@/components/landing/demo/demo-script';
import { J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_BENCHMARK_TABLE } from '@/lib/landing/landing-copy-j-takeover';
import { L_FLOW_ONE } from '@/lib/landing/landing-copy-l-flow';
import { L_LATER_FLYWHEEL } from '@/lib/landing/landing-copy-l-later';
import { HeroWindowL } from './HeroWindowL';
import { STEP_ONE_PICTURES } from './StepOneFlowL';

const SRC = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(SRC, path), 'utf8');
const sources = (dir: string): string[] => readdirSync(dir).flatMap(name => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
  return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
});
// The picture as it is drawn alone; React puts a preload hint for the coach's picture in front of it, which is not part of it.
const drawn = (html: string) => html.slice(html.indexOf('<div>') + '<div>'.length, -'</div>'.length);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// LANDING-ART step one (Owner 2026-11-11, MASTER_PLAN 2.1 / #1867): the home page's "晨光" layer and its first screen.
describe('the home page\'s 晨光 layer and the first screen\'s product window', () => {
  const html = renderToStaticMarkup(createElement(HeroWindowL));

  it('draws the window from step one\'s own third picture, finished, and marks it an example', () => {
    const picture = drawn(renderToStaticMarkup(createElement('div', null, STEP_ONE_PICTURES[2].draw(null))));
    expect(picture.length).toBeGreaterThan(500);
    expect(html).toContain(picture);
    expect(html).toContain(L_FLOW_ONE.plan.agree);
    // Region 3 draws the same picture further down the page: it must carry no element id, or the page would repeat one.
    expect(html).not.toMatch(/\sid="/);
    expect(html).toContain(DEMO_LABEL);
    // The layer's phone rule reaches the picture's holder by its place (.screen > div > div): the holder is the feed's one child.
    expect(html).toMatch(/ inert=""><div class="[^"]*feed[^"]*"><div>/);
    // The picture is an example: nothing in it can be focused or pressed.
    expect(html).toMatch(/<div class="[^"]*"[^>]* inert=""/);
  });

  it('says nothing the page\'s copy does not already hold', () => {
    const picture = text(renderToStaticMarkup(createElement('div', null, STEP_ONE_PICTURES[2].draw(null))));
    const [review] = L_LATER_FLYWHEEL.review.rows;
    const known = [
      ...J_STEPS.map(step => step.title), DEMO_LABEL, J_BENCHMARK_TABLE.title,
      ...J_BENCHMARK_TABLE.rows.slice(0, 3).flatMap(([account, state]) => [account, state]),
      L_LATER_FLYWHEEL.review.notice, ...review,
    ];
    // What is left of the window's text once the picture and the known lines are taken out: only the stage numbers.
    let rest = text(html).replace(picture, ' ');
    for (const line of [...known].sort((a, b) => b.length - a.length)) rest = rest.split(line).join(' ');
    expect(rest.replace(/[\s123]/g, '')).toBe('');
  });

  it('keeps the two side cards out of the reading order and the window in it', () => {
    expect(html.split('aria-hidden="true"').length - 1).toBeGreaterThanOrEqual(2);
    const cards = html.slice(0, html.indexOf(J_STEPS[0].title));
    expect(cards).toContain(J_BENCHMARK_TABLE.title);
    expect(cards).toContain(L_LATER_FLYWHEEL.review.notice);
  });

  it('puts the layer on the home page only: one root carries it, one first screen draws the window', () => {
    // Every landing component and the public pages' shell, each read once.
    const files = [join(SRC, 'components/landing'), join(SRC, 'components/public-site')].flatMap(sources)
      .map(path => [path.slice(SRC.length + 1), readFileSync(path, 'utf8')] as const);
    const users = (needle: string) => files.filter(([, source]) => source.includes(needle)).map(([path]) => path).sort();
    expect(users('dawn-l.module.css\'')).toEqual([
      'components/landing/preview-l/HeroL.tsx', 'components/landing/preview-l/HeroWindowL.tsx', 'components/landing/preview-l/SampleL.tsx',
    ]);
    expect(users('dawn.dawn')).toEqual(['components/landing/preview-l/SampleL.tsx']);
    expect(users('<HeroWindowL')).toEqual(['components/landing/preview-l/HeroL.tsx']);
  });

  it('changes no colour token, and other pages keep their buttons, header and backdrop as they were', () => {
    const layer = read('components/landing/preview-l/dawn-l.module.css');
    const tokens = ['canvas', 'ink', 'body', 'muted', 'line', 'note', 'gold', 'gold-text', 'shadow'];
    for (const token of tokens) expect(layer, token).not.toMatch(new RegExp(`--j-${token}\\s*:`));
    expect(layer).not.toMatch(/--(pub|gl)-[\w-]+\s*:/);
    // Each value the layer sets is read with the old value as the fallback.
    const page = read('components/landing/preview-j/j.module.css');
    expect(page).toContain('var(--j-header-bg, rgba(250, 250, 249, .94))');
    expect(page.split('var(--j-pill-bg, #141312)')).toHaveLength(3);
    expect(page).toContain('var(--j-pill-bg-hover, #33322f)');
    expect(page).toContain('var(--j-pill-shadow, none)');
    expect(page).toContain('var(--j-pill-hover-y, 0)');
    const backdrop = read('components/landing/preview-j/backdrop-j.module.css');
    expect(backdrop).toContain('var(--pool-gold, rgba(255, 196, 46, .22))');
    expect(backdrop).toContain('var(--pool-cool, rgba(140, 146, 160, .16))');
    expect(backdrop).toContain('var(--pool-paper, rgba(255, 236, 205, .55))');
    for (const name of ['--j-header-bg', '--j-pill-bg', '--j-pill-bg-hover', '--j-pill-shadow', '--j-pill-hover-y', '--pool-gold', '--pool-cool',
      '--pool-paper']) expect(layer, name).toMatch(new RegExp(`${name}\\s*:`));
  });

  it('moves the window with a transform only, and not at all under reduced motion', () => {
    const layer = read('components/landing/preview-l/dawn-l.module.css');
    const motion = layer.slice(layer.indexOf('@media (prefers-reduced-motion: no-preference)'));
    expect(motion).toContain('animation-timeline: scroll(root)');
    expect(layer.slice(0, layer.indexOf('@media (prefers-reduced-motion: no-preference)'))).not.toMatch(/animation\s*:/);
    expect(layer).toMatch(/@keyframes stand \{ from \{ transform: [^}]+\} to \{ transform: none; \} \}/);
    expect(layer).toMatch(/@keyframes drift \{ from \{ translate: [^}]+\} to \{ translate: [^}]+\} \}/);
    // The picture's room is a fixed height, so the page does not move as it loads.
    expect(layer).toMatch(/\.screen \{[^}]*height: clamp\(/);
  });
});
