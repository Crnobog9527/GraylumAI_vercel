'use client';
/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { Extension } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { splitBlock } from '@tiptap/pm/commands';
import { Plugin, PluginKey, Selection, type EditorState } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import { docToText, fitText, rangeText, textToDoc, textToSlice } from './composer-text';
import {
  findReferenceQuery, LibraryReferenceNode, REFERENCE_NODE, referenceLeafText, referencesIn,
  type LibraryReference, type ReferenceQuery,
} from './composer-references';

/** Marks a transaction that mirrors the parent's value; it skips the length filter and the undo history. */
const EXTERNAL = 'composerExternal';

/** Rejects typing or drops that would push the text past the limit; deleting while over the limit still works. */
const LengthLimit = Extension.create<{ limit: () => number }>({
  name: 'composerLengthLimit',
  addOptions() {
    return { limit: () => Infinity };
  },
  addProseMirrorPlugins() {
    const limit = this.options.limit;
    return [new Plugin({
      key: new PluginKey('composerLengthLimit'),
      filterTransaction(tr, state) {
        if (!tr.docChanged || tr.getMeta(EXTERNAL)) return true;
        const next = docToText(tr.doc).length;
        return next <= limit() || next <= docToText(state.doc).length;
      },
    })];
  },
});

/** Characters that can still be added when the range from..to is replaced. */
function roomFor(state: EditorState, from: number, to: number, maxLength: number) {
  return maxLength - docToText(state.doc).length + rangeText(state.doc, from, to).length;
}

export type ComposerEditorHandle = {
  focus: () => void;
  /** Replace the typed `@query` with a reference and a trailing space; false when it does not fit the limit. */
  insertReference: (range: ReferenceQuery, reference: LibraryReference) => boolean;
  /** UI-C: add a reference at the end of the message (an attached file); false when it does not fit the limit. */
  appendReference: (reference: LibraryReference) => boolean;
  /** The references in the box right now (not the parent's copy, which updates a render later). */
  currentReferences: () => LibraryReference[];
};

/** UI-B: only passed while references are switched on; absent, the box behaves exactly as UI-A. */
export type ComposerReferenceHooks = {
  onState: (state: { query: ReferenceQuery | null; references: LibraryReference[] }) => void;
  /** The open `@` menu gets keys first (after IME); returning true consumes the key. */
  onMenuKey: (event: KeyboardEvent) => boolean;
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Enter without Shift, outside IME composition. The caller decides whether it may send. */
  onEnter: () => void;
  onEscape?: () => void;
  disabled?: boolean;
  label: string;
  placeholder: string;
  maxLength: number;
  className?: string;
  references?: ComposerReferenceHooks;
  /** The parent's references for its `value` (UI-B): a value set from outside gets them back as references. */
  knownReferences?: readonly LibraryReference[];
  ref?: Ref<ComposerEditorHandle>;
};

/**
 * Plain-text editing core of the message box (UI-A), built on Tiptap so @ references can be added later.
 * The parent keeps owning the string value, exactly as with the old textarea.
 */
export function ComposerEditor(props: Props) {
  const { value, onChange, onEnter, onEscape, disabled = false, label, placeholder, maxLength, className, references, ref } = props;
  const known = references ? props.knownReferences ?? [] : [];
  const latest = useRef({ onChange, onEnter, onEscape, disabled, label, placeholder, maxLength, references, known });
  latest.current = { onChange, onEnter, onEscape, disabled, label, placeholder, maxLength, references, known };
  // The text this editor last reported (or was given); a different `value` prop comes from the parent.
  const emitted = useRef(value);
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    content: textToDoc(value, known),
    extensions: [
      Document, Paragraph, Text, UndoRedo, LibraryReferenceNode,
      Placeholder.configure({ placeholder: () => latest.current.placeholder }),
      LengthLimit.configure({ limit: () => latest.current.maxLength }),
    ],
    editorProps: {
      attributes: () => ({
        role: 'textbox',
        'aria-label': latest.current.label,
        'aria-multiline': 'true',
        'aria-placeholder': latest.current.placeholder,
        'aria-disabled': latest.current.disabled ? 'true' : 'false',
      }),
      handleKeyDown(view, event) {
        if (event.isComposing || event.keyCode === 229) return false;
        if (latest.current.references?.onMenuKey(event)) return true;
        if (event.key === 'Escape') {
          latest.current.onEscape?.();
          return false;
        }
        if (event.key !== 'Enter') return false;
        if (event.shiftKey) return splitBlock(view.state, view.dispatch);
        latest.current.onEnter();
        return true;
      },
      // Like textarea maxLength: typed text past the limit is cut to the room left instead of dropped.
      handleTextInput(view, from, to, text) {
        const room = roomFor(view.state, from, to, latest.current.maxLength);
        if (text.length <= room) return false;
        const fitted = fitText(text, room);
        if (fitted) view.dispatch(view.state.tr.insertText(fitted, from, to));
        return true;
      },
      // Paste plain text only, trimmed to the room left, so formatting never enters a message.
      handlePaste(view, event) {
        const text = event.clipboardData?.getData('text/plain');
        if (text == null) return false;
        const { state } = view;
        const room = roomFor(state, state.selection.from, state.selection.to, latest.current.maxLength);
        const fitted = fitText(text.replace(/\r\n?/g, '\n'), room);
        if (fitted) view.dispatch(state.tr.replaceSelection(textToSlice(state.schema, fitted)).scrollIntoView());
        return true;
      },
      clipboardTextSerializer: slice => slice.content.textBetween(0, slice.content.size, '\n', referenceLeafText),
    },
    onUpdate({ editor: current }) {
      const text = docToText(current.state.doc);
      if (text === emitted.current) return;
      emitted.current = text;
      // Render the parent now, as a textarea's onChange would, so an Enter right after typing sends the latest text.
      flushSync(() => latest.current.onChange(text));
    },
  });

  useEffect(() => {
    if (!editor || value === emitted.current) return;
    const previous = emitted.current;
    emitted.current = value;
    // Text appended by the parent (e.g. a file added) goes after what is there, so references stay intact.
    const appended = previous !== '' && value.startsWith(previous) ? value.slice(previous.length) : null;
    editor.chain().setMeta(EXTERNAL, true).setMeta('addToHistory', false)
      .command(({ tr, state }) => {
        if (appended === null) {
          tr.replaceWith(0, tr.doc.content.size, state.schema.nodeFromJSON(textToDoc(value, latest.current.known)).content);
        } else {
          const end = Selection.atEnd(tr.doc).from;
          tr.replace(end, end, textToSlice(state.schema, appended));
        }
        tr.setSelection(Selection.atEnd(tr.doc));
        return true;
      }).run();
  }, [editor, value]);

  useEffect(() => {
    // setEditable also re-applies the attributes above, so label, placeholder and aria-disabled follow the props.
    editor?.setEditable(!disabled, false);
  }, [editor, disabled, label, placeholder]);

  const referencesOn = Boolean(references);
  useEffect(() => {
    if (!editor || !referencesOn) return;
    const report = () => latest.current.references?.onState({
      query: findReferenceQuery(editor.state), references: referencesIn(editor.state.doc),
    });
    report();
    editor.on('transaction', report);
    return () => {
      editor.off('transaction', report);
    };
  }, [editor, referencesOn]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      editor?.commands.focus(undefined, { scrollIntoView: false });
    },
    insertReference: (range, reference) => {
      if (!editor) return false;
      const before = editor.state.doc;
      editor.chain().focus().insertContentAt({ from: range.from, to: range.to }, [
        { type: REFERENCE_NODE, attrs: reference }, { type: 'text', text: ' ' },
      ]).run();
      // The length filter drops a transaction silently; an unchanged document means it did not fit.
      return editor.state.doc !== before;
    },
    appendReference: reference => {
      if (!editor) return false;
      const before = editor.state.doc;
      const end = Selection.atEnd(before).from;
      const last = before.textBetween(Math.max(0, end - 1), end, '\n', '\ufffc');
      // Separated from typed text by a space, so `@名称` reads as its own word.
      const lead = last && !/\s/.test(last) ? [{ type: 'text', text: ' ' }] : [];
      editor.chain().insertContentAt(end, [...lead, { type: REFERENCE_NODE, attrs: reference }, { type: 'text', text: ' ' }]).run();
      return editor.state.doc !== before;
    },
    currentReferences: () => editor ? referencesIn(editor.state.doc) : [],
  }), [editor]);

  return <EditorContent editor={editor} className={className} />;
}
