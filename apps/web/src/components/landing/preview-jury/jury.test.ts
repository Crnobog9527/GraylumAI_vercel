import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import sitemap from '@/app/sitemap';
import { metadata } from '@/app/landing/preview/jury/page';
import { DEFAULT_SEAT_NAMES, resolveSeatNames, SAMPLE_PANEL, SEAT_NAME_MAX } from './jury-events';
import { findScenario, JURY_SCENARIOS } from './jury-scripts';
import { deriveView, playbackLength, scheduleReveals } from './jury-timeline';
import { StaticReplay } from './JuryRecord';

const timedOf = (id: string) => scheduleReveals(findScenario(id).arrivals);
const events = (id: string) => timedOf(id).map(item => item.event);

describe('jury prototype page', () => {
  it('is never indexed and never listed in the sitemap', () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(sitemap().some(entry => entry.url.includes('/preview'))).toBe(false);
  });
});

describe('mock events follow the FUSION-REVIEW §2.2a contract', () => {
  it('gives every event a unique id and keeps text fields to 120 characters', () => {
    for (const scenario of JURY_SCENARIOS) {
      const list = scenario.arrivals.flatMap(arrival => arrival.events);
      expect(new Set(list.map(event => event.id)).size).toBe(list.length);
      for (const event of list) {
        for (const value of Object.values(event)) {
          if (typeof value === 'string') expect(Array.from(value).length).toBeLessThanOrEqual(120);
        }
      }
    }
  });

  it('delivers each reviewer\'s decisions and issues together, 10–30 s after it started', () => {
    for (const scenario of JURY_SCENARIOS) {
      const started = new Map<string, number>();
      for (const arrival of scenario.arrivals) {
        for (const event of arrival.events) {
          if (event.type === 'reviewer_started') started.set(`${event.round}${event.reviewer}`, arrival.atMs);
          if (event.type === 'decision' || event.type === 'issue' || event.type === 'response') {
            const wait = arrival.atMs - (started.get(`${event.round}${event.reviewer}`) ?? Infinity);
            expect(wait).toBeGreaterThanOrEqual(10_000);
            expect(wait).toBeLessThanOrEqual(30_000);
          }
        }
      }
    }
  });

  it('has no disagreement or response when the reviewers agree, and no ruling when the revision fails', () => {
    const consensus = events('consensus').map(event => event.type);
    expect(consensus).not.toContain('disagreement');
    expect(consensus).not.toContain('response');
    const failed = events('failed').map(event => event.type);
    expect(failed).toContain('revision_failed');
    expect(failed).not.toContain('adjudication');
    expect(failed).not.toContain('revision_ready');
  });

  it('invents no outcome metrics: no percentages, follower or view counts, or money', () => {
    const words = JSON.stringify(JURY_SCENARIOS);
    expect(words).not.toMatch(/\d+(\.\d+)?\s*(%|万|k\b|\$|美元|元|粉|播放|分(?!钟))/);
  });
});

describe('playback', () => {
  it('never shows an event before it arrived, plays each id once and in list order', () => {
    for (const scenario of JURY_SCENARIOS) {
      const timed = scheduleReveals([...scenario.arrivals, scenario.arrivals[0]]);
      expect(timed.length).toBe(scenario.arrivals.flatMap(arrival => arrival.events).length);
      timed.forEach((item, index) => {
        expect(item.revealAt).toBeGreaterThanOrEqual(item.arrivedAt);
        if (index > 0) expect(item.revealAt).toBeGreaterThan(timed[index - 1].revealAt);
      });
    }
  });

  it('runs long enough to carry a real 2–4 minute review at 1×; an early end is shorter, as in reality', () => {
    const length = (id: string) => playbackLength(timedOf(id));
    expect(length('full')).toBeGreaterThan(120_000);
    expect(length('full')).toBeLessThan(240_000);
    expect(length('consensus')).toBeGreaterThan(60_000);
    expect(length('consensus')).toBeLessThan(length('full'));
  });

  it('shows a reviewer as thinking until its answer arrives, with nothing said in between', () => {
    const timed = timedOf('full');
    const view = deriveView(timed, 10_000);
    expect(view.seats.A.phase).toBe('thinking');
    expect(view.feed).toHaveLength(0);
    expect(view.waiting).toBe(true);
    const later = deriveView(timed, 30_000);
    expect(later.seats.A.phase).toBe('speaking');
    expect(later.seats.C.phase).toBe('ready');
    expect(later.seats.B.phase).toBe('thinking');
  });

  it('marks the split decisions, skips the debate when everyone agrees and ends on the outcome', () => {
    const full = timedOf('full');
    const end = deriveView(full, playbackLength(full));
    expect(end.disagreements.map(item => item.decision)).toEqual(['platform', 'monetization']);
    expect(end.revision?.type).toBe('revision_ready');
    expect(end.ended).toBe(true);
    const consensus = timedOf('consensus');
    expect(deriveView(consensus, playbackLength(consensus)).skipped).toEqual(['divergence', 'debate']);
    const failed = timedOf('failed');
    const failedEnd = deriveView(failed, playbackLength(failed));
    expect(failedEnd.revision?.type).toBe('revision_failed');
    expect(failedEnd.failures.map(item => item.reviewer)).toEqual(['B']);
  });
});

describe('seat names', () => {
  it('defaults to 评审 A/B/C and 汇总, and takes names from the panel up to 20 characters', () => {
    expect(resolveSeatNames(undefined)).toEqual(DEFAULT_SEAT_NAMES);
    const sample = resolveSeatNames(SAMPLE_PANEL);
    expect(Array.from(sample.A)).toHaveLength(SEAT_NAME_MAX);
    expect(sample.S).toBe('首席主笔');
    const tooLong = resolveSeatNames({ ...SAMPLE_PANEL, reviewers: [{ seat: 'B', name: '名'.repeat(SEAT_NAME_MAX + 1) }] });
    expect(tooLong.B).toBe(DEFAULT_SEAT_NAMES.B);
    expect(tooLong.A).toBe(DEFAULT_SEAT_NAMES.A);
  });

  it('lists the whole review statically, with the configured names and no model names', () => {
    const timed = timedOf('full');
    const view = deriveView(timed, playbackLength(timed));
    const html = renderToStaticMarkup(createElement(StaticReplay, { timed, view, names: resolveSeatNames(SAMPLE_PANEL) }));
    expect(html).toContain('专门挑刺的资深短视频运营与商业变现老顾问');
    expect(html).toContain('修订稿已完成');
    expect(html).not.toMatch(/claude|gpt|gemini|sonnet|deepseek|qwen/i);
  });
});
