/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { ReactNode } from 'react';
import { SAMPLE_FILE_HINT } from '@/components/chat-display/fixtures/composer';
import { ComposerTextPreview, ComposerView, type ComposerPreviewParagraph } from '@/components/opc/composer-view';

/**
 * The product's message box on the landing page (round seven, T3): the shared display component (`ComposerView`)
 * with the read-only text box (`ComposerTextPreview`) in place of the live editor, so no editing engine or server
 * query runs. `paragraphs` is what has been typed so far; empty, it shows the placeholder.
 */
export function ComposerL({ paragraphs = [['']], placeholder = '消息', label = '消息', attachment, caret }: {
  paragraphs?: ComposerPreviewParagraph[];
  placeholder?: string;
  label?: string;
  /** Shown in the frame above the text, for example the docked question card. */
  attachment?: ReactNode;
  /** The typing caret, while a message is being typed. */
  caret?: ReactNode;
}) {
  const empty = paragraphs.every(parts => parts.every(part => part === ''));
  return (
    <ComposerView attachment={attachment} fileHint={SAMPLE_FILE_HINT} sendDisabled={empty}
      editor={<ComposerTextPreview label={label} paragraphs={paragraphs} placeholder={placeholder} caret={caret} />} />
  );
}
