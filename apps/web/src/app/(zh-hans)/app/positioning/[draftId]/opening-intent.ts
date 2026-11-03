/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from "react";

/*
 * The Agent's opening is a paid mentor turn. It may only start from something the user did in this tab: starting the draft (its
 * first step), confirming the previous step (the next step of that round), or the click on 开始这一步 (that step of that round).
 * Merely opening a draft, old or new, never starts one. The mark names the step and round it was given for, expires, and a
 * launched opening uses it up, so a mark left behind (the last step confirmed, a revision, a later visit) opens nothing.
 */
export const openingIntentKey = (draftId: string) => "opc-open-intent:" + draftId;
export const OPENING_INTENT_TTL_MS = 10 * 60 * 1000;
export const OPENING_OFFER_NOTICE = "AI 教练还没有开始这一步。点“开始这一步”，教练才会发出开场问题并计费；只是查看不会产生费用。";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type Place = { stepId?: string; roundId?: string | null };
const safe = <T>(fn: () => T, fallback: T) => { try { return fn(); } catch { return fallback; } };

/** The user asked for an opening in this tab. Without a place it is the start of the draft: only its first step may use it. */
export const grantOpeningIntent = (storage: Store, draftId: string, place: Place = {}, now = Date.now()) =>
  safe(() => { storage.setItem(openingIntentKey(draftId), JSON.stringify({ at: now, ...place })); }, undefined);
/** Whether a live mark matches this step and round (`first`: the draft's first step). Expired marks are removed. */
export function hasOpeningIntent(storage: Store, draftId: string, place: Required<Place> & { first: boolean }, now = Date.now()) {
  return safe(() => {
    const raw = storage.getItem(openingIntentKey(draftId));
    if (!raw) return false;
    const mark = JSON.parse(raw) as { at?: unknown } & Place;
    if (typeof mark.at !== "number" || now - mark.at > OPENING_INTENT_TTL_MS || mark.at > now + 60_000) {
      storage.removeItem(openingIntentKey(draftId));
      return false;
    }
    return mark.stepId === undefined ? place.first : mark.stepId === place.stepId && (mark.roundId ?? null) === (place.roundId ?? null);
  }, false);
}
/** Used when an opening is sent: one grant starts at most one opening. */
export const consumeOpeningIntent = (storage: Store, draftId: string) =>
  safe(() => { storage.removeItem(openingIntentKey(draftId)); }, undefined);

/**
 * The page's gate for the Agent's opening. `admit` is asked before an opening is sent: without a mark for this step and round it
 * offers the step instead (`offer`) and says no; with it, the mark is used up. `clear` drops the offer once the step is open.
 */
export function useOpeningGate(draftId: string) {
  const [offered, setOffered] = useState<(Place & { stepId: string }) | null>(null), [asked, setAsked] = useState(0);
  const grant = (stepId: string, roundId: string | null) => grantOpeningIntent(sessionStorage, draftId, { stepId, roundId });
  return { asked, grant,
    admit(stepId: string, roundId: string | null, first: boolean) {
      if (!hasOpeningIntent(sessionStorage, draftId, { stepId, roundId, first })) {
        setOffered(old => old?.stepId === stepId && old.roundId === roundId ? old : { stepId, roundId });
        return false;
      }
      consumeOpeningIntent(sessionStorage, draftId); setOffered(null); return true;
    },
    clear() { setOffered(null); },
    offer: (stepId: string, idle: boolean) => idle && offered?.stepId === stepId
      ? { onClick: () => { grant(stepId, offered.roundId ?? null); setAsked(count => count + 1); } } : null };
}
