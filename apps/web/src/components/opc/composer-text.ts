/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { JSONContent } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseNode, type Schema } from '@tiptap/pm/model';
import { REFERENCE_NODE, referenceLeafText, type LibraryReference } from './composer-references';

/**
 * The message box edits plain text: one paragraph per line, no marks.
 * These helpers convert between that document and the string the request APIs already take.
 */

export function normalizeLines(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

/**
 * Plain text → editor document. Empty lines stay as empty paragraphs so the round trip is exact.
 * `references` (UI-B) turns each `@名称` of a known reference back into its reference, so a restored draft or a
 * failed send keeps the document ids and versions; `docToText` of the result is `text` again.
 */
export function textToDoc(text: string, references: readonly LibraryReference[] = []): JSONContent {
  const line = referenceLine(references);
  return {
    type: 'doc',
    content: normalizeLines(text).split('\n').map(item =>
      item ? { type: 'paragraph', content: line(item) } : { type: 'paragraph' }),
  };
}

const escapeLabel = (label: string) => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Splits one line into text and reference nodes; two documents with one name are restored in their order. */
function referenceLine(references: readonly LibraryReference[]): (line: string) => JSONContent[] {
  const labelled = references.filter(item => item.label);
  if (!labelled.length) return line => [{ type: 'text', text: line }];
  const byLabel = new Map<string, LibraryReference[]>();
  for (const item of labelled) byLabel.set(item.label, [...byLabel.get(item.label) ?? [], item]);
  const used = new Map<string, number>();
  const pattern = new RegExp('@(' + [...byLabel.keys()].sort((a, b) => b.length - a.length).map(escapeLabel).join('|') + ')', 'g');
  return line => {
    const nodes: JSONContent[] = [];
    let at = 0;
    for (const match of line.matchAll(pattern)) {
      if (match.index > at) nodes.push({ type: 'text', text: line.slice(at, match.index) });
      const choices = byLabel.get(match[1])!, index = used.get(match[1]) ?? 0;
      used.set(match[1], index + 1);
      const { documentId, version, label } = choices[Math.min(index, choices.length - 1)];
      nodes.push({ type: REFERENCE_NODE, attrs: { documentId, version, label } });
      at = match.index + match[0].length;
    }
    if (at < line.length) nodes.push({ type: 'text', text: line.slice(at) });
    return nodes;
  };
}

/** Editor document → plain text, lines joined by a single newline; a reference reads as `@名称`. */
export function docToText(doc: Pick<ProseNode, 'textBetween' | 'content'>) {
  return doc.textBetween(0, doc.content.size, '\n', referenceLeafText);
}

/** Plain text of a range, counted the same way as `docToText`. */
export function rangeText(doc: Pick<ProseNode, 'textBetween'>, from: number, to: number) {
  return doc.textBetween(from, to, '\n', referenceLeafText);
}

/** Keep at most `room` UTF-16 units (the unit textarea maxLength counts), without splitting a surrogate pair. */
export function fitText(text: string, room: number) {
  if (room <= 0) return '';
  if (text.length <= room) return text;
  const cut = text.slice(0, room);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Pasted plain text → an open slice of paragraphs; first and last lines join the surrounding text. */
export function textToSlice(schema: Schema, text: string) {
  const lines = normalizeLines(text).split('\n');
  const paragraphs = lines.map(line => schema.nodes.paragraph.create(null, line ? schema.text(line) : null));
  return new Slice(Fragment.fromArray(paragraphs), 1, 1);
}
