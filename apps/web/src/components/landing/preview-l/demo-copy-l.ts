/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { collectText, type DemoCopyGroup } from '@/components/landing/preview-j/demo-copy-j';
import { J_PERSONA_DIRECTION, J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_BENCHMARK_TABLE, J_REPORT } from '@/lib/landing/landing-copy-j-takeover';
import { L_HERO_FLOW } from '@/lib/landing/landing-copy-l';
import { L_LATER_CHAT, L_LATER_FLYWHEEL } from '@/lib/landing/landing-copy-l-later';
import { L_POSITIONING_MOMENTS } from '@/lib/landing/landing-copy-l-positioning';
import { L_JURY, L_SCENARIOS } from '@/lib/landing/landing-copy-l-steps';
import { L_WORKFLOWS } from '@/lib/landing/landing-copy-l-workflows';

/**
 * Local edit mode only (sample L's preview page mounts OwnerEditL in a development server; production builds drop it):
 * the text sample L's demos type out or play inside product pictures, which cannot be edited in place (Owner
 * 2026-10-18). Each entry keeps its path inside its copy constant, so a saved change goes back to the right place.
 * Not here: the sample reports themselves (generated reports, lib/landing/sample-reports), only edited by regenerating.
 */
export function demoCopyGroupsL(): DemoCopyGroup[] {
  return [
    { title: '首屏演示', source: 'landing-copy-l.ts', items: collectText(L_HERO_FLOW, 'L_HERO_FLOW') },
    {
      title: '第一步 · 定位对话', source: 'landing-copy-l-positioning.ts / landing-copy-j-persona.ts / landing-copy-j-takeover.ts',
      items: [
        ...collectText(L_POSITIONING_MOMENTS, 'L_POSITIONING_MOMENTS'),
        ...collectText({ J_PERSONA_DIRECTION, J_STEPS }, 'persona'),
        ...collectText({ J_BENCHMARK_TABLE, J_REPORT: { ...J_REPORT, chapters: J_REPORT.chapters.map(({ title }) => ({ title })) } }, 'takeover'),
      ],
    },
    { title: '第二步、第三步 · 每周对话', source: 'landing-copy-l-later.ts', items: collectText({ L_LATER_CHAT, L_LATER_FLYWHEEL }, 'later') },
    { title: '评审团动画', source: 'landing-copy-l-steps.ts', items: collectText(L_JURY, 'L_JURY') },
    { title: '区域 6 · 同一个问题两种回答', source: 'landing-copy-l-steps.ts / landing-copy-l-workflows.ts',
      items: [...collectText(L_SCENARIOS, 'L_SCENARIOS'), ...collectText(L_WORKFLOWS, 'L_WORKFLOWS')] },
  ];
}
