/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { REPORT_DATA_FENCE } from './reportData';
import { REPORT_DATA_FIELDS, REPORT_DATA_FIELD_NAMES, REPORT_DATA_LIMITS, REPORT_DATA_VERSION, TEXT_MAX, type Spec } from './reportDataSpec';

/**
 * REPORT-VISUAL §7.1: the host's fixed instructions for the strategy data block, generated from the shared field
 * definitions (never written by hand), appended only when the Skill manifest declares `data`. The block's format is
 * the host's contract with its own validator; what each chapter says and how long it is stays with the Skill.
 */

/** One spec as a compact shape the model can copy: keys, enum codes, list sizes, text limits. */
export function specShape(spec: Spec): string {
  switch (spec.kind) {
  case 'text': return `text≤${spec.max ?? TEXT_MAX}${spec.optional ? '?' : ''}`;
  case 'int': return `int ${spec.min}-${spec.max}`;
  case 'enum': return Object.keys(spec.values).map(code => JSON.stringify(code)).join('|') + (spec.optional ? '?' : '');
  case 'list': return `[${specShape(spec.of)}] ${spec.min}-${spec.max} items${spec.optional ? '?' : ''}`;
  case 'object': return '{' + Object.entries(spec.fields).map(([key, child]) => `${key}${child.optional ? '?' : ''}: ${specShape(child)}`)
    .join(', ') + '}' + (spec.optional ? '?' : '');
  }
}

export function reportDataInstructions(maxCharacters: number): string {
  return [
    `Strategy data (host format, version ${REPORT_DATA_VERSION}): after the last chapter, end the reply with one fenced block that starts `
      + `with the line ${REPORT_DATA_FENCE} and ends with a line of three backticks. Inside it write one JSON object per line, one line `
      + `per field: {"v":${REPORT_DATA_VERSION},"field":"<name>","value":<value>}. Nothing else inside the block, nothing after it.`,
    `The ${maxCharacters}-character limit is for the report text only; the block is extra, at most ${REPORT_DATA_LIMITS.characters} `
      + 'characters of text in all values together.',
    'The data and the text must say the same thing. Lists and tables that are in the data are not repeated item by item in the '
      + 'text: the text gives the conclusion, one sentence that sums up each list, and the reasons.',
    'All values are plain text (no Markdown, links or HTML), lengths in characters; "?" marks an optional key. Fields:',
    ...REPORT_DATA_FIELD_NAMES.map(field => `${field}: ${specShape(REPORT_DATA_FIELDS[field] as Spec)}`),
    'benchmarks.accounts: only accounts from the host benchmark table, platform and account copied exactly; never write numbers, '
      + 'the host adds them. Without a qualified benchmark, leave accounts empty and fill todo.',
    'Never put follower, revenue or timing promises in the data.',
  ].join('\n');
}
