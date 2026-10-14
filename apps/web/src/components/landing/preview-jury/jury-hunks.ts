/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * The before/after of a changed chapter, cut down to what changed: the text is split into sentences (a chapter is
 * prose, one sentence reads like one short paragraph), unchanged sentences far from any change fold away, and each
 * change keeps one unchanged sentence before and after it for context. A lone far sentence stays, since folding it
 * would save nothing.
 */
export type Hunk =
  | { type: 'context'; text: string }
  | { type: 'change'; before: string; after: string }
  | { type: 'folded'; count: number; text: string };

export function sentences(text: string): string[] {
  return text.match(/[^。！？；\n]+[。！？；]?/gu)?.map(item => item.trim()).filter(Boolean) ?? [];
}

type Step = { type: 'same'; text: string } | { type: 'del' | 'ins'; text: string };

function diffSentences(a: string[], b: string[]): Step[] {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { steps.push({ type: 'same', text: a[i] }); i += 1; j += 1; }
    else if (i < a.length && (j >= b.length || table[i + 1][j] >= table[i][j + 1])) { steps.push({ type: 'del', text: a[i] }); i += 1; }
    else { steps.push({ type: 'ins', text: b[j] }); j += 1; }
  }
  return steps;
}

export function changeHunks(before: string, after: string, context = 1): Hunk[] {
  // Runs of deletions and additions become one change; kept sentences stay as they are.
  const runs: ({ type: 'same'; text: string } | { type: 'change'; before: string[]; after: string[] })[] = [];
  for (const step of diffSentences(sentences(before), sentences(after))) {
    const last = runs[runs.length - 1];
    if (step.type === 'same') runs.push({ type: 'same', text: step.text });
    else if (last?.type === 'change') last[step.type === 'del' ? 'before' : 'after'].push(step.text);
    else runs.push({ type: 'change', before: step.type === 'del' ? [step.text] : [], after: step.type === 'ins' ? [step.text] : [] });
  }
  const near = (index: number) => runs.some((run, other) => run.type === 'change' && Math.abs(other - index) <= context);
  // Folding a single sentence saves nothing: a run of unchanged sentences folds only when two or more would hide.
  const foldable = (index: number) => {
    let start = index;
    let end = index;
    while (start > 0 && runs[start - 1].type === 'same' && !near(start - 1)) start -= 1;
    while (end < runs.length - 1 && runs[end + 1].type === 'same' && !near(end + 1)) end += 1;
    return end > start;
  };
  const hunks: Hunk[] = [];
  runs.forEach((run, index) => {
    if (run.type === 'change') {
      hunks.push({ type: 'change', before: run.before.join(''), after: run.after.join('') });
      return;
    }
    if (near(index) || !foldable(index)) { hunks.push({ type: 'context', text: run.text }); return; }
    const last = hunks[hunks.length - 1];
    if (last?.type === 'folded') { last.count += 1; last.text += run.text; }
    else hunks.push({ type: 'folded', count: 1, text: run.text });
  });
  return hunks;
}
