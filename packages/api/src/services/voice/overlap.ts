/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/*
 * VOICE-2 PR-3 (Owner 2026-11-14: "太像" = a run of 12 characters the same as the user's old pieces, and only those sentences are
 * rewritten): code finds the sentences of a draft that share a run of OVERLAP_CHARS units with the passages the model was shown,
 * and puts back only the rewrites that no longer do. Never the whole draft, never a second guess. A unit is a character for
 * Chinese, Japanese and Korean (and any mark), and a whole word for Latin-script text (controller 11-14: 12 English characters
 * are two or three common words); whitespace is ignored. A repeat spanning two sentences is not looked for (after launch).
 */
export const OVERLAP_CHARS = 12;
/** At most this many sentences are sent for rewriting (a longer list is a copied draft the rewrite call cannot fix cheaply). */
export const OVERLAP_MAX_SENTENCES = 12;

/** The units compared: a run of Latin-script letters or digits is one (a word, case ignored); any other character is one. */
export function overlapUnits(text: string): string[] {
  return (text.match(/[\p{Script=Latin}\p{N}'’]+|\S/gu) ?? []).map(unit => unit.toLowerCase());
}
const runKey = (units: readonly string[], at: number) => units.slice(at, at + OVERLAP_CHARS).join('\u0001');
/** Every run of OVERLAP_CHARS units of the sources. */
export function overlapIndex(sources: readonly string[]): Set<string> {
  const runs = new Set<string>();
  for (const source of sources) {
    const units = overlapUnits(source);
    for (let i = 0; i + OVERLAP_CHARS <= units.length; i++) runs.add(runKey(units, i));
  }
  return runs;
}
export function sharesRun(sentence: string, runs: ReadonlySet<string>): boolean {
  const units = overlapUnits(sentence);
  for (let i = 0; i + OVERLAP_CHARS <= units.length; i++) if (runs.has(runKey(units, i))) return true;
  return false;
}

/** The draft's sentences with their place in it: split after an end mark or at a line break, the marks kept. */
export function sentencesOf(text: string): Array<{ start: number; text: string }> {
  const out: Array<{ start: number; text: string }> = [];
  const pattern = /[^。！？!?…\n]+[。！？!?…]*|\n+/gu;
  for (const match of text.matchAll(pattern)) {
    if (match[0].trim()) out.push({ start: match.index, text: match[0] });
  }
  return out;
}

export type Overlap = { start: number; text: string };
/** The sentences sharing a run with the sources, in order (at most OVERLAP_MAX_SENTENCES). */
export function findOverlaps(draft: string, sources: readonly string[]): Overlap[] {
  if (!sources.length) return [];
  const runs = overlapIndex(sources);
  return sentencesOf(draft).filter(sentence => sharesRun(sentence.text, runs)).slice(0, OVERLAP_MAX_SENTENCES);
}

/** What the rewrite call is told: only the sentences, numbered; it answers a JSON object of number -> new sentence. */
export const REWRITE_INSTRUCTIONS = 'You rewrite single sentences of a draft. Each numbered sentence below repeats a run of words '
  + 'from the user\'s own old writing. Rewrite each one so it keeps its meaning and its place in the draft, in the same language, '
  + 'tone and length, but repeats no run of 12 or more characters from the old writing. Keep any leading spaces, list markers and '
  + 'the closing punctuation. Answer only a JSON object mapping each number to its new sentence, nothing else.';
export function rewriteInput(overlaps: readonly Overlap[], sources: readonly string[]): string {
  return '<old_writing>\n' + sources.join('\n---\n') + '\n</old_writing>\n<sentences>\n'
    + overlaps.map((item, index) => `${index + 1}. ${item.text.trim()}`).join('\n') + '\n</sentences>';
}

/** The draft with each overlapping sentence replaced by its rewrite, only where the rewrite parses, is not empty and shares no run
 * any more; `revised` counts the sentences actually replaced. */
export function applyRewrites(draft: string, overlaps: readonly Overlap[], answer: string, sources: readonly string[]):
  { text: string; revised: number } {
  let parsed: Record<string, unknown> = {};
  try {
    const trimmed = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const value: unknown = JSON.parse(trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1));
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch { return { text: draft, revised: 0 }; }
  const runs = overlapIndex(sources);
  let text = draft, shift = 0, revised = 0;
  overlaps.forEach((item, index) => {
    const next = parsed[String(index + 1)];
    if (typeof next !== 'string' || !next.trim() || sharesRun(next, runs)) return;
    // Keep the sentence's own leading whitespace (a line's indent or list layout), replace the rest.
    const lead = item.text.match(/^\s*/)![0];
    const replacement = lead + next.trim() + (item.text.match(/\s*$/)![0]);
    const at = item.start + shift;
    text = text.slice(0, at) + replacement + text.slice(at + item.text.length);
    shift += replacement.length - item.text.length;
    revised++;
  });
  return { text, revised };
}
