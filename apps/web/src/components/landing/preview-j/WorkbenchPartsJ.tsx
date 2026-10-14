/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
'use client';

import { JuryCanvasPlayer } from '@/components/landing/preview-jury/JuryCanvasPlayer';
import { REVISION_TEXT } from '@/components/landing/preview-jury/jury-mock-rulings';
import { resolveSeatNames, SAMPLE_PANEL } from '@/components/landing/preview-jury/jury-events';
import type { FieldValue, StepInformation } from '@/components/opc/capture-state';
import { StepConfirmCard } from '@/components/opc/step-confirm-card';
import { J_FIELDS, J_FIELD_VALUES, J_STEPS } from '@/lib/landing/landing-copy-j-persona';
import { J_REVISION, J_TAKEOVER_MOMENTS, type TakeoverLine } from '@/lib/landing/landing-copy-j-takeover';
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
 * The jury opened from the report: #1002's canvas (brief) with the prototype's sample names, played by the scroll;
 * then the revised report chapter by chapter, each change shown as 改前 → 改后.
 */
export function JuryJ({ local }: { local: number }) {
  if (local <= 0.08) return null;
  const play = Math.min(1, (local - 0.08) / 0.62);
  const changes = Object.entries(REVISION_TEXT);
  const shown = local < 0.72 ? 0 : Math.min(changes.length, Math.ceil((local - 0.72) / 0.18 * changes.length));
  return (
    <div className={styles.juryLayer}>
      {shown === 0 ? <JuryCanvasPlayer brief progress={play} names={SEAT_NAMES} /> : (
        <section className={styles.revision} aria-label={J_REVISION.title}>
          <h2>{J_REVISION.title}</h2>
          <ol>
            {changes.slice(0, shown).map(([chapter, text]) => (
              <li key={chapter}>
                <b>{chapter}</b>
                <p><span>{J_REVISION.before}</span>{text.original}</p>
                <p><span>{J_REVISION.after}</span>{text.revised}</p>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
