/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { J_COMPARE } from '@/lib/landing/landing-copy-j-compare';
import { J_PERSONA, J_PERSONA_DIRECTION, J_PERSONA_KINDS, J_PERSONA_QUESTION } from '@/lib/landing/landing-copy-j-persona';
import { J_BENCHMARK_TABLE, J_PLAN_ROWS, J_REPORT, J_TAKEOVER_MOMENTS } from '@/lib/landing/landing-copy-j-takeover';
import { J_WEEK } from '@/lib/landing/landing-copy-j-week';
import { J_WORK_SCENES } from '@/lib/landing/landing-copy-j-work';

/**
 * Local edit mode only (imported by OwnerEditJ, which production builds drop): every piece of text the page's demos
 * play, gathered from the copy files so the Owner can edit what the animations say (Owner 2026-10-15). Each entry
 * keeps the path inside its copy constant, so a saved change can be carried back to the right place.
 */
export type DemoCopyItem = { path: string; text: string };
export type DemoCopyGroup = { title: string; source: string; items: DemoCopyItem[] };

const HAN = /[㐀-鿿]/;

/** Every string under `value` that a reader sees (has Chinese text), with its path. */
export function collectText(value: unknown, path: string, out: DemoCopyItem[] = []): DemoCopyItem[] {
  if (typeof value === 'string') {
    if (HAN.test(value)) out.push({ path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectText(item, `${path}[${index}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectText(item, `${path}.${key}`, out);
  }
  return out;
}

export function demoCopyGroups(): DemoCopyGroup[] {
  return [
    { title: '首屏演示窗口', source: 'landing-copy-j-week.ts', items: collectText(J_WEEK, 'J_WEEK') },
    {
      title: 'AI 教练怎么接手你的运营', source: 'landing-copy-j-takeover.ts / landing-copy-j-persona.ts',
      items: [
        ...collectText(J_TAKEOVER_MOMENTS, 'J_TAKEOVER_MOMENTS'),
        ...collectText({ J_PERSONA, J_PERSONA_QUESTION, J_PERSONA_DIRECTION, J_PERSONA_KINDS }, 'persona'),
        ...collectText({ J_BENCHMARK_TABLE, J_PLAN_ROWS, J_REPORT }, 'takeover'),
      ],
    },
    ...J_WORK_SCENES.map(scene => ({
      title: `大模块 · ${scene.title}`, source: scene.group === 0 ? 'landing-copy-j-work-care.ts' : 'landing-copy-j-work-make.ts',
      items: collectText(scene, `J_WORK_SCENES.${scene.id}`),
    })),
    { title: '通用 AI 和 AI 教练对比', source: 'landing-copy-j-compare.ts', items: collectText(J_COMPARE, 'J_COMPARE') },
  ];
}
