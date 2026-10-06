/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { assert } from './source.mjs';
const text = value => String(value ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export function valueAt(state, field) {
  return field.target === 'suggestion'
    ? state.information[field.stepId]?.meta?.[field.fieldId]?.suggestion?.value ?? ''
    : state.information[field.stepId]?.values?.[field.fieldId]?.value ?? '';
}
/** Literal matching is a reproducible first pass, not a semantic judge. Blind review
 * must check paraphrases/negation, grounding and all failures before locking scores. */
export function objectiveChecks(gold, before, after) {
  const checks = [];
  for (const [index, field] of gold.gold.entries()) {
    const value = valueAt(after, field), normalized = text(value);
    const prefix = `${index}:${field.stepId}/${field.fieldId}/${field.target}`;
    if (field.absent) checks.push({ id: prefix + ':absent', pass: !normalized, kind: 'absence' });
    for (const atom of field.required) checks.push({ id: prefix + ':' + atom.id, kind: 'required',
      meaning: atom.meaning, pass: atom.anyOf.some(term => normalized.includes(text(term))) });
    for (const [i, term] of field.forbidden.entries()) checks.push({ id: prefix + ':forbidden-' + i,
      kind: 'forbidden', meaning: term, pass: !normalized.includes(text(term)) });
  }
  const all = Object.keys(after.information).flatMap(stepId => after.information[stepId].schema.flatMap(field =>
    ['value', 'suggestion'].map(target => valueAt(after, { stepId, fieldId: field.id, target })))).join('\n');
  for (const [i, term] of gold.forbiddenEverywhere.entries()) checks.push({ id: `global-forbidden-${i}`,
    kind: 'forbidden', meaning: term, pass: !text(all).includes(text(term)) });
  if (gold.expectNoUserFactChange) {
    for (const field of before.information['step-1'].schema) {
      const f = { stepId: 'step-1', fieldId: field.id };
      for (const target of ['value', 'suggestion']) checks.push({ id: `no-user-fact:${field.id}:${target}`,
        kind: 'unchanged', pass: valueAt(before, { ...f, target }) === valueAt(after, { ...f, target }) });
    }
  }
  assert(checks.length > 0 && new Set(checks.map(c => c.id)).size === checks.length, 'SCORE_CHECK_IDS');
  return checks;
}
export function aggregate(scores) {
  assert(scores.length > 0, 'EMPTY_SCORES');
  const correct = scores.filter(s => s.correct).length;
  return { count: scores.length, correct, accuracy: correct / scores.length,
    protectedDirectChanged: scores.filter(s => s.protectedDirectChanged).length,
    formatErrors: scores.filter(s => s.formatError).length,
    points: scores.reduce((n, s) => n + s.checks.length, 0),
    pointsPassed: scores.reduce((n, s) => n + s.checks.filter(c => c.pass).length, 0) };
}
export function runStatistics(rows) {
  const runs = [1, 2, 3].map(run => {
    const selected = rows.filter(r => r.run === run);
    return selected.length ? { run, complete: selected.length === 100, ...aggregate(selected) }
      : { run, complete: false, count: 0, correct: null, accuracy: null };
  });
  const complete = runs.every(r => r.complete);
  const meanCorrect = complete ? runs.reduce((n, r) => n + r.correct, 0) / 3 : null;
  return { runs, meanCorrect,
    minCorrect: complete ? Math.min(...runs.map(r => r.correct)) : null,
    maxCorrect: complete ? Math.max(...runs.map(r => r.correct)) : null,
    sampleSdCorrect: complete ? Math.sqrt(runs.reduce((n, r) => n + (r.correct - meanCorrect) ** 2, 0) / 2) : null };
}
