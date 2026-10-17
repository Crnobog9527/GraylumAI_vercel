/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { JuryCanvas } from '@/components/landing/preview-jury/JuryCanvas';
import { JuryReader } from '@/components/landing/preview-jury/JuryReader';
import { JuryRecords } from '@/components/landing/preview-jury/JuryRecords';
import { JuryStatic } from '@/components/landing/preview-jury/JuryStatic';
import { JuryStepsRail } from '@/components/landing/preview-jury/JuryStepsRail';
import { canvasAt } from '@/components/landing/preview-jury/jury-canvas';
import * as J from './jury';

const noop = () => undefined;

// The landing page renders the jury from these fixtures; the product page renders the same components.
it('renders the running review from the shared fixtures', () => {
  const html = renderToStaticMarkup(<>
    <JuryStepsRail stage="reading" skipped={J.SAMPLE_JURY_SKIPPED} ended={false} left="约 3 分钟"/>
    <JuryCanvas view={canvasAt(J.SAMPLE_JURY_SCENES, 20_000, J.SAMPLE_JURY_NAMES)} names={J.SAMPLE_JURY_NAMES} selected={null}
      onPeek={noop} onPick={noop}/>
  </>);
  expect(html).toContain('评审进度');
  expect(html).toContain('约 3 分钟');
  for (const name of Object.values(J.SAMPLE_JURY_NAMES)) expect(html).toContain(name);
});

it('renders the result page and the records from the shared fixtures', () => {
  const { detail } = J.SAMPLE_JURY_SCENARIO;
  const html = renderToStaticMarkup(<>
    <JuryReader detail={detail} names={J.SAMPLE_JURY_NAMES} source={J.SAMPLE_JURY_READER_SOURCE} actions={J.SAMPLE_JURY_ADOPT_ACTIONS}/>
    <JuryRecords detail={detail} names={J.SAMPLE_JURY_NAMES} arrived={J.SAMPLE_JURY_ARRIVED} live={false} following="S" picked={null}
      onPick={noop} onFollow={noop}/>
  </>);
  expect(html).toContain('报告目录');
  expect(html).toContain('评审工作记录');
  expect(html).toContain(J.SAMPLE_JURY_READER_SOURCE.chapters[0].name);
});

it('renders the reduced-motion version and lists all three endings', () => {
  const html = renderToStaticMarkup(<JuryStatic scenes={J.SAMPLE_JURY_SCENES} detail={J.SAMPLE_JURY_SCENARIO.detail}
    names={J.SAMPLE_JURY_NAMES} skipped={J.SAMPLE_JURY_SKIPPED} onOpenRecord={noop}/>);
  expect(html.length).toBeGreaterThan(500);
  expect(J.SAMPLE_JURY_SCENARIOS.map(item => item.id)).toEqual(['full', 'consensus', 'failed']);
  expect(J.SAMPLE_JURY_CASE.arrivals.length).toBeGreaterThan(0);
});
