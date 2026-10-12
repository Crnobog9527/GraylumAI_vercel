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
import { docToText, fitText, textToDoc, textToSlice } from './composer-text';

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
  return maxLength - docToText(state.doc).length + state.doc.textBetween(from, to, '\n').length;
}

export type ComposerEditorHandle = { focus: () => void };

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
  ref?: Ref<ComposerEditorHandle>;
};

/**
 * Plain-text editing core of the message box (UI-A), built on Tiptap so @ references can be added later.
 * The parent keeps owning the string value, exactly as with the old textarea.
 */
export function ComposerEditor(props: Props) {
  const { value, onChange, onEnter, onEscape, disabled = false, label, placeholder, maxLength, className, ref } = props;
  const latest = useRef({ onChange, onEnter, onEscape, disabled, label, placeholder, maxLength });
  latest.current = { onChange, onEnter, onEscape, disabled, label, placeholder, maxLength };
  // The text this editor last reported (or was given); a different `value` prop comes from the parent.
  const emitted = useRef(value);
  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    content: textToDoc(value),
    extensions: [
      Document, Paragraph, Text, UndoRedo,
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
      clipboardTextSerializer: slice => slice.content.textBetween(0, slice.content.size, '\n'),
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
    emitted.current = value;
    editor.chain().setMeta(EXTERNAL, true).setMeta('addToHistory', false)
      .setContent(textToDoc(value), { emitUpdate: false })
      .command(({ tr }) => {
        tr.setSelection(Selection.atEnd(tr.doc));
        return true;
      }).run();
  }, [editor, value]);

  useEffect(() => {
    // setEditable also re-applies the attributes above, so label, placeholder and aria-disabled follow the props.
    editor?.setEditable(!disabled, false);
  }, [editor, disabled, label, placeholder]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      editor?.commands.focus(undefined, { scrollIntoView: false });
    },
  }), [editor]);

  return <EditorContent editor={editor} className={className} />;
}
