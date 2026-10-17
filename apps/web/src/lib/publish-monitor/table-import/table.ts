/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { inspectZip } from '@/lib/library-sandbox/docx/zip-guard';
import { checkXmlPart } from '@/lib/library-sandbox/docx/xml-guard';
import { SandboxError } from '@/lib/library-sandbox/errors';

/**
 * PUBLISH-MONITOR PR-3b (plan §4.3): reads a platform's backend export (CSV or XLSX) into a plain grid, in the
 * browser. Untrusted input: the file size, rows, columns and cell length are capped, and XLSX goes through the
 * library sandbox's ZIP guard (every member inflated under a hard cap, ratio and entry limits: no zip bombs) and XML
 * guard (no DTD or entities, bounded depth) before anything reads it. No third-party parser (adding one is high risk).
 */
export const TABLE_LIMITS = {
  maxFileBytes: 5_000_000,
  /** Header row excluded. */
  maxRows: 1_000,
  maxColumns: 50,
  maxCellChars: 2_000,
} as const;

export type TableErrorCode = 'TABLE_EMPTY' | 'TABLE_TOO_LARGE' | 'TABLE_TOO_MANY_ROWS' | 'TABLE_TOO_MANY_COLUMNS'
  | 'TABLE_CELL_TOO_LONG' | 'TABLE_ENCODING' | 'TABLE_MALFORMED' | 'TABLE_FORMAT_UNSUPPORTED';
export class TableImportError extends Error {
  constructor(readonly code: TableErrorCode) { super(code); }
}
const fail = (code: TableErrorCode): never => { throw new TableImportError(code); };

/** First row is the header; every row has exactly `header.length` cells (missing cells are ''). */
export type Grid = { header: string[]; rows: string[][];
  /** XLSX only: the workbook counts date serials from 1904 (workbookPr date1904), not from 1900. */
  date1904?: boolean };

function finish(lines: string[][]): Grid {
  const nonEmpty = lines.filter(line => line.some(cell => cell.trim() !== ''));
  if (nonEmpty.length === 0) fail('TABLE_EMPTY');
  const [header, ...rows] = nonEmpty;
  if (rows.length > TABLE_LIMITS.maxRows) fail('TABLE_TOO_MANY_ROWS');
  const width = Math.max(...nonEmpty.map(line => line.length));
  if (width > TABLE_LIMITS.maxColumns) fail('TABLE_TOO_MANY_COLUMNS');
  const pad = (line: string[]) => Array.from({ length: width }, (_, i) => (line[i] ?? '').trim());
  return { header: pad(header!), rows: rows.map(pad) };
}

function checkCell(cell: string): string {
  if (cell.length > TABLE_LIMITS.maxCellChars) fail('TABLE_CELL_TOO_LONG');
  return cell;
}

/** UTF-8 (with or without BOM) first; Chinese platform exports are often GB18030/GBK instead. */
function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    try { return new TextDecoder('gb18030', { fatal: true }).decode(bytes); } catch { return fail('TABLE_ENCODING'); }
  }
}

/** Separator counts outside quotes for each of the first records (a header alone can contain a stray comma). */
function separatorCounts(text: string, records = 5): Array<Record<string, number>> {
  const out: Array<Record<string, number>> = [];
  let counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (let i = 0; i < text.length && i < 262_144 && out.length < records; i += 1) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      if (Object.values(counts).some(n => n > 0)) out.push(counts);
      counts = { ',': 0, ';': 0, '\t': 0 };
    } else if (!quoted && ch in counts) counts[ch]! += 1;
  }
  if (out.length < records && Object.values(counts).some(n => n > 0)) out.push(counts);
  return out;
}

/**
 * The separator that splits the first records into the same number of columns (more than one), preferring the one
 * giving the most columns; plain text such as "Revenue, USD" in a semicolon file does not win, because its comma count
 * differs from record to record. Falls back to the most frequent separator, comma on a tie.
 */
function delimiterOf(text: string): string {
  const records = separatorCounts(text);
  const candidates = [',', ';', '\t'];
  const consistent = candidates.filter(d => records.length > 0 && records.every(r => r[d] === records[0]![d] && r[d]! > 0));
  const pool = consistent.length ? consistent : candidates;
  const first = records[0] ?? { ',': 0, ';': 0, '\t': 0 };
  return pool.reduce((best, d) => (first[d]! > first[best]! ? d : best), pool[0]!);
}

/** RFC 4180 CSV: quoted fields with doubled quotes and embedded newlines; comma, semicolon or tab delimited. */
export function parseCsv(bytes: Uint8Array): Grid {
  if (bytes.length === 0) fail('TABLE_EMPTY');
  if (bytes.length > TABLE_LIMITS.maxFileBytes) fail('TABLE_TOO_LARGE');
  const text = decodeText(bytes);
  const delimiter = delimiterOf(text);
  const lines: string[][] = [];
  let line: string[] = [];
  let cell = '';
  let quoted = false;
  const endCell = () => { line.push(checkCell(cell)); cell = ''; if (line.length > TABLE_LIMITS.maxColumns) fail('TABLE_TOO_MANY_COLUMNS'); };
  const endLine = () => {
    endCell();
    lines.push(line);
    line = [];
    // Header plus the row cap, plus slack for blank lines that finish() drops.
    if (lines.length > TABLE_LIMITS.maxRows * 2 + 1) fail('TABLE_TOO_MANY_ROWS');
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      if (cell.length > TABLE_LIMITS.maxCellChars) fail('TABLE_CELL_TOO_LONG');
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delimiter) endCell();
    else if (ch === '\n') endLine();
    else if (ch === '\r') { if (text[i + 1] !== '\n') endLine(); }
    else cell += ch;
  }
  if (quoted) fail('TABLE_MALFORMED');
  if (cell !== '' || line.length > 0) endLine();
  return finish(lines);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_, ref: string) => {
    if (ref[0] !== '#') return ENTITIES[ref]!;
    const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** Text of every <t> run, skipping phonetic guides (<rPh>). */
function runText(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)]
    .map(match => unescapeXml(match[1] ?? '')).join('');
}

function attribute(tag: string, name: string): string | null {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
}

/** Column index from a cell reference such as "AB12" (A = 0). */
function columnOf(ref: string | null, fallback: number): number {
  const letters = ref ? /^([A-Z]{1,3})\d+$/.exec(ref)?.[1] : undefined;
  if (!letters) return fallback;
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
}

function part(parts: Map<string, Uint8Array>, name: string): string | null {
  const bytes = parts.get(name);
  return bytes ? checkXmlPart(bytes) : null;
}

/** The first worksheet of the workbook, following workbook.xml and its relationships. */
function firstSheetName(parts: Map<string, Uint8Array>): string {
  const workbook = part(parts, 'xl/workbook.xml') ?? fail('TABLE_FORMAT_UNSUPPORTED');
  const sheet = /<sheet\b[^>]*>/.exec(workbook)?.[0] ?? fail('TABLE_EMPTY');
  const id = attribute(sheet, 'r:id') ?? fail('TABLE_MALFORMED');
  const rels = part(parts, 'xl/_rels/workbook.xml.rels') ?? fail('TABLE_MALFORMED');
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(tag => attribute(tag, 'Id') === id);
  const target = rel ? attribute(rel, 'Target') : null;
  if (!target) return fail('TABLE_MALFORMED');
  const name = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  // Only a plain worksheet path inside the package; anything else is not followed.
  if (!/^xl\/worksheets\/[A-Za-z0-9_.-]+\.xml$/.test(name)) fail('TABLE_MALFORMED');
  return name;
}

/** Built-in percentage number formats (0%, 0.00%) and any custom format containing a percent sign. */
const BUILTIN_PERCENT_FORMATS = new Set([9, 10]);
function percentStyleIndexes(styles: string | null): Set<number> {
  const found = new Set<number>();
  if (!styles) return found;
  const percentFormats = new Set(BUILTIN_PERCENT_FORMATS);
  for (const fmt of styles.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attribute(fmt[0], 'numFmtId'));
    const code = unescapeXml(attribute(fmt[0], 'formatCode') ?? '');
    // A percent sign outside quoted literal text.
    if (Number.isInteger(id) && /%/.test(code.replace(/"[^"]*"/g, ''))) percentFormats.add(id);
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((xf, index) => {
    if (percentFormats.has(Number(attribute(xf[0], 'numFmtId')))) found.add(index);
  });
  return found;
}

/** XLSX (Office Open XML spreadsheet), first worksheet only; formulas are read as their cached values. */
export async function parseXlsx(bytes: Uint8Array): Promise<Grid> {
  if (bytes.length === 0) fail('TABLE_EMPTY');
  if (bytes.length > TABLE_LIMITS.maxFileBytes) fail('TABLE_TOO_LARGE');
  let parts: Map<string, Uint8Array>;
  try {
    parts = (await inspectZip(bytes)).xmlParts;
    const shared = part(parts, 'xl/sharedStrings.xml');
    const strings = shared ? [...shared.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)].map(m => runText(m[1] ?? '')) : [];
    const sheet = part(parts, firstSheetName(parts)) ?? fail('TABLE_MALFORMED');
    const percentStyles = percentStyleIndexes(part(parts, 'xl/styles.xml'));
    const lines: string[][] = [];
    for (const row of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g)) {
      const rowIndex = Number(attribute(row[0].slice(0, row[0].indexOf('>') + 1), 'r') ?? lines.length + 1) - 1;
      if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex > TABLE_LIMITS.maxRows * 2) fail('TABLE_TOO_MANY_ROWS');
      const line: string[] = [];
      let next = 0;
      for (const cell of (row[1] ?? '').matchAll(/<c\b([^>]*?)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = ` ${cell[1] ?? cell[2] ?? ''}`;
        const column = columnOf(attribute(attrs, 'r'), next);
        if (column >= TABLE_LIMITS.maxColumns) fail('TABLE_TOO_MANY_COLUMNS');
        next = column + 1;
        const body = cell[3] ?? '';
        const type = attribute(attrs, 't');
        const value = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let text = '';
        if (type === 's') text = strings[Number(value)] ?? '';
        else if (type === 'inlineStr') text = runText(body);
        else if (type === 'b') text = value === '1' ? 'TRUE' : 'FALSE';
        else if (type !== 'e' && value !== undefined) {
          text = unescapeXml(value);
          // A percentage-formatted number is stored as a fraction (45% is 0.45): read it as the user sees it.
          const style = Number(attribute(attrs, 's') ?? -1);
          if (percentStyles.has(style) && /^-?\d+(\.\d+)?(E-?\d+)?$/i.test(text)) {
            text = `${Math.round(Number(text) * 100 * 1e6) / 1e6}%`;
          }
        }
        line[column] = checkCell(text);
      }
      lines[rowIndex] = Array.from({ length: line.length }, (_, i) => line[i] ?? '');
    }
    const workbook = part(parts, 'xl/workbook.xml') ?? '';
    const pr = /<workbookPr\b[^>]*>/.exec(workbook)?.[0] ?? '';
    const date1904 = /\sdate1904="(1|true)"/.test(pr);
    return { ...finish(Array.from({ length: lines.length }, (_, i) => lines[i] ?? [])), ...(date1904 ? { date1904 } : {}) };
  } catch (error) {
    if (error instanceof TableImportError) throw error;
    // Every ZIP or XML guard refusal (bomb, ratio, DTD, depth, encoding...) is an unreadable table to the user.
    if (error instanceof SandboxError) {
      throw new TableImportError(/SIZE|RATIO|COUNT/.test(error.code) ? 'TABLE_TOO_LARGE' : 'TABLE_MALFORMED');
    }
    throw new TableImportError('TABLE_MALFORMED');
  }
}

/** By file name and content: XLSX starts with a ZIP header, anything else is read as CSV text. */
export async function parseTable(name: string, bytes: Uint8Array): Promise<Grid> {
  // A real ZIP local-file header, not just text that happens to start with "PK".
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  if (/\.xlsx$/i.test(name) || zip) {
    if (!zip) fail('TABLE_MALFORMED');
    return parseXlsx(bytes);
  }
  if (/\.(csv|txt|tsv)$/i.test(name)) return parseCsv(bytes);
  return fail('TABLE_FORMAT_UNSUPPORTED');
}
