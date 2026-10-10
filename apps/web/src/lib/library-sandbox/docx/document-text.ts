/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { MAX_EMBEDDED_IMAGES, MAX_HEADING_CHARS, MAX_HEADINGS, SANDBOX_LIMITS } from '../limits';
import type { HeaderFooterText } from './header-footer';

/**
 * Turns mammoth's document tree (its public `transformDocument` element model) into plain text with
 * heading structure. Layout: page header lines, body (paragraphs, list items, table rows with
 * tab-separated cells), footnotes/endnotes as `[n] text`, then page footer lines; one line each.
 * Hyperlink targets are dropped (only the visible text is kept) and never followed.
 */

export type DocxNode = {
  type: string;
  children?: DocxNode[];
  value?: string;
  styleId?: string | null;
  styleName?: string | null;
  numbering?: { isOrdered: boolean; level: string | number } | null;
  noteType?: string;
  noteId?: string;
  body?: DocxNode[];
  checked?: boolean;
  contentType?: string;
  readAsArrayBuffer?: () => Promise<ArrayBuffer | Uint8Array>;
};

export type DocxDocument = { children: DocxNode[]; notes?: { resolve(reference: DocxNode): DocxNode | null } };

/** `offset` is a JavaScript string index into `text`. */
export type DocxHeading = { level: number; text: string; offset: number };
export type DocxImage = { index: number; contentType: string; bytes: ArrayBuffer; offset: number };
export type DocxWarning = 'IMAGE_LIMIT' | 'EXTERNAL_IMAGE';
export type DocxExtraction = {
  text: string;
  headings: DocxHeading[];
  /** Embedded images in document order, kept for later recognition (LIB-2d); not recognised here. */
  images: DocxImage[];
  /** All images found, including ones over the per-file limit. */
  imageCount: number;
  warnings: DocxWarning[];
};

const HEADING_NAME = /^(?:heading|标题)\s*([1-9])$/i;
const HEADING_ID = /^heading([1-9])$/i;
const TITLE = /^(?:title|标题)$/i;

export function headingLevel(node: DocxNode): number | null {
  const name = node.styleName?.trim() ?? '';
  const byName = HEADING_NAME.exec(name)?.[1] ?? HEADING_ID.exec(node.styleId ?? '')?.[1];
  if (byName) return Number(byName);
  return TITLE.test(name) ? 1 : null;
}

function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/**
 * Images are marked in place while the text is built (`\uFDD0<n>\uFDD1`, noncharacters removed
 * from document text first), so each image keeps its exact position through list prefixes, table
 * cells and whitespace folding. The markers are stripped at the end and turned into offsets.
 */
const MARK_OPEN = '\uFDD0';
const MARK_CLOSE = '\uFDD1';
const MARKER = /\uFDD0(\d+)\uFDD1/g;
const SENTINELS = /[\uFDD0\uFDD1]/g;
const visible = (text: string) => text.replace(MARKER, '');

class TextBuilder {
  private parts: string[] = [];
  private length = 0;
  private bytes = 0;
  private rawHeadings: DocxHeading[] = [];
  readonly pendingImages: DocxNode[] = [];
  imageCount = 0;
  private notes: DocxNode[] = [];
  private noteNumbers = new Map<string, number>();
  private listCounters: number[] = [];

  constructor(private readonly document: DocxDocument) {}

  get offset(): number {
    return this.length;
  }

  line(text: string) {
    this.append(`${text}\n`);
  }

  private append(value: string) {
    this.bytes += utf8Length(value);
    if (this.bytes > SANDBOX_LIMITS.maxTextBytes) throw new SandboxError('TEXT_TOO_LARGE');
    this.parts.push(value);
    this.length += value.length;
  }

  /** Final text with markers removed; heading offsets shifted and image offsets resolved to match. */
  finish(): { text: string; headings: DocxHeading[]; imageOffsets: number[] } {
    const raw = this.parts.join('').replace(/\n+$/, '');
    const imageOffsets: number[] = [];
    const removed: { at: number; length: number }[] = [];
    let text = '';
    let last = 0;
    for (const match of raw.matchAll(MARKER)) {
      text += raw.slice(last, match.index);
      imageOffsets[Number(match[1])] = text.length;
      removed.push({ at: match.index, length: match[0].length });
      last = match.index + match[0].length;
    }
    text += raw.slice(last);
    const shift = (offset: number) => removed.reduce((sum, item) => sum + (item.at < offset ? item.length : 0), 0);
    const headings = this.rawHeadings.map((heading) =>
      ({ ...heading, offset: Math.min(heading.offset - shift(heading.offset), text.length) }));
    return { text, headings, imageOffsets: imageOffsets.map((offset) => Math.min(offset, text.length)) };
  }

  blocks(nodes: DocxNode[] | undefined) {
    for (const node of nodes ?? []) {
      if (node.type === 'paragraph') this.paragraph(node);
      else if (node.type === 'table') this.table(node);
      else this.blocks(node.children);
    }
  }

  private paragraph(node: DocxNode) {
    const start = this.offset;
    const level = headingLevel(node);
    let text = this.inline(node.children).replace(/[ \t]+$/, '');
    if (!visible(text).trim()) {
      // A picture-only paragraph adds no line; its image sits at the start of the next one.
      const markers = text.match(MARKER);
      if (markers) this.append(markers.join(''));
      this.listCounters = [];
      return;
    }
    if (level !== null) {
      this.listCounters = [];
      if (this.rawHeadings.length >= MAX_HEADINGS) throw new SandboxError('TEXT_TOO_LARGE');
      const title = visible(text).replace(/\s+/g, ' ').trim().slice(0, MAX_HEADING_CHARS);
      this.rawHeadings.push({ level, text: title, offset: start });
    } else if (node.numbering) {
      text = this.listPrefix(node.numbering) + text;
    } else {
      this.listCounters = [];
    }
    this.line(text);
  }

  /** Word stores list numbers as rules, not text: contiguous items are counted per level. */
  private listPrefix(numbering: NonNullable<DocxNode['numbering']>): string {
    const level = Math.min(Math.max(Number(numbering.level) || 0, 0), 8);
    this.listCounters.length = level + 1;
    this.listCounters[level] = (this.listCounters[level] ?? 0) + 1;
    return numbering.isOrdered ? `${this.listCounters[level]}. ` : '• ';
  }

  private table(node: DocxNode) {
    this.listCounters = [];
    for (const row of node.children ?? []) {
      const line = (row.children ?? []).map((cell) => this.flatten(cell.children)).join('\t');
      const markers = line.match(MARKER);
      if (visible(line).trim()) this.line(line);
      else if (markers) this.append(markers.join(''));
    }
  }

  /** Paragraphs, nested tables and notes inside one cell or note, on a single line. */
  private flatten(nodes: DocxNode[] | undefined): string {
    const pieces: string[] = [];
    for (const node of nodes ?? []) {
      if (node.type === 'paragraph') pieces.push(this.inline(node.children));
      else if (node.type === 'table' || node.type === 'tableRow' || node.type === 'tableCell') {
        pieces.push(this.flatten(node.children));
      } else pieces.push(this.inline([node]));
    }
    return pieces.map((piece) => piece.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
  }

  private inline(nodes: DocxNode[] | undefined): string {
    let text = '';
    for (const node of nodes ?? []) {
      switch (node.type) {
        case 'text':
          text += (node.value ?? '').replace(SENTINELS, '');
          break;
        case 'tab':
          text += '\t';
          break;
        case 'break':
          text += '\n';
          break;
        case 'checkbox':
          text += node.checked ? '☑' : '☐';
          break;
        case 'noteReference':
          text += this.noteMark(node);
          break;
        case 'image':
          this.imageCount += 1;
          if (this.pendingImages.length < MAX_EMBEDDED_IMAGES) {
            text += `${MARK_OPEN}${this.pendingImages.length}${MARK_CLOSE}`;
            this.pendingImages.push(node);
          }
          break;
        case 'paragraph':
        case 'table':
          text += ` ${this.flatten([node])} `;
          break;
        default:
          text += this.inline(node.children);
      }
    }
    return text;
  }

  private noteMark(reference: DocxNode): string {
    const key = `${reference.noteType}-${reference.noteId}`;
    let number = this.noteNumbers.get(key);
    if (number === undefined) {
      const note = this.document.notes?.resolve(reference) ?? null;
      if (!note) return '';
      number = this.notes.length + 1;
      this.noteNumbers.set(key, number);
      this.notes.push(note);
    }
    return `[${number}]`;
  }

  noteLines() {
    for (let i = 0; i < this.notes.length; i += 1) {
      const body = this.flatten(this.notes[i].body);
      if (visible(body)) this.line(`[${i + 1}] ${body}`);
      else if (body) this.append(body);
    }
  }
}

function copyBytes(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const view = value instanceof Uint8Array ? value : new Uint8Array(value);
  return view.slice().buffer;
}

async function readImages(builder: TextBuilder, offsets: number[], warnings: Set<DocxWarning>): Promise<DocxImage[]> {
  if (builder.imageCount > MAX_EMBEDDED_IMAGES) warnings.add('IMAGE_LIMIT');
  const images: DocxImage[] = [];
  for (const [position, node] of builder.pendingImages.entries()) {
    try {
      const bytes = await node.readAsArrayBuffer?.();
      if (!bytes) throw new Error('missing');
      const offset = offsets[position] ?? 0;
      images.push({ index: images.length, contentType: node.contentType || 'application/octet-stream', bytes: copyBytes(bytes), offset });
    } catch {
      warnings.add('EXTERNAL_IMAGE');
    }
  }
  return images;
}

export async function documentText(document: DocxDocument, pageText: HeaderFooterText): Promise<DocxExtraction> {
  const builder = new TextBuilder(document);
  for (const line of pageText.headers) builder.line(line);
  builder.blocks(document.children);
  builder.noteLines();
  for (const line of pageText.footers) builder.line(line);
  const warnings = new Set<DocxWarning>();
  const { text, headings, imageOffsets } = builder.finish();
  const images = await readImages(builder, imageOffsets, warnings);
  return { text, headings, images, imageCount: builder.imageCount, warnings: [...warnings] };
}
