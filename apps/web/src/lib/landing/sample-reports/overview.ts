/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import accountant from './overview/accountant.json';
import courseCreator from './overview/course-creator.json';
import creator from './overview/creator.json';
import crossBorder from './overview/cross-border.json';
import designer from './overview/designer.json';
import handmade from './overview/handmade.json';
import officeWorker from './overview/office-worker.json';
import mom from './overview/mom.json';
import realtor from './overview/realtor.json';
import restaurant from './overview/restaurant.json';
import shop from './overview/shop.json';
import sideHustle from './overview/side-hustle.json';
import soloFounder from './overview/solo-founder.json';
import student from './overview/student.json';
import trainer from './overview/trainer.json';

/**
 * The 15-second overview of each sample report (Owner 2026-10-17, round five: "让用户 15 秒就能看懂"), drawn in the
 * report dialog. Extracted from the report itself by the offer window, every number and price exactly as the report
 * writes it; a field the report does not give is null and is not drawn. Benchmarks keep the report's own letters.
 */
export type SampleOverview = {
  slug: string;
  persona: { label: string; who: string };
  positioning: string;
  riskAlert: { headline: string; why: string[] } | null;
  audience: { name: string; trigger: string }[];
  platform: { main: string; support: string[]; why: string };
  benchmarks: {
    id: string; type: string; followers: string | null; medianViews: string | null; engagementRate: string | null;
    updateFreq: string | null; learn: string;
  }[];
  differentiation: string;
  threePiece: { name: string; bio: string };
  contentPillars: { name: string; share: string | null }[];
  /** Each layer, what it does and why it is there (the report's own words, round six). */
  funnel: { layer: string; offer: string; price: string | null; why?: string }[];
  plan30: { week: number; focus: string }[];
  metricsToWatch: string[];
  firstStep: string[];
  sourceNote: string;
  /**
   * The person's account as the report recommends it (name and bio from the report's 三件套; followers and posts are
   * the existing account's figures, when the report gives them); null when the person has no account yet.
   */
  ownAccount?: {
    platform: string; displayName: string; which: string; bio: string;
    followers: string | null; posts: string | null; topStat: string | null;
  } | null;
};

export const SAMPLE_OVERVIEWS: Record<string, SampleOverview> = {
  'accountant': accountant,
  'course-creator': courseCreator,
  'creator': creator,
  'cross-border': crossBorder,
  'designer': designer,
  'handmade': handmade,
  'office-worker': officeWorker,
  'mom': mom,
  'realtor': realtor,
  'restaurant': restaurant,
  'shop': shop,
  'side-hustle': sideHustle,
  'solo-founder': soloFounder,
  'student': student,
  'trainer': trainer,
};
