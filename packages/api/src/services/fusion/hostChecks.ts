/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/** Host checks of FUSION-REVIEW §2.2: pure, deterministic functions over the saved text and the frozen
 * inputs, so recovery can redo them with the same result. They never call a model or the database. */

export const SEVERITIES = ['critical', 'major', 'minor'] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
export const opinionSchema = z.object({
  issues: z.array(z.object({ location: text(200), problem: text(2000), suggestion: text(2000),
    severity: z.enum(SEVERITIES) }).strip()).max(50),
}).strip();
export type Opinion = z.infer<typeof opinionSchema>;

/** JSON response formats sent with each request (strict schema mode). */
export const OPINION_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'review_opinion', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['issues'], properties: { issues: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['location', 'problem', 'suggestion', 'severity'], properties: {
      location: { type: 'string' }, problem: { type: 'string' }, suggestion: { type: 'string' },
      severity: { type: 'string', enum: [...SEVERITIES] } } } } } } } } as const;
export const REVISION_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'review_revision', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['body', 'steps', 'changeNotes'], properties: {
    body: { type: 'string' },
    steps: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['stepId', 'fields'], properties: {
      stepId: { type: 'string' }, fields: { type: 'array', items: { type: 'object', additionalProperties: false,
        required: ['fieldId', 'value', 'changed'], properties: { fieldId: { type: 'string' }, value: { type: 'string' },
          changed: { type: 'boolean' } } } } } } },
    changeNotes: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['section', 'wordingOnly', 'fields', 'note'], properties: { section: { type: 'string' }, wordingOnly: { type: 'boolean' },
        note: { type: 'string' }, fields: { type: 'array', items: { type: 'object', additionalProperties: false,
          required: ['stepId', 'fieldId'], properties: { stepId: { type: 'string' }, fieldId: { type: 'string' } } } } } } } } } } } as const;

/** Lenient parse: the JSON object itself, or the first fenced/embedded object. */
function looseJson(raw: string): unknown {
  const candidates = [raw.trim(), /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)?.[1]?.trim(),
    raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) { try { return JSON.parse(candidate); } catch { /* next */ } }
  return undefined;
}

/** A review opinion, or null when it is not usable (the call is then judged format_invalid). */
export function parseOpinion(raw: string): Opinion | null {
  const parsed = opinionSchema.safeParse(looseJson(raw));
  return parsed.success ? parsed.data : null;
}
export const hasCritical = (opinions: Opinion[]) => opinions.some(opinion => opinion.issues.some(issue => issue.severity === 'critical'));

/** Field values per step: {stepId: {fieldId: value}}. */
export type StepValues = Record<string, Record<string, string>>;
export type DeclaredStep = { stepId: string; fieldIds: string[] };
export type RevisionInput = {
  /** The previous version: the reviewed report in round 1, else the last revision that passed. */
  previousBody: string; previousSteps: StepValues;
  /** Frozen field values of the reviewed formal version (R14 compares against these). */
  frozenSteps: StepValues;
  declared: DeclaredStep[]; sections: string[]; maxCharacters: number;
};
export type RevisionResult =
  | { ok: true; body: string; steps: StepValues; changedSections: string[]; changeNotes: ChangeNote[];
      /** Field changes relative to the formal version, grouped for R14 (values 1–400 characters). */
      r14Fields: StepValues }
  | { ok: false; reason: string };
type ChangeNote = { section: string; wordingOnly: boolean; note: string; fields: Array<{ stepId: string; fieldId: string }> };
const revisionSchema = z.object({
  body: z.string(),
  steps: z.array(z.object({ stepId: z.string(), fields: z.array(z.object({ fieldId: z.string(), value: z.string(),
    changed: z.boolean() }).strip()) }).strip()),
  changeNotes: z.array(z.object({ section: z.string(), wordingOnly: z.boolean(), note: z.string().default(''),
    fields: z.array(z.object({ stepId: z.string(), fieldId: z.string() }).strip()).default([]) }).strip()),
}).strip();
const FIELD_LIMIT = 400;
const length = (value: string) => [...value].length;

/** "## Title" sections in order; null when the body does not have exactly the template sections. */
export function reportSections(body: string, sections: string[], maxCharacters: number): Map<string, string> | null {
  if (length(body) > maxCharacters) return null;
  const parts = body.split(/^##[ \t]+([^\r\n]+)\r?$/m);
  const titles = parts.filter((_, index) => index % 2 === 1).map(title => title.trim());
  if (titles.length !== sections.length || titles.some((title, index) => title !== sections[index])) return null;
  const map = new Map<string, string>();
  titles.forEach((title, index) => map.set(title, (parts[index * 2 + 2] ?? '').trim()));
  return [...map.values()].every(content => content.length > 0) ? map : null;
}

/** The summary's revision (§2.2 第 1 层): template sections, every declared step and field exactly once,
 * `changed` against the previous version, and every changed section declared consistently in changeNotes. */
export function checkRevision(raw: string, input: RevisionInput): RevisionResult {
  const parsed = revisionSchema.safeParse(looseJson(raw));
  if (!parsed.success) return { ok: false, reason: 'REVISION_FORMAT' };
  const { body, changeNotes } = parsed.data;
  const now = reportSections(body, input.sections, input.maxCharacters);
  const before = reportSections(input.previousBody, input.sections, Number.MAX_SAFE_INTEGER);
  if (!now || !before) return { ok: false, reason: 'REVISION_SECTIONS' };
  const declared = new Map(input.declared.map(step => [step.stepId, new Set(step.fieldIds)]));
  const seen = new Set<string>();
  const steps: StepValues = {};
  const changed = new Set<string>();
  for (const step of parsed.data.steps) {
    const fieldIds = declared.get(step.stepId);
    if (!fieldIds || steps[step.stepId]) return { ok: false, reason: 'REVISION_STEPS' };
    steps[step.stepId] = {};
    for (const field of step.fields) {
      const key = `${step.stepId}\u0000${field.fieldId}`;
      if (!fieldIds.has(field.fieldId) || seen.has(key)) return { ok: false, reason: 'REVISION_FIELDS' };
      seen.add(key);
      const previous = input.previousSteps[step.stepId]?.[field.fieldId] ?? '';
      if (field.changed) {
        if (!field.value.trim() || length(field.value) > FIELD_LIMIT || field.value === previous) return { ok: false, reason: 'REVISION_CHANGED' };
        changed.add(key);
      } else if (field.value !== previous) return { ok: false, reason: 'REVISION_UNCHANGED' };
      steps[step.stepId]![field.fieldId] = field.value;
    }
  }
  const expected = input.declared.reduce((count, step) => count + step.fieldIds.length, 0);
  if (seen.size !== expected || Object.keys(steps).length !== declared.size) return { ok: false, reason: 'REVISION_FIELDS' };
  // 第 1 层: changed sections and changed fields must be declared consistently.
  const changedSections = input.sections.filter(title => now.get(title) !== before.get(title));
  const noted = new Set<string>();
  const notedFields = new Set<string>();
  for (const note of changeNotes) {
    if (!changedSections.includes(note.section) || noted.has(note.section)) return { ok: false, reason: 'REVISION_NOTES' };
    noted.add(note.section);
    if (note.wordingOnly ? note.fields.length > 0 : note.fields.length === 0) return { ok: false, reason: 'REVISION_NOTES' };
    for (const field of note.fields) {
      const key = `${field.stepId}\u0000${field.fieldId}`;
      if (!changed.has(key)) return { ok: false, reason: 'REVISION_NOTES' };
      notedFields.add(key);
    }
  }
  if (noted.size !== changedSections.length || notedFields.size !== changed.size) return { ok: false, reason: 'REVISION_NOTES' };
  // Relative to the formal version (round-1 changes kept in round 2 are included, §2.2).
  const r14Fields: StepValues = {};
  for (const [stepId, fields] of Object.entries(steps)) {
    for (const [fieldId, value] of Object.entries(fields)) {
      if (value === (input.frozenSteps[stepId]?.[fieldId] ?? '')) continue;
      if (!value.trim() || length(value) > FIELD_LIMIT) return { ok: false, reason: 'REVISION_FIELDS' };
      (r14Fields[stepId] ??= {})[fieldId] = value;
    }
  }
  return { ok: true, body, steps, changedSections, changeNotes, r14Fields };
}
