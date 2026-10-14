/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';

/** Host checks of FUSION-REVIEW §2.2: pure, deterministic functions over the saved text and the frozen
 * inputs, so recovery can redo them with the same result. They never call a model or the database. */

export const SEVERITIES = ['critical', 'major', 'minor'] as const;
/** The four key decisions every reviewer steelmans both ways (Owner 2026-10-14). */
export const DECISIONS = ['positioning', 'audience', 'platform', 'monetization'] as const;
export const VERDICTS = ['keep', 'change'] as const;
const text = (max: number) => z.string().trim().min(1).max(max);
const length = (value: string) => [...value].length;
const decisionSchema = z.object({ decision: z.enum(DECISIONS), strongestCase: text(2000), strongestAlternative: text(2000),
  verdict: z.enum(VERDICTS), basis: text(2000) }).strip();
const issueSchema = z.object({ location: text(200), perspective: text(200), problem: text(2000), suggestion: text(2000),
  severity: z.enum(SEVERITIES) }).strip();
const responseSchema = z.object({ reviewer: text(8), decision: z.enum(DECISIONS), strongestView: text(2000), stance: z.enum(['agree', 'disagree']),
  reason: text(2000) }).strip();
const rawOpinion = z.object({ decisions: z.array(decisionSchema).max(8), issues: z.array(issueSchema).max(50),
  responses: z.array(responseSchema).max(16).optional() }).strip();
export type Opinion = { decisions: Array<z.infer<typeof decisionSchema>>; issues: Array<z.infer<typeof issueSchema>>;
  responses?: Array<z.infer<typeof responseSchema>>;
  /** Vague issues the host dropped (wrong section, too short, or "why" equal to "how"). */
  dropped: number };

/** JSON response formats sent with each request (strict schema mode). */
const str = { type: 'string' } as const;
const decisionFormat = { type: 'object', additionalProperties: false,
  required: ['decision', 'strongestCase', 'strongestAlternative', 'verdict', 'basis'], properties: {
    decision: { type: 'string', enum: [...DECISIONS] }, strongestCase: str, strongestAlternative: str,
    verdict: { type: 'string', enum: [...VERDICTS] }, basis: str } } as const;
const issueFormat = { type: 'object', additionalProperties: false,
  required: ['location', 'perspective', 'problem', 'suggestion', 'severity'], properties: {
    location: str, perspective: str, problem: str, suggestion: str, severity: { type: 'string', enum: [...SEVERITIES] } } } as const;
const responseFormat = { type: 'object', additionalProperties: false, required: ['reviewer', 'decision', 'strongestView', 'stance', 'reason'],
  properties: { reviewer: str, decision: { type: 'string', enum: [...DECISIONS] }, strongestView: str,
    stance: { type: 'string', enum: ['agree', 'disagree'] }, reason: str } } as const;
export const OPINION_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'review_opinion', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['decisions', 'issues'], properties: {
    decisions: { type: 'array', items: decisionFormat }, issues: { type: 'array', items: issueFormat } } } } } as const;
/** Round 2 (only on disagreement): the same opinion plus a response to each other reviewer. */
export const DEBATE_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'review_debate', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['decisions', 'issues', 'responses'], properties: {
    decisions: { type: 'array', items: decisionFormat }, issues: { type: 'array', items: issueFormat },
    responses: { type: 'array', items: responseFormat } } } } } as const;
/** One ruling per merged issue, filed under a template section (or 全文 for the whole report) so the result can be
 * shown section by section: the panel's final view, why, how to change it, who raised it and whether they split. */
export const WHOLE_REPORT = '全文';
const adjudicationFormat = { type: 'object', additionalProperties: false,
  required: ['section', 'issue', 'reviewers', 'single', 'disputed', 'adopted', 'opinion', 'reason', 'fix'],
  properties: { section: str, issue: str, reviewers: { type: 'array', items: str }, single: { type: 'boolean' }, disputed: { type: 'boolean' },
    adopted: { type: 'boolean' }, opinion: str, reason: str, fix: str } } as const;
export const REVISION_RESPONSE_FORMAT = { type: 'json_schema', json_schema: { name: 'review_revision', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['adjudication', 'body', 'steps', 'changeNotes'], properties: {
    adjudication: { type: 'array', items: adjudicationFormat },
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

/** "Why" and "how" each need some substance; shorter is treated as vague. */
export const MIN_REASON_CHARACTERS = 20;
const squash = (value: string) => value.replace(/[\s\p{P}]/gu, '');

/** A review opinion, or null when it is not usable (the call is then judged format_invalid): all four key
 * decisions steelmanned exactly once (and, in a debate round, a response). Vague issues are dropped one by
 * one rather than failing the opinion: a section that is not a template title, a "why" or "how" under
 * MIN_REASON_CHARACTERS, or a "how" that only repeats the "why". */
export function parseOpinion(raw: string, rules: { sections: string[]; debate?: boolean;
  /** Debate round: every other reviewer × every disputed decision, each answered exactly once (#962 review). */
  responses?: Array<{ reviewer: string; decision: string }> }): Opinion | null {
  const parsed = rawOpinion.safeParse(looseJson(raw));
  if (!parsed.success) return null;
  const { decisions, issues, responses } = parsed.data;
  if (decisions.length !== DECISIONS.length || new Set(decisions.map(d => d.decision)).size !== DECISIONS.length) return null;
  if (rules.debate && !responses?.length) return null;
  if (rules.debate && rules.responses) {
    const expected = new Set(rules.responses.map(pair => `${pair.reviewer}:${pair.decision}`));
    const given = (responses ?? []).map(response => `${response.reviewer}:${response.decision}`);
    if (given.length !== expected.size || new Set(given).size !== given.length || given.some(key => !expected.has(key))) return null;
  }
  const kept = issues.filter(issue => rules.sections.includes(issue.location.replace(/^#+\s*/, '').trim())
    && length(issue.problem) >= MIN_REASON_CHARACTERS && length(issue.suggestion) >= MIN_REASON_CHARACTERS
    && squash(issue.problem) !== squash(issue.suggestion));
  return { decisions, issues: kept, ...(rules.debate ? { responses } : {}), dropped: issues.length - kept.length };
}

/** The key decisions reviewers split over (some keep, some change). */
export function disputedDecisions(opinions: Opinion[]): Array<(typeof DECISIONS)[number]> {
  return DECISIONS.filter(decision => new Set(opinions.map(o => o.decisions.find(d => d.decision === decision)?.verdict)).size > 1);
}

/** Reviewers disagree when, for one key decision, some keep it and some would change it (round 2 trigger). */
export function hasDisagreement(opinions: Opinion[]): boolean {
  return DECISIONS.some(decision => new Set(opinions.map(o => o.decisions.find(d => d.decision === decision)?.verdict)).size > 1);
}

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
  | { ok: true; body: string; steps: StepValues; changedSections: string[]; changeNotes: ChangeNote[]; adjudication: Adjudication[];
      /** Field changes relative to the formal version, grouped for R14 (values 1–400 characters). */
      r14Fields: StepValues }
  | { ok: false; reason: string };
type ChangeNote = { section: string; wordingOnly: boolean; note: string; fields: Array<{ stepId: string; fieldId: string }> };
export const adjudicationSchema = z.object({ section: z.string(), issue: z.string(), reviewers: z.array(z.string()),
  single: z.boolean(), disputed: z.boolean(), adopted: z.boolean(), opinion: z.string(), reason: z.string(), fix: z.string() }).strip();
export type Adjudication = z.infer<typeof adjudicationSchema>;
const revisionSchema = z.object({
  /** Kept for administrators reviewing real cases; checked for shape only. */
  adjudication: z.array(adjudicationSchema).max(200),
  body: z.string(),
  steps: z.array(z.object({ stepId: z.string(), fields: z.array(z.object({ fieldId: z.string(), value: z.string(),
    changed: z.boolean() }).strip()) }).strip()),
  changeNotes: z.array(z.object({ section: z.string(), wordingOnly: z.boolean(), note: z.string().default(''),
    fields: z.array(z.object({ stepId: z.string(), fieldId: z.string() }).strip()).default([]) }).strip()),
}).strip();
const FIELD_LIMIT = 400;

/** "## Title" sections in order; null when the body does not have exactly the template sections. */
export function reportSections(body: string, sections: string[], maxCharacters: number): Map<string, string> | null {
  if (length(body) > maxCharacters) return null;
  const parts = body.split(/^##[ \t]+([^\r\n]+)\r?$/m);
  const titles = parts.filter((_, index) => index % 2 === 1).map(title => title.trim());
  if (titles.length !== sections.length || titles.some((title, index) => title !== sections[index])) return null;
  const map = new Map<string, string>();
  // Raw contents are compared, so even a spacing or blank-line change must be declared (#962 review); only the
  // non-empty test trims.
  // Only the line break that ends the heading line and the one before the next heading are separators.
  titles.forEach((title, index) => map.set(title, (parts[index * 2 + 2] ?? '').replace(/^\r?\n/, '').replace(/\r?\n$/, '')));
  return [...map.values()].every(content => content.trim().length > 0) ? map : null;
}

/** The summary's revision (§2.2 第 1 层): template sections, every declared step and field exactly once,
 * `changed` against the previous version, and every changed section declared consistently in changeNotes. */
export function checkRevision(raw: string, input: RevisionInput): RevisionResult {
  const parsed = revisionSchema.safeParse(looseJson(raw));
  if (!parsed.success) return { ok: false, reason: 'REVISION_FORMAT' };
  const { body, changeNotes, adjudication } = parsed.data;
  // Every ruling is filed under a template section (or the whole report) and names only seats A/B/C.
  for (const item of adjudication) item.section = item.section.replace(/^#+\s*/, '').trim();
  if (adjudication.some(item => !(input.sections.includes(item.section) || item.section === WHOLE_REPORT)
    || item.reviewers.some(reviewer => !/^[A-C]$/.test(reviewer)))) return { ok: false, reason: 'REVISION_ADJUDICATION' };
  const now = reportSections(body, input.sections, input.maxCharacters);
  const before = reportSections(input.previousBody, input.sections, Number.MAX_SAFE_INTEGER);
  if (!now || !before) return { ok: false, reason: 'REVISION_SECTIONS' };
  // Text before the first heading belongs to no section and cannot be chosen per section: it must stay as it was
  // (#962 review), so what the user sees is exactly what adoption rebuilds.
  const preamble = (text: string) => text.split(/^##[ \t]+[^\r\n]+\r?$/m)[0] ?? '';
  if (preamble(body) !== preamble(input.previousBody)) return { ok: false, reason: 'REVISION_PREAMBLE' };
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
  return { ok: true, body, steps, changedSections, changeNotes, adjudication, r14Fields };
}
