/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useSyncExternalStore } from 'react';

/*
 * CORE-PATH-V2 V2-10: the live text of a compare started in this tab. A compare of the turn path streams all its columns in the one
 * request that started it, so the card cannot ask for a column as the old card does; the picker feeds this store and the card reads
 * it. After a reload the store is empty and the card reads the saved state (answers appear when each column has finished).
 */
export type TurnCompareLive = { open: boolean; text: Record<number, string>; answered: number[] };
const EMPTY: TurnCompareLive = { open: false, text: {}, answered: [] };
const lives = new Map<string, TurnCompareLive>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());

export const turnCompareLive = {
  begin(compareId: string) { lives.set(compareId, { open: true, text: {}, answered: [] }); emit(); },
  column(compareId: string, index: number, delta: string) {
    const live = lives.get(compareId); if (!live) return;
    lives.set(compareId, { ...live, text: { ...live.text, [index]: (live.text[index] ?? '') + delta } }); emit();
  },
  answered(compareId: string, index: number) {
    const live = lives.get(compareId); if (!live) return;
    lives.set(compareId, { ...live, answered: [...live.answered, index] }); emit();
  },
  end(compareId: string) {
    const live = lives.get(compareId); if (!live) return;
    lives.set(compareId, { ...live, open: false }); emit();
  },
  get: (compareId: string): TurnCompareLive => lives.get(compareId) ?? EMPTY,
};

export function useTurnCompareLive(compareId: string, on: boolean): TurnCompareLive {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => (on ? turnCompareLive.get(compareId) : EMPTY), () => EMPTY);
}
