/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
"use client";
import { useEffect, useState } from "react";
import { trpc } from "@/trpc/client";

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * This tab remembers that the server refused this round's report for membership, so coming back
 * (for example with the browser's back button from checkout) shows the paywall again without
 * another `reportStart`. Display convenience only: the server still decides on every start.
 */
export function reportPaywallKey(draftId: string, roundId: string) {
  return "opc-report-paywall:" + draftId + ":" + roundId;
}

export function readPaywallFlag(storage: FlagStorage | null, key: string) {
  try {
    return storage?.getItem(key) === "membership";
  } catch {
    return false;
  }
}

export function writePaywallFlag(storage: FlagStorage | null, key: string, on: boolean) {
  try {
    if (on) storage?.setItem(key, "membership");
    else storage?.removeItem(key);
  } catch {
    /* Private mode or full storage: the in-memory refusal still serves this page. */
  }
}

// Reading `sessionStorage` itself can throw (blocked storage, opaque origins); never let it break the page.
function sessionStore(): FlagStorage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Whether to show the paywall for this round: after a membership refusal on this page, or after one
 * remembered in this tab, unless the server now reports a paid member (they paid in between).
 */
export function useReportPaywallMemory(input: { draftId: string; roundId: string; refusedForMembership: boolean;
  hasReport: boolean }) {
  const key = reportPaywallKey(input.draftId, input.roundId);
  const [remembered, setRemembered] = useState(false);
  // Read after mount: storage does not exist during the server render.
  useEffect(() => { setRemembered(readPaywallFlag(sessionStore(), key)); }, [key]);
  useEffect(() => {
    if (input.refusedForMembership && !input.hasReport) {
      writePaywallFlag(sessionStore(), key, true);
      setRemembered(true);
    }
  }, [input.refusedForMembership, input.hasReport, key]);
  const entitlements = trpc.user.getEntitlements.useQuery(undefined, { enabled: remembered && !input.hasReport, staleTime: 0 });
  const nowPaid = entitlements.data?.level === "pro" || entitlements.data?.level === "gold";
  useEffect(() => {
    if (nowPaid || input.hasReport) {
      writePaywallFlag(sessionStore(), key, false);
      setRemembered(false);
    }
  }, [nowPaid, input.hasReport, key]);
  if (input.hasReport) return false;
  if (input.refusedForMembership) return true;
  return remembered && !nowPaid;
}
