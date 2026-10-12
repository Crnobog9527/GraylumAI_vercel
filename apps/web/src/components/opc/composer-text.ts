/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { JSONContent } from '@tiptap/core';
import { Fragment, Slice, type Node as ProseNode, type Schema } from '@tiptap/pm/model';

/**
 * The message box edits plain text: one paragraph per line, no marks.
 * These helpers convert between that document and the string the request APIs already take.
 */

export function normalizeLines(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

/** Plain text → editor document. Empty lines stay as empty paragraphs so the round trip is exact. */
export function textToDoc(text: string): JSONContent {
  return {
    type: 'doc',
    content: normalizeLines(text).split('\n').map(line =>
      line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' }),
  };
}

/** Editor document (or pasted fragment) → plain text, lines joined by a single newline. */
export function docToText(doc: Pick<ProseNode, 'textBetween' | 'content'>) {
  return doc.textBetween(0, doc.content.size, '\n');
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
