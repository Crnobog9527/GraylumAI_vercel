/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useState } from "react";

/*
 * The Agent's opening is a paid mentor turn. It may only start from something the user did in this tab (starting the draft, or
 * confirming the previous step) or from the user's click on 开始这一步. Merely opening a draft, old or new, never starts one:
 * the mark below is what the page checks before it sends an opening, and a launched opening uses the mark up.
 */
export const openingIntentKey = (draftId: string) => "opc-open-intent:" + draftId;
export const OPENING_OFFER_NOTICE = "AI 教练还没有开始这一步。点“开始这一步”，教练才会发出开场问题并计费；只是查看不会产生费用。";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const safe = <T>(fn: () => T, fallback: T) => { try { return fn(); } catch { return fallback; } };

/** The user asked for an opening in this tab. */
export const grantOpeningIntent = (storage: Store, draftId: string) =>
  safe(() => { storage.setItem(openingIntentKey(draftId), "1"); }, undefined);
export const hasOpeningIntent = (storage: Store, draftId: string) => safe(() => storage.getItem(openingIntentKey(draftId)) === "1", false);
/** Used when an opening is sent: one grant starts at most one opening. */
export const consumeOpeningIntent = (storage: Store, draftId: string) =>
  safe(() => { storage.removeItem(openingIntentKey(draftId)); }, undefined);

/**
 * The page's gate for the Agent's opening. `admit` is asked before an opening is sent: without the user's mark it offers the step
 * instead (`offer`) and says no; with it, the mark is used up. `ask` is the 开始这一步 click.
 */
export function useOpeningGate(draftId: string) {
  const [offered, setOffered] = useState<string | null>(null), [asked, setAsked] = useState(0);
  const grant = () => grantOpeningIntent(sessionStorage, draftId);
  return { asked, grant,
    admit(stepId: string) {
      if (!hasOpeningIntent(sessionStorage, draftId)) { setOffered(stepId); return false; }
      consumeOpeningIntent(sessionStorage, draftId); setOffered(null); return true;
    },
    offer: (stepId: string, idle: boolean) => idle && offered === stepId ? { onClick: () => { grant(); setAsked(count => count + 1); } } : null };
}
