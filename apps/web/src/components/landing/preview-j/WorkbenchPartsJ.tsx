/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { JuryCanvasPlayer } from '@/components/landing/preview-jury/JuryCanvasPlayer';
import { JuryReader } from '@/components/landing/preview-jury/JuryReader';
import { resolveSeatNames, SAMPLE_PANEL } from '@/components/landing/preview-jury/jury-events';
import type { FieldValue, StepInformation } from '@/components/opc/capture-state';
import { StepConfirmCard } from '@/components/opc/step-confirm-card';
import { J_FIELDS, J_FIELD_VALUES, J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_JURY_RESULT_LABEL, J_TAKEOVER_MOMENTS, type TakeoverLine } from '@/lib/landing/landing-copy-j-takeover';
import { J_JURY_CASE } from './jury-case-j';
import { J_JURY_DETAIL, J_READER_REPORT } from './jury-reader-j';
import theme from '@/components/landing/preview-jury/jury-theme.module.css';
import { cn } from '@/lib/utils';
import styles from './takeover-j.module.css';

const noop = () => undefined;
/** The jury prototype's "示例名字" panel (Owner 2026-10-15: not "评审 A/B/C"). */
const SEAT_NAMES = resolveSeatNames(SAMPLE_PANEL);

/** The fields the conversation has filled by this point: every earlier moment's, plus those of the lines shown. */
export function filledUpTo(moment: number, lines: readonly TakeoverLine[]): Set<string> {
  const earlier = J_TAKEOVER_MOMENTS.slice(0, moment).flatMap(item => item.lines.flatMap(line => line.fills ?? []));
  return new Set([...earlier, ...lines.flatMap(line => line.fills ?? [])]);
}

/** The checklist's server-shaped data for this person: filled fields as drafts, the first `confirmed` steps confirmed. */
export function personaInformation(filled: Set<string>, confirmed: number): Record<string, StepInformation> {
  return Object.fromEntries(J_STEPS.map((step, index) => {
    const schema = [...J_FIELDS[step.id]];
    const values: Record<string, FieldValue> = {};
    const meta: Record<string, unknown> = {};
    for (const field of schema) {
      const sample = J_FIELD_VALUES[field.id];
      if (!sample || !filled.has(field.id)) continue;
      values[field.id] = { value: sample.value, status: index < confirmed ? 'confirmed' : 'provisional', nature: sample.proposal ? 'decision' : 'fact' };
      meta[field.id] = { source: 'capture', basis: sample.proposal ? 'agent_proposal' : 'user_statement' };
    }
    return [step.id, { schema, values, meta }];
  }));
}

/** The product's confirm area under a step's messages: what is still missing, or "请看一眼再确认" once it is complete. */
export function ConfirmJ({ step, information }: { step: string; information: Record<string, StepInformation> }) {
  const found = J_STEPS.find(item => item.title === step) ?? J_STEPS[0];
  return (
    <div className={styles.cardSlot}>
      <StepConfirmCard stepId={found.id} title={found.title} info={information[found.id]} edits={undefined} signal={undefined}
        resuming={false} disabled stays={false} canConfirm onConfirm={noop} onEdit={noop} onReview={noop} />
    </div>
  );
}

/**
 * The jury opened from the report: #1002's canvas (brief) with the prototype's sample names and this report's chapters,
 * played by the scroll; then the finished review as the real result page (#1004's JuryReader: "30 秒看懂", the changed
 * chapters lit, only changes or the whole text, the confirm bar), carrying this page's report. The scroll walks down
 * the result page, so the whole of what the review gives you passes by.
 */
export function JuryJ({ local }: { local: number }) {
  if (local <= 0.08) return null;
  const play = Math.min(1, (local - 0.08) / 0.62);
  const reading = local < 0.72 ? -1 : Math.min(1, (local - 0.72) / 0.26);
  return (
    <div className={styles.juryLayer}>
      {reading < 0 ? <JuryCanvasPlayer data={J_JURY_CASE} brief progress={play} names={SEAT_NAMES} /> : (
        <ResultJ reading={reading} />
      )}
    </div>
  );
}

/**
 * The result page in the layer, in the jury's own theme. The layer scrolls it (not a transform), so the page's sticky
 * contents and confirm bar stay put as on the real page. Until the visitor touches it, the page scroll walks it from
 * top to end (`reading` 0 → 1); once the visitor scrolls it, clicks or uses the keys, it is theirs: it scrolls
 * normally, "跳到下一处改动" and the contents move this frame only (JuryReader's scrollRoot), never the page.
 */
function ResultJ({ reading }: { reading: number }) {
  const frame = useRef<HTMLDivElement>(null);
  const [mine, setMine] = useState(false);
  useLayoutEffect(() => {
    const node = frame.current;
    if (node && !mine) node.scrollTop = Math.round((node.scrollHeight - node.clientHeight) * reading);
  }, [reading, mine]);
  const takeOver = () => setMine(true);
  return (
    <div ref={frame} className={cn(theme.theme, styles.result)} aria-label={J_JURY_RESULT_LABEL}
      onWheel={takeOver} onTouchMove={takeOver} onKeyDown={takeOver} onPointerDown={takeOver}>
      <JuryReader detail={J_JURY_DETAIL} names={SEAT_NAMES} source={J_READER_REPORT} scrollRoot={frame} />
    </div>
  );
}
