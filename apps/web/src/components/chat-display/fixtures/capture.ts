/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { FieldValue } from '@/components/opc/capture-state';
import type { CaptureChecklistProps } from '@/components/opc/capture-checklist';

/**
 * Sample data for the positioning checklist (`CaptureChecklist`, the right column), matching the example
 * conversation in `positioning.ts` (a baker taking custom-cake orders on Xiaohongshu). Made-up content only.
 */
const value = (text: string, status: FieldValue['status'] = 'provisional'): FieldValue => ({ value: text, status, nature: 'decision' });

export const SAMPLE_CHECKLIST_STEPS = [
  { id: 'about', title: '了解你' },
  { id: 'diagnose', title: '诊断与平台对标' },
  { id: 'plan', title: '定位与执行方案' },
] as const;

export const SAMPLE_CHECKLIST_INFORMATION: CaptureChecklistProps['information'] = {
  about: {
    schema: [
      { id: 'goal', title: '最终目标与变现方式', required: true },
      { id: 'audience', title: '想吸引的受众', required: true },
      { id: 'resource', title: '可投入的资源', required: true },
      { id: 'benchmark', title: '对标账号', required: false },
    ],
    values: {
      goal: value('在小红书接定制蛋糕的单。'),
      audience: value('本地想订生日蛋糕的年轻人'),
      resource: value('每周 3–10 小时'),
    },
    meta: { goal: { source: 'capture', protected: false }, audience: { source: 'capture', protected: false }, resource: { source: 'capture', protected: false } },
  },
  diagnose: {
    schema: [{ id: 'platform', title: '平台', required: true }, { id: 'rival', title: '竞品', required: false }],
    values: { platform: value('小红书') },
    meta: { platform: { source: 'capture' } },
  },
  plan: { schema: [{ id: 'plan', title: '执行方案', required: true }], values: {} },
};
