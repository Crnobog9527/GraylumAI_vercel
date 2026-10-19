/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { reportBodyText } from '../../shared/reportData';
import { ADJUDICATION_FORMAT, adjudicationSchema, checkFullRevision, FIELD_LIMIT, looseJson, reportSections, WHOLE_REPORT, type RevisionInput,
  type RevisionResult, type StepValues } from './hostChecks';

/**
 * The summary's revision in the section format (Owner 2026-10-20: "能用硬编码解决的问题，就不要靠大模型的智能和
 * token"). The model returns only the rulings, the replaced sections and the changed fields; the host builds the full
 * body from the original text, derives the changed sections and the change notes, and carries every unchanged field
 * over. Unchanged sections are byte-identical to the original by construction. The result has the same shape as the
 * full-body check, so judging, adoption, events and recovery are unchanged. A saved body in the old full-body format
 * (reviews before this change) is still judged by the old check.
 */
const sectionSchema = z.object({
  adjudication: z.array(adjudicationSchema).max(200),
  revisions: z.array(z.object({ section: z.string(), text: z.string() }).strip()).max(100),
  fieldChanges: z.array(z.object({ stepId: z.string(), fieldId: z.string(), value: z.string(),
    sections: z.array(z.string()).max(50) }).strip()).max(200),
}).strip();

const str = { type: 'string' } as const;
/** Strict response format of the section revision (sent with the summary request). */
export const SECTION_REVISION_FORMAT = { type: 'json_schema', json_schema: { name: 'review_section_revision', strict: true, schema: {
  type: 'object', additionalProperties: false, required: ['adjudication', 'revisions', 'fieldChanges'], properties: {
    adjudication: { type: 'array', items: ADJUDICATION_FORMAT },
    revisions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['section', 'text'],
      properties: { section: str, text: str } } },
    fieldChanges: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['stepId', 'fieldId', 'value', 'sections'], properties: { stepId: str, fieldId: str, value: str,
        sections: { type: 'array', items: str } } } } } } } } as const;

const length = (value: string) => [...value].length;
const title = (value: string) => value.replace(/^#+\s*/, '').trim();
const HEADING = /^##[ \t]+([^\r\n]+)\r?$/m;
const fail = (reason: string, detail: string): RevisionResult => ({ ok: false, reason, detail });

/** Full-body or section format, decided by the saved text itself (never by a setting that could change later). */
export function checkRevision(raw: string, input: RevisionInput): RevisionResult {
  const value = looseJson(raw);
  const sectioned = typeof value === 'object' && value !== null && Array.isArray((value as { revisions?: unknown }).revisions);
  return sectioned ? checkSectionRevision(value, input) : checkFullRevision(raw, input);
}

function checkSectionRevision(value: unknown, input: RevisionInput): RevisionResult {
  const parsed = sectionSchema.safeParse(value);
  if (!parsed.success) return fail('REVISION_FORMAT', '输出缺字段或格式不对（可能被截断）');
  const { adjudication, revisions, fieldChanges } = parsed.data;
  for (const item of adjudication) item.section = title(item.section);
  const badRuling = adjudication.find(item => !(input.sections.includes(item.section) || item.section === WHOLE_REPORT)
    || item.reviewers.some(reviewer => !/^[A-C]$/.test(reviewer)));
  if (badRuling) return fail('REVISION_ADJUDICATION', `裁决记录的章节「${badRuling.section}」不是给出的章节，或评审代号不是 A/B/C`);
  // The original split exactly as reportSections splits it, so the rebuilt body keeps every separator.
  const original = reportBodyText(input.previousBody);
  const parts = original.split(/^##[ \t]+([^\r\n]+)\r?$/m);
  const titles = parts.filter((_, index) => index % 2 === 1).map(item => item.trim());
  if (titles.length !== input.sections.length || titles.some((item, index) => item !== input.sections[index])) {
    return fail('REVISION_SECTIONS', '原报告的章节和模板对不上');
  }
  const replaced = new Map<string, string>();
  for (const revision of revisions) {
    const section = title(revision.section);
    if (!input.sections.includes(section)) return fail('REVISION_SECTIONS', `「${revision.section}」不是给出的章节标题`);
    if (replaced.has(section)) return fail('REVISION_SECTIONS', `章节「${section}」重复出现`);
    // The heading is the host's: a repeated heading line at the top is dropped; any other "## " line would split the body.
    const text = revision.text.replace(/^\s*##[ \t]+([^\r\n]+)\r?\n/, (line, heading: string) => (heading.trim() === section ? '' : line))
      .replace(/^\r?\n+/, '').replace(/\s+$/, '');
    if (!text.trim()) return fail('REVISION_SECTIONS', `章节「${section}」替换后是空的`);
    if (HEADING.test(text)) return fail('REVISION_SECTIONS', `章节「${section}」的正文里不能有 "## " 开头的行（小标题用 ### ）`);
    replaced.set(section, text);
  }
  const rebuilt = parts.map((part, index) => {
    if (index === 0 || index % 2 === 1) return part;
    const section = titles[(index - 2) / 2]!;
    const text = replaced.get(section);
    if (text === undefined) return part;
    // Keep the original's leading and trailing line breaks around the section content.
    const lead = /^\r?\n/.exec(part)?.[0] ?? '\n';
    const trail = /\r?\n$/.exec(part)?.[0] ?? '';
    return lead + text + trail;
  });
  const body = rebuilt.map((part, index) => (index % 2 === 1 ? `## ${part}` : part)).join('');
  const before = reportSections(original, input.sections, Number.MAX_SAFE_INTEGER);
  if (!before) return fail('REVISION_SECTIONS', '原报告有空章节');
  const now = reportSections(body, input.sections, input.maxCharacters);
  if (!now) {
    const total = length(reportBodyText(body));
    return fail('REVISION_SECTIONS', total > input.maxCharacters
      ? `修订后全文 ${total} 字，超过上限 ${input.maxCharacters} 字（多 ${total - input.maxCharacters} 字），请精简替换的章节`
      : '修订后有空章节');
  }
  const changedSections = input.sections.filter(section => now.get(section) !== before.get(section));
  // Steps: the previous values, with the declared changes applied. Each change must be real and point at changed sections.
  const declared = new Map(input.declared.map(step => [step.stepId, new Set(step.fieldIds)]));
  const steps: StepValues = Object.fromEntries(input.declared.map(step => [step.stepId,
    Object.fromEntries(step.fieldIds.map(fieldId => [fieldId, input.previousSteps[step.stepId]?.[fieldId] ?? '']))]));
  const seen = new Set<string>();
  const fieldsOf = new Map<string, Array<{ stepId: string; fieldId: string }>>();
  for (const change of fieldChanges) {
    const key = `${change.stepId}.${change.fieldId}`;
    if (!declared.get(change.stepId)?.has(change.fieldId)) return fail('REVISION_FIELDS', `字段 ${key} 不存在`);
    if (seen.has(key)) return fail('REVISION_FIELDS', `字段 ${key} 重复出现`);
    seen.add(key);
    const previous = input.previousSteps[change.stepId]?.[change.fieldId] ?? '';
    if (!change.value.trim() || length(change.value) > FIELD_LIMIT || change.value === previous) {
      return fail('REVISION_CHANGED', `字段 ${key} 的新值为空、超过 ${FIELD_LIMIT} 字或和原值相同`);
    }
    const sections = [...new Set(change.sections.map(title))];
    const unchanged = sections.find(section => !changedSections.includes(section));
    if (!sections.length || unchanged !== undefined) {
      return fail('REVISION_NOTES', `字段 ${key} 必须对应至少一个确实改过的章节${unchanged !== undefined ? `（「${unchanged}」没有改）` : ''}`);
    }
    steps[change.stepId]![change.fieldId] = change.value;
    for (const section of sections) fieldsOf.set(section, [...(fieldsOf.get(section) ?? []), { stepId: change.stepId, fieldId: change.fieldId }]);
  }
  // Change notes are derived: a section with a field pointing at it is a fact change, any other changed section wording only.
  const changeNotes = changedSections.map(section => {
    const fields = fieldsOf.get(section) ?? [];
    const note = adjudication.filter(item => item.section === section && item.adopted).map(item => item.fix).join('；');
    return { section, wordingOnly: fields.length === 0, note, fields };
  });
  const r14Fields: StepValues = {};
  for (const [stepId, fields] of Object.entries(steps)) {
    for (const [fieldId, value] of Object.entries(fields)) {
      if (value !== (input.frozenSteps[stepId]?.[fieldId] ?? '')) (r14Fields[stepId] ??= {})[fieldId] = value;
    }
  }
  return { ok: true, body, steps, changedSections, changeNotes, adjudication, r14Fields };
}
