/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from "react";
import { cardErrorText, type CardConfirmation } from "./selection-card-model";

const errorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object") return undefined;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === "string" && code.startsWith("RESEARCH_")) return code;
  return typeof message === "string" ? message.match(/RESEARCH_[A-Z_]+/)?.[0] : undefined;
};

/**
 * One confirmation per card: while the request runs the card is locked; a success replaces the form with the
 * read-only echo for good; a failure shows a plain sentence and leaves the form as it was.
 */
export function useCardConfirm<S>(
  saved: CardConfirmation | null | undefined,
  onConfirm: (submission: S) => Promise<CardConfirmation>,
) {
  const [confirmed, setConfirmed] = useState<CardConfirmation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmation = saved ?? confirmed;

  const submit = async (submission: S) => {
    if (pending || confirmation) return;
    setPending(true);
    setError(null);
    try {
      setConfirmed(await onConfirm(submission));
    } catch (failure) {
      setError(cardErrorText(errorCode(failure)));
    } finally {
      setPending(false);
    }
  };
  return { confirmation, pending, error, submit };
}
