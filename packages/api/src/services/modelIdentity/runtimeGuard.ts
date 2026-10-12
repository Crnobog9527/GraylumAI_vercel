/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { RuntimeProgress } from '../runtime/progress';
import { redactIdentityBody, redactModelIdentity, streamingRedaction } from './outputGuard';

type TextEvent = Extract<RuntimeProgress, { type: 'text' }>;

/**
 * MODEL-IDENTITY-GUARD layer 3 for one runtime execution. The decision is the one frozen at
 * admission (see frozenBrandIdentity), so streamed text and the stored body agree and no extra
 * database read happens. Billing is unaffected: it settles from provider usage receipts.
 */
export function runtimeIdentityGuard(enabled: boolean) {
  return {
    enabled,
    body: (body: string) => enabled ? redactIdentityBody(body) : body,
    progress: (emit: (event: RuntimeProgress) => void) => enabled ? guardedProgress(emit) : emit,
  };
}

/** Cumulative text events are re-derived from their redacted view; card messages are redacted too. */
export function guardedProgress(emit: (event: RuntimeProgress) => void) {
  let emitted = '', source: string | undefined, latest: TextEvent | undefined, held = false, switched = false;
  const send = (event: TextEvent, text: string) => {
    if ('delta' in event) {
      if (text === emitted && (!event.replace || text)) return;
      // A source switch must reach the client as a replacement, never as an appended delta.
      const extend = !event.replace && !switched && text.startsWith(emitted);
      if (!text && !emitted) return;
      emit({ ...event, text, delta: extend ? text.slice(emitted.length) : text, replace: !extend });
    } else {
      if (!text && event.text) return;
      emit({ type: 'text', text });
    }
    emitted = text;
    switched = false;
  };
  const flush = () => {
    if (latest && held) send(latest, redactModelIdentity(latest.text));
    held = false;
  };
  return (event: RuntimeProgress) => {
    if (event.type !== 'text') {
      flush();
      if (event.type === 'card' && typeof (event.card as { message?: unknown }).message === 'string') {
        const card = event.card as typeof event.card & { message: string };
        emit({ ...event, card: { ...card, message: redactModelIdentity(card.message) } });
      } else emit(event);
      return;
    }
    if ('delta' in event && event.source !== source) { source = event.source; emitted = ''; switched = true; }
    const final = 'delta' in event && event.source === 'final';
    const full = redactModelIdentity(event.text);
    const text = final ? full : streamingRedaction(event.text);
    latest = event;
    held = text !== full;
    send(event, text);
  };
}
