/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { useEffect, type RefObject } from 'react';

/** Gap between the tool button and the open menu (the menu sits 43px off a 34px button), and the margin kept to the edge. */
const GAP = 9;
const EDGE = 8;
/** The list never shrinks below roughly two rows; it scrolls inside instead. */
const MIN_LIST = 110;

export type MenuSpace = { anchorTop: number; anchorBottom: number; boundsTop: number; boundsBottom: number;
  /** Height of the whole menu as it renders now, and of its scrolling list inside it. */
  menuHeight: number; listHeight: number };
export type MenuPlacement = { side: 'up' | 'down'; listMax: number | null };

/**
 * Where a menu opened from a button fits: up (the default) when it fits whole, else down when it fits whole, else on the
 * side with more room with its list capped so the head and foot stay visible and the list scrolls (REL-1: the Skill menu
 * on the home page opened upward past the top of the work panel, hiding its first rows).
 */
export function placeMenu(space: MenuSpace): MenuPlacement {
  const up = space.anchorTop - space.boundsTop - GAP - EDGE;
  const down = space.boundsBottom - space.anchorBottom - GAP - EDGE;
  if (space.menuHeight <= up) return { side: 'up', listMax: null };
  if (space.menuHeight <= down) return { side: 'down', listMax: null };
  const side = down > up ? 'down' : 'up';
  const room = side === 'down' ? down : up;
  return { side, listMax: Math.max(MIN_LIST, Math.floor(room - (space.menuHeight - space.listHeight))) };
}

/** The visible band a menu may use: the viewport cut by every ancestor that clips its overflow. */
function visibleBand(from: HTMLElement | null): { top: number; bottom: number } {
  let top = 0, bottom = window.innerHeight;
  for (let node = from; node && node !== document.body; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === 'visible') continue;
    const rect = node.getBoundingClientRect();
    top = Math.max(top, rect.top);
    bottom = Math.min(bottom, rect.bottom);
  }
  return { top, bottom };
}

/** Keeps the menu in `menu` fully inside the visible area around its anchor (the offset parent), on mount, on resize and whenever
 * `contentKey` changes (the list finished loading or the filter changed, so the menu got taller or shorter). */
export function useMenuPlacement(menu: RefObject<HTMLElement | null>, list: RefObject<HTMLElement | null>, contentKey: string) {
  useEffect(() => {
    const apply = () => {
      const element = menu.current, scroller = list.current, anchor = element?.offsetParent as HTMLElement | null;
      if (!element || !scroller || !anchor) return;
      scroller.style.maxHeight = '';
      element.style.top = '';
      element.style.bottom = '';
      const rect = anchor.getBoundingClientRect(), band = visibleBand(anchor.parentElement);
      const placed = placeMenu({ anchorTop: rect.top, anchorBottom: rect.bottom, boundsTop: band.top, boundsBottom: band.bottom,
        menuHeight: element.offsetHeight, listHeight: scroller.offsetHeight });
      if (placed.side === 'down') { element.style.bottom = 'auto'; element.style.top = rect.height + GAP + 'px'; }
      if (placed.listMax !== null) scroller.style.maxHeight = placed.listMax + 'px';
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [menu, list, contentKey]);
}
