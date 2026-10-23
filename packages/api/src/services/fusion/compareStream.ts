/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { POSITIONING_MARKER } from '../runtime/positioningFallback';

/** What a compare column shows while it streams (FUSION-COMPARE §3.5). The provider stream reaches the executor as one raw
 * JSON frame per call to `onChunk`; this module turns those frames into the visible answer text and nothing else: reasoning,
 * tool calls, usage and identity fields never reach the browser. No identity masking is applied (Owner 2026-10-17, Q5). */

/** The visible text of one frame (`delta.content`), '' for anything else, including the terminator and malformed frames. */
export function frameText(frame: string): string {
  if (!frame || frame === '[DONE]') return '';
  let value: unknown;
  try { value = JSON.parse(frame); } catch { return ''; }
  const choices = value && typeof value === 'object' ? (value as { choices?: unknown }).choices : undefined;
  if (!Array.isArray(choices)) return '';
  let text = '';
  for (const choice of choices) {
    const delta = choice && typeof choice === 'object' ? (choice as { delta?: { content?: unknown } }).delta : undefined;
    if (typeof delta?.content === 'string') text += delta.content;
  }
  return text;
}

/** Forwards visible text as it arrives. With `holdForRefusal` (a column admitted with the positioning fallback rule) the
 * start of the answer is held back until it is clear it is not the refusal marker: a refused column is never shown and
 * never saved, only settled free. `settle(refused)` ends the stream: a refused column drops what it held, any other
 * releases it. Everything held is released as soon as the text can no longer begin with the marker. */
export function columnStreamer(options: { holdForRefusal: boolean; emit: (text: string) => void }) {
  let seen = '';       // all visible text so far
  let sent = 0;        // how much of it has been emitted
  let decided = !options.holdForRefusal;
  let refused = false;
  const release = () => { if (!refused && sent < seen.length) { options.emit(seen.slice(sent)); sent = seen.length; } };
  function judge() {
    if (decided) return;
    const lead = seen.trimStart();
    if (lead.length >= POSITIONING_MARKER.length) { decided = true; refused = lead.startsWith(POSITIONING_MARKER); }
    else if (!POSITIONING_MARKER.startsWith(lead)) decided = true; // can no longer become the marker
  }
  return {
    onChunk(frame: string) {
      const text = frameText(frame);
      if (!text) return;
      seen += text;
      judge();
      if (decided) release();
    },
    /** The full answer as it streamed (for tests and the final state). */
    text: () => seen,
    /** Called once the call's outcome is known. */
    settle(wasRefused: boolean) {
      if (wasRefused) { refused = true; return; }
      decided = true; release();
    },
  };
}
