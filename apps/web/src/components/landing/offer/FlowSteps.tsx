/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Lightbulb } from 'lucide-react';
import { FLOW_NOTE_LABEL, type FlowStep } from '@/lib/landing/landing-flow';
import { cn } from '@/lib/utils';
import { FlowMockView } from './FlowMocks';
import { PlayOnView } from './PlayOnView';
import styles from './flow.module.css';

/**
 * Module 3a: the walk-through after sign-up. Each step that is on shows a screen mock that plays when it
 * scrolls into view, with the "why this is not generic advice" note next to it. Numbering follows the
 * steps that are shown, so a hidden step leaves no gap.
 */
export function FlowSteps({ steps }: { steps: readonly FlowStep[] }) {
  if (steps.length === 0) return null;
  return (
    <ol className="mt-14 grid gap-14 md:gap-20">
      {steps.map((step, index) => (
        <li key={step.id} id={step.id} className="grid items-center gap-6 md:grid-cols-2 md:gap-10">
          <PlayOnView className={cn(styles.stage, 'order-2', index % 2 === 1 ? 'md:order-2' : 'md:order-1')}>
            <FlowMockView mock={step.mock} />
          </PlayOnView>
          <div className={cn('order-1 grid gap-3', index % 2 === 1 ? 'md:order-1' : 'md:order-2')}>
            <p className="flex items-center gap-3">
              <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#FFD700] text-sm font-bold text-[#0A0A0A]">
                {index + 1}
              </span>
              <span className="text-xl font-bold text-white">{step.title}</span>
            </p>
            <p className="text-base leading-relaxed text-[#C8C8C8]">{step.demo}</p>
            <div className="rounded-xl border border-[#FFD700]/25 bg-[#FFD700]/5 p-4">
              <p className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-[#FFD700]">
                <Lightbulb className="h-4 w-4" aria-hidden="true" />
                {FLOW_NOTE_LABEL}
              </p>
              <p className="text-sm leading-relaxed text-[#D8D8D8]">{step.note}</p>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
