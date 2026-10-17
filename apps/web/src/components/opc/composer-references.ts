/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Node } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

/**
 * UI-B: `@` picks a library document and leaves an inline reference in the message box.
 * Off by default. References are kept apart from the text and travel in `runtime.prepare`'s own `references`
 * field (LIB-4b, #1022); the server switch `library_agent_read_enabled` must be on as well.
 */
// Next inlines NEXT_PUBLIC_* at build time; bundles without `process` (component test fixtures) read it as off.
export const COMPOSER_REFERENCES_ENABLED =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_COMPOSER_REFERENCES === 'on';

/** What LIB-4b reads: one document at one content version. The label is display only and never sent. */
export type LibraryReference = { documentId: string; version: number; label: string };

/** Distinct documents one message may reference (LIB-4b `LIBRARY_REFERENCE_LIMIT`). */
export const REFERENCE_LIMIT = 5;

/** The request field of `runtime.prepare`; absent (not `[]`) when there is nothing to send, so old requests stay byte-identical. */
export function referenceRequest(references: readonly LibraryReference[]) {
  return references.map(item => ({ kind: 'library_document' as const, documentId: item.documentId, version: item.version }));
}

/** Same documents at the same versions in the same order: the server compares the stored field as a whole. */
export function sameReferences(a: readonly LibraryReference[], b: readonly LibraryReference[]) {
  return a.length === b.length && a.every((item, index) => item.documentId === b[index].documentId && item.version === b[index].version);
}

/**
 * Only the references whose `@名称` is still in the text. A stored list can outlive an edit made while references were
 * unavailable (switch off, another deployment); a document the text no longer names must never ride along unseen.
 */
export function referencesNamedIn(text: string, references: readonly LibraryReference[]) {
  return references.filter(item => text.includes('@' + item.label));
}

/** References from storage or an older record; anything malformed is dropped rather than sent. */
export function parseReferences(value: unknown): LibraryReference[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is LibraryReference => Boolean(item) && typeof item.documentId === 'string'
    && Number.isInteger(item.version) && item.version > 0 && typeof item.label === 'string');
}

/**
 * `a` first, then whatever of `b` is not in it (a failed send's references come back before newer ones), at most five:
 * two valid sets must not add up to a message the server refuses. A reference left out stays in the text as `@名称`.
 */
export function mergeReferences(a: readonly LibraryReference[], b: readonly LibraryReference[]) {
  return [...a, ...b.filter(item => !a.some(other => other.documentId === item.documentId))].slice(0, REFERENCE_LIMIT);
}

/** The text typed after `@`, and the range it covers (including the `@`). */
export type ReferenceQuery = { from: number; to: number; query: string };

export const REFERENCE_NODE = 'libraryReference';
const OBJECT = '￼';

/** Inline, deleted as a whole (atom), never split by typing. */
export const LibraryReferenceNode = Node.create({
  name: REFERENCE_NODE,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      documentId: { default: null },
      version: { default: null },
      label: { default: '' },
    };
  },
  renderHTML({ node }) {
    return ['span', {
      'data-library-reference': node.attrs.documentId,
      class: 'library-reference',
      contenteditable: 'false',
    }, '@' + node.attrs.label];
  },
});

/** How a reference reads inside the message text: the same `@名称` the user sees. */
export function referenceLeafText(node: ProseNode) {
  return node.type.name === REFERENCE_NODE ? '@' + node.attrs.label : '';
}

/**
 * An `@` at the start of a line or after a non-ASCII-word character, followed by up to 40 non-space characters.
 * `a@b.com` does not trigger, so e-mail addresses stay ordinary text.
 */
export function findReferenceQuery(state: EditorState): ReferenceQuery | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const { $from } = selection;
  if (!$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, OBJECT);
  const match = /(?:^|[^A-Za-z0-9_.])@([^\s@￼]{0,40})$/.exec(before);
  if (!match) return null;
  const query = match[1];
  return { from: $from.pos - query.length - 1, to: $from.pos, query };
}

/** References in document order, each document once (the first mention wins). */
export function referencesIn(doc: ProseNode): LibraryReference[] {
  const found = new Map<string, LibraryReference>();
  doc.descendants(node => {
    if (node.type.name !== REFERENCE_NODE || found.has(node.attrs.documentId)) return;
    found.set(node.attrs.documentId, { documentId: node.attrs.documentId, version: node.attrs.version, label: node.attrs.label });
  });
  return [...found.values()];
}
