/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {
  REPORT_DATA_FIELDS, REPORT_DATA_FIELD_NAMES, REPORT_DATA_GROUPS, REPORT_DATA_LIMITS, REPORT_DATA_VERSION, TEXT_MAX,
  type ReportDataField, type ReportDataGroup, type Spec,
} from './reportDataSpec';

/**
 * REPORT-VISUAL §3.2–3.3: the report body carries its strategy data in one fenced block at the end, one field
 * per line. This module splits the body from the block and validates the block field by field. A broken line
 * or field only loses that field; the report itself never fails because of its data. Pure: no server, no React.
 */

export const REPORT_DATA_FENCE = '```graylum-report-data';

type Infer<S> =
  S extends { kind: 'text' } ? string
  : S extends { kind: 'enum' } ? string
  : S extends { kind: 'int' } ? number
  : S extends { kind: 'list'; of: infer O } ? Infer<O>[]
  : S extends { kind: 'object'; fields: infer F } ? InferObject<F>
  : never;
type InferObject<F> =
  { [K in keyof F as F[K] extends { optional: true } ? never : K]: Infer<F[K]> }
  & { [K in keyof F as F[K] extends { optional: true } ? K : never]?: Infer<F[K]> };

/** The numbers the host takes from its own benchmark table (§3.3); never from the model. Null: not known. */
export type BenchmarkMetrics = {
  followers: number | null; medianViews: number | null; engagementRate: number | null;
  weeklyPosts: number | null; capturedAt: string | null;
};

type Fields = typeof REPORT_DATA_FIELDS;
export type ReportData = { [K in ReportDataField]?: Infer<Fields[K]> };
export type BenchmarkAccount = NonNullable<ReportData['benchmarks']>['accounts'][number] & { metrics?: BenchmarkMetrics | null };

export type SanitizedReportData = {
  v: typeof REPORT_DATA_VERSION;
  /** Only fields that passed every check, within every limit. */
  data: ReportData;
  /** Paths of what was left out (no content): `topics[3]`, `audience`, `#line4`. */
  dropped: string[];
  /** Fields that parsed but did not pass: their text only, for the page to list as plain text (never as data). */
  fallback: Partial<Record<ReportDataField, string[]>>;
};

export type ReportBodyParts = {
  /** The report as people read and edit it: everything except the data block. */
  text: string;
  /** The data block exactly as written (fences included), so an edit can put it back unchanged. */
  block: string | null;
  /** The block has started but not ended: still being written, or cut off. */
  pending: boolean;
};

const isFenceOpen = (line: string) => line.trim() === REPORT_DATA_FENCE;
const isFenceClose = (line: string) => line.trim() === '```';

/** Split a report body into its text and its data block (the first `graylum-report-data` block). */
export function splitReportBody(body: string): ReportBodyParts {
  const lines = body.split('\n');
  const open = lines.findIndex(isFenceOpen);
  if (open < 0) return { text: body, block: null, pending: false };
  const close = lines.findIndex((line, index) => index > open && isFenceClose(line));
  const before = lines.slice(0, open).join('\n').trimEnd();
  if (close < 0) return { text: before, block: null, pending: true };
  const after = lines.slice(close + 1).join('\n').trim();
  return { text: after ? `${before}\n\n${after}` : before, block: lines.slice(open, close + 1).join('\n'), pending: false };
}

/** The text alone: what the 12000-character limit and the editor count (Owner's choice B). */
export const reportBodyText = (body: string) => splitReportBody(body).text;

/** Put an unchanged data block back after edited text. */
export const joinReportBody = (text: string, block: string | null) => (block ? `${text.trimEnd()}\n\n${block}` : text);

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const plain = (value: string) => value.replace(/\r\n?/g, '\n').replace(CONTROL, '').trim();
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type Checked = { ok: true; value: unknown } | { ok: false };
const BAD: Checked = { ok: false };

/** Check one value against its spec. Optional parts and bad list items are dropped (recorded) without failing the parent. */
function check(spec: Spec, raw: unknown, path: string, dropped: string[]): Checked {
  switch (spec.kind) {
  case 'text': {
    if (typeof raw !== 'string') return BAD;
    const value = plain(raw);
    return value && [...value].length <= (spec.max ?? TEXT_MAX) ? { ok: true, value } : BAD;
  }
  case 'enum':
    return typeof raw === 'string' && Object.hasOwn(spec.values, raw) ? { ok: true, value: raw } : BAD;
  case 'int':
    return Number.isInteger(raw) && (raw as number) >= spec.min && (raw as number) <= spec.max ? { ok: true, value: raw } : BAD;
  case 'object': {
    if (!isRecord(raw)) return BAD;
    const value: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(spec.fields)) {
      const at = `${path}.${key}`;
      if (raw[key] === undefined || raw[key] === null) {
        if (child.optional) continue;
        return BAD;
      }
      const result = check(child, raw[key], at, dropped);
      if (result.ok) value[key] = result.value;
      else if (child.optional) dropped.push(at);
      else return BAD;
    }
    return { ok: true, value };
  }
  case 'list': {
    if (!Array.isArray(raw)) return BAD;
    const value: unknown[] = [];
    const local: string[] = [];
    raw.forEach((item, index) => {
      const at = `${path}[${index}]`;
      if (index >= spec.max) return void local.push(at);
      const result = check(spec.of, item, at, local);
      if (result.ok) value.push(result.value);
      else local.push(at);
    });
    if (value.length < spec.min) return BAD;
    dropped.push(...local);
    return { ok: true, value };
  }
  }
}

/** Every string inside a value, for showing a field that did not pass as plain text. */
function leafTexts(raw: unknown, out: string[] = []): string[] {
  if (out.length >= 40) return out;
  if (typeof raw === 'string') {
    const value = plain(raw);
    if (value) out.push([...value].slice(0, 200).join(''));
  } else if (Array.isArray(raw)) raw.forEach(item => leafTexts(item, out));
  else if (isRecord(raw)) Object.values(raw).forEach(item => leafTexts(item, out));
  return out;
}

/** Check one field's value; `undefined` when it does not pass. */
export function checkReportDataField(field: ReportDataField, raw: unknown, dropped: string[] = []) {
  const result = check(REPORT_DATA_FIELDS[field], raw, field, dropped);
  return result.ok ? result.value : undefined;
}

/** One row of the host's benchmark table (research_benchmark_rows, 0268): the only source of benchmark numbers. */
export type BenchmarkRow = {
  platform: string; account: string; followers: number | null; medianViews: number | null;
  engagementRate: number | null; postsPerWeek: number | null; fetchedAt: string | null;
};

export type ReportDataOptions = {
  /**
   * The host's benchmark table. `current`: it is the table the report was written from (same hash), so an account
   * not in it is dropped and the others get its numbers. Not current (refreshed since): names stay, numbers are null.
   * Omitted (the page before the server has checked): accounts are kept without numbers.
   */
  benchmarks?: { rows: readonly BenchmarkRow[]; current: boolean };
};

const accountKey = (value: string) => value.trim().toLowerCase();

/** Validate a data block (as `splitReportBody` returns it). */
export function parseReportDataBlock(block: string, options: ReportDataOptions = {}): SanitizedReportData {
  const data: Record<string, unknown> = {};
  const dropped: string[] = [];
  const fallback: Partial<Record<ReportDataField, string[]>> = {};
  const lines = block.split('\n').slice(1, -1);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let row: unknown;
    try { row = JSON.parse(line); } catch { return void dropped.push(`#line${index + 1}`); }
    if (!isRecord(row) || row.v !== REPORT_DATA_VERSION || typeof row.field !== 'string' || !Object.hasOwn(row, 'value')
      || !Object.hasOwn(REPORT_DATA_FIELDS, row.field)) return void dropped.push(`#line${index + 1}`);
    const field = row.field as ReportDataField;
    if (Object.hasOwn(data, field) || Object.hasOwn(fallback, field)) return void dropped.push(`${field}#duplicate`);
    const value = checkReportDataField(field, row.value, dropped);
    if (value === undefined) {
      dropped.push(field);
      const texts = leafTexts(row.value);
      if (texts.length) fallback[field] = texts;
    } else data[field] = value;
  });
  dropUnknownBenchmarks(data as ReportData, options, dropped);
  fitReportData(data as ReportData, dropped);
  return { v: REPORT_DATA_VERSION, data: data as ReportData, dropped, fallback };
}

function dropUnknownBenchmarks(data: ReportData, options: ReportDataOptions, dropped: string[]) {
  const table = options.benchmarks;
  if (!data.benchmarks || !table) return;
  const accounts: BenchmarkAccount[] = [];
  data.benchmarks.accounts.forEach((account, index) => {
    if (!table.current) return void accounts.push({ ...account, metrics: null });
    const same = table.rows.filter(row => accountKey(row.account) === accountKey(account.account));
    const row = same.find(item => accountKey(item.platform) === accountKey(account.platform)) ?? same[0];
    if (!row) return void dropped.push(`benchmarks.accounts[${index}]`);
    accounts.push({ ...account, metrics: { followers: row.followers, medianViews: row.medianViews,
      engagementRate: row.engagementRate, weeklyPosts: row.postsPerWeek, capturedAt: row.fetchedAt } });
  });
  data.benchmarks.accounts = accounts;
}

/** Parse a whole report body; `data` is null when there is no complete block. */
export function parseReportBody(body: string, options: ReportDataOptions = {}) {
  const parts = splitReportBody(body);
  return { ...parts, data: parts.block ? parseReportDataBlock(parts.block, options) : null };
}

/** The fields of one group, in the field order. */
export function reportDataGroup(data: ReportData, group: ReportDataGroup): ReportData {
  const out: Record<string, unknown> = {};
  for (const field of REPORT_DATA_GROUPS[group]) if (data[field] !== undefined) out[field] = data[field];
  return out as ReportData;
}

const encoder = new TextEncoder();
export const jsonBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

/** UTF-8 bytes of one group as JSON; an empty group takes no room. */
export function groupBytes(data: ReportData, group: ReportDataGroup) {
  const part = reportDataGroup(data, group);
  return Object.keys(part).length ? jsonBytes(part) : 0;
}

/** Characters of all the texts (keys and JSON punctuation do not count): the 9000-character limit. */
export function reportDataCharacters(value: unknown): number {
  if (typeof value === 'string') return [...value].length;
  if (Array.isArray(value)) return value.reduce((sum: number, item) => sum + reportDataCharacters(item), 0);
  if (isRecord(value)) return Object.values(value).reduce((sum: number, item) => sum + reportDataCharacters(item), 0);
  return 0;
}

export type ReportDataLimits = { contentBytes: number; businessBytes: number; characters: number };

type Step = { field: ReportDataField; fromEnd?: true };
const CONTENT_FIRST: Step[] = [{ field: 'adjustments' }, { field: 'routine' }, { field: 'compliance' }, { field: 'topics', fromEnd: true }];
const BUSINESS_FIRST: Step[] = [{ field: 'assumptions', fromEnd: true }, { field: 'roadmap' }, { field: 'upgrades' }];
/** §3.1: after the group's own order, the field table from the bottom up; `summary` and `thisWeek` last. */
const BOTTOM_UP: Step[] = [...[...REPORT_DATA_FIELD_NAMES].reverse().filter(field => field !== 'summary' && field !== 'thisWeek'),
  'thisWeek' as const, 'summary' as const].map(field => ({ field }));

const inGroup = (group: ReportDataGroup) => (step: Step) => (REPORT_DATA_GROUPS[group] as readonly string[]).includes(step.field);
const ORDERS: Record<'content' | 'business' | 'characters', Step[]> = {
  content: [...CONTENT_FIRST, ...BOTTOM_UP.filter(inGroup('content'))],
  business: [...BUSINESS_FIRST, ...BOTTOM_UP.filter(inGroup('business'))],
  characters: [...CONTENT_FIRST, ...BUSINESS_FIRST, ...BOTTOM_UP],
};

/** Which limit is broken now, if any. */
export function brokenReportDataLimit(data: ReportData, limits: ReportDataLimits = REPORT_DATA_LIMITS): keyof typeof ORDERS | null {
  if (groupBytes(data, 'content') > limits.contentBytes) return 'content';
  if (groupBytes(data, 'business') > limits.businessBytes) return 'business';
  if (reportDataCharacters(data) > limits.characters) return 'characters';
  return null;
}

/** Drop one step's worth: the last item of a `fromEnd` list (the whole field once at its minimum), or the field. */
function dropOne(data: ReportData, step: Step, dropped: string[]): boolean {
  const value = data[step.field];
  if (value === undefined) return false;
  const spec = REPORT_DATA_FIELDS[step.field];
  if (step.fromEnd && Array.isArray(value) && spec.kind === 'list' && value.length > spec.min) {
    dropped.push(`${step.field}[${value.length - 1}]`);
    value.pop();
    return true;
  }
  delete data[step.field];
  dropped.push(step.field);
  return true;
}

/**
 * Enforce the limits in place (§3.1): drop in the fixed order until every limit holds. The order reaches every
 * field, so this always ends (at worst with no data). Returns the same object.
 */
export function fitReportData(data: ReportData, dropped: string[] = [], limits: ReportDataLimits = REPORT_DATA_LIMITS): ReportData {
  for (let broken = brokenReportDataLimit(data, limits); broken; broken = brokenReportDataLimit(data, limits)) {
    const step = ORDERS[broken].find(candidate => data[candidate.field] !== undefined);
    if (!step || !dropOne(data, step, dropped)) break;
  }
  return data;
}

/** Whether a field is in the data (a list with items, or any other value). */
export const hasReportDataField = (data: ReportData | null | undefined, field: ReportDataField) => data?.[field] !== undefined;
