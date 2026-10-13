/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { Node } from '@tiptap/core';
import type { Node as ProseNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';

/**
 * UI-B skeleton: `@` picks a library document and leaves an inline reference in the message box.
 * Off by default. References are kept apart from the text and are NOT sent yet (that needs LIB-4).
 */
// Next inlines NEXT_PUBLIC_* at build time; bundles without `process` (component test fixtures) read it as off.
export const COMPOSER_REFERENCES_ENABLED =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_COMPOSER_REFERENCES === 'on';

/** What LIB-4 is planned to read: one document at one content version. The label is display only. */
export type LibraryReference = { documentId: string; version: number; label: string };

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
