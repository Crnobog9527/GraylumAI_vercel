/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { mockCase, type JuryCase } from '@/components/landing/preview-jury/jury-case';
import { resolveSeatNames, SAMPLE_PANEL, type JurySeatNames } from '@/components/landing/preview-jury/jury-events';
import { MOCK_READER_SOURCE, type ReaderSource } from '@/components/landing/preview-jury/jury-reader';
import { buildScenes, skippedStages } from '@/components/landing/preview-jury/jury-scenes';
import { findScenario, JURY_SCENARIOS, type JuryScenario } from '@/components/landing/preview-jury/jury-scripts';
import { MOCK_ADOPT_ACTIONS, type AdoptActions } from '@/components/landing/preview-jury/use-adoption';
import type { Arrived } from '@/components/landing/preview-jury/JuryDossier';

/**
 * Sample data for the jury (评审团) display components, shared by the landing page and the tests. The jury
 * components and their mock data already live in `components/landing/preview-jury` (the product's
 * `components/fusion-review` renders the same components); this file is the single entry point next to the
 * other fixtures, so nothing is copied or rewritten. Made-up example content only.
 */

/** "评审团正在审阅你的定位报告": the full scenario (three seats, one round of debate, a summary). */
export const SAMPLE_JURY_SCENARIO: JuryScenario = findScenario('full');
/** All three endings the prototype plays: full, agreed at once, failed. */
export const SAMPLE_JURY_SCENARIOS: readonly JuryScenario[] = JURY_SCENARIOS;

/** The seat names as the administrator set them in the sample panel. */
export const SAMPLE_JURY_NAMES: JurySeatNames = resolveSeatNames(SAMPLE_PANEL);

/** The report and event arrivals for the embeddable canvas (`JuryCanvasPlayer data`). */
export const SAMPLE_JURY_CASE: JuryCase = mockCase('full');

/** The scenes the playback is built from, and the steps a scenario skips. */
export const SAMPLE_JURY_SCENES = buildScenes(SAMPLE_JURY_SCENARIO.arrivals);
export const SAMPLE_JURY_SKIPPED = skippedStages(SAMPLE_JURY_SCENES);

/** Everything arrived: the result page state. */
export const SAMPLE_JURY_ARRIVED: Arrived = {
  rounds: Object.fromEntries((['A', 'B', 'C'] as const).map(seat =>
    [seat, SAMPLE_JURY_SCENARIO.detail.seats.find(item => item.seat === seat)?.rounds.map(round => round.round) ?? []])) as Arrived['rounds'],
  summary: SAMPLE_JURY_SCENARIO.detail.summary.status !== 'none',
};

/** The report chapters, digests and summary lines the result page ("轻松读") reads. */
export const SAMPLE_JURY_READER_SOURCE: ReaderSource = MOCK_READER_SOURCE;

/** Adoption answers that never reach a server. */
export const SAMPLE_JURY_ADOPT_ACTIONS: AdoptActions = MOCK_ADOPT_ACTIONS;
