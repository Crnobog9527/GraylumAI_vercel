/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { StepValues } from './hostChecks';

/** Per-section adoption (Owner 2026-10-14 "评审结果逐章选择采用修订版或保留原文"). Pure: the original text comes from
 * the frozen reviewed version, the revision from the summary that passed the frozen host check. A changed section is
 * either taken from the revision or kept; unchanged sections are kept. Fields follow their sections: a field declared
 * by several sections ties those sections to one choice. A wording-only section needs the user's confirmation that it
 * changes no positioning fact (the R14 per-section confirmation, kept in the same step). */
export const adoptionChoices = z.array(z.object({ section: z.string().min(1).max(200), use: z.enum(['revised', 'original']),
  confirmedNoFactChange: z.boolean().optional() }).strict()).max(64);
export type AdoptionChoice = z.infer<typeof adoptionChoices>[number];
type Note = { section: string; wordingOnly: boolean; fields: Array<{ stepId: string; fieldId: string }> };
export type AdoptionSection = { section: string; changed: boolean; wordingOnly: boolean; original: string; revised: string;
  fields: Array<{ stepId: string; fieldId: string; before: string; after: string }>; linkedSections: string[] };

/** The whole heading line is captured, so a kept section is rebuilt byte for byte (tabs, spaces, CRLF; #962 review). */
const HEADING = /^(##[ \t]+[^\r\n]+\r?)$/m;
/** Raw parts as written: the text before the first heading, then each section's heading line and raw content. */
function rawSections(body: string) {
  const parts = body.split(HEADING);
  const sections = new Map<string, { heading: string; content: string }>();
  for (let i = 1; i < parts.length; i += 2) {
    sections.set(parts[i]!.replace(/^##[ \t]+/, '').trim(), { heading: parts[i]!, content: parts[i + 1] ?? '' });
  }
  return { preamble: parts[0] ?? '', sections };
}
const shown = (content: string) => content.replace(/^\r?\n/, '').replace(/\r?\n$/, '');

export function adoptionSections(input: { originalBody: string; revisedBody: string; sections: string[]; changedSections: string[];
  changeNotes: Note[]; frozen: StepValues; revisedSteps: StepValues }): AdoptionSection[] {
  const before = rawSections(input.originalBody).sections, after = rawSections(input.revisedBody).sections;
  const key = (f: { stepId: string; fieldId: string }) => `${f.stepId}\u0000${f.fieldId}`;
  const notes = new Map(input.changeNotes.map(note => [note.section, note]));
  return input.sections.map(section => {
    const note = notes.get(section);
    const linked = new Set<string>();
    for (const field of note?.fields ?? []) {
      for (const other of input.changeNotes) if (other.section !== section && other.fields.some(f => key(f) === key(field))) linked.add(other.section);
    }
    return { section, changed: input.changedSections.includes(section), wordingOnly: Boolean(note?.wordingOnly),
      original: shown(before.get(section)?.content ?? ''), revised: shown(after.get(section)?.content ?? ''),
      fields: (note?.fields ?? []).map(f => ({ stepId: f.stepId, fieldId: f.fieldId, before: input.frozen[f.stepId]?.[f.fieldId] ?? '',
        after: input.revisedSteps[f.stepId]?.[f.fieldId] ?? '' })),
      linkedSections: [...linked] };
  });
}

/** Validates the choices and builds what R14 proposes: the merged body and the fields of adopted sections. */
export function applyChoices(input: { originalBody: string; revisedBody: string; plan: AdoptionSection[]; choices: AdoptionChoice[] }):
  { body: string; fields: StepValues; adopted: string[]; kept: string[] } {
  const changed = input.plan.filter(section => section.changed);
  const choice = new Map<string, AdoptionChoice>();
  for (const item of input.choices) {
    if (choice.has(item.section) || !changed.some(section => section.section === item.section)) throw new Error('FUSION_ADOPTION_INVALID');
    choice.set(item.section, item);
  }
  // Every changed section is decided explicitly; nothing is adopted by default.
  if (choice.size !== changed.length) throw new Error('FUSION_ADOPTION_INCOMPLETE');
  for (const section of changed) {
    const picked = choice.get(section.section)!;
    if (picked.use === 'revised' && section.wordingOnly && picked.confirmedNoFactChange !== true) throw new Error('FUSION_ADOPTION_CONFIRM_REQUIRED');
    if (section.linkedSections.some(other => choice.get(other)?.use !== picked.use)) throw new Error('FUSION_ADOPTION_LINKED');
  }
  const adopted = changed.filter(section => choice.get(section.section)!.use === 'revised').map(section => section.section);
  const kept = input.plan.filter(section => !adopted.includes(section.section)).map(section => section.section);
  const original = rawSections(input.originalBody), revised = rawSections(input.revisedBody).sections;
  let body = original.preamble;
  for (const [title, part] of original.sections) {
    body += adopted.includes(title) ? revised.get(title)!.heading + revised.get(title)!.content : part.heading + part.content;
  }
  const fields: StepValues = {};
  for (const section of input.plan.filter(s => adopted.includes(s.section))) {
    for (const field of section.fields) if (field.after !== field.before) (fields[field.stepId] ??= {})[field.fieldId] = field.after;
  }
  return { body, fields, adopted, kept };
}
