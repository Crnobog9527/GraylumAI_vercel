/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { placeMenu } from './menu-placement';

// The 1280x900 home page of the Codex batch 11 screenshot: the box sits near the middle, the work panel starts at y=105,
// and the Skill menu (head 50 + search 51 + list 380 + foot 50) is about 530px tall.
const home = { anchorTop: 368, anchorBottom: 402, boundsTop: 105, boundsBottom: 892, menuHeight: 530, listHeight: 380 };

describe('placeMenu', () => {
  it('opens upward when the whole menu fits above the button', () => {
    expect(placeMenu({ ...home, anchorTop: 700, anchorBottom: 734 })).toEqual({ side: 'up', listMax: null });
  });
  it('opens downward with a capped list instead of past the top of the panel (the reported case)', () => {
    // room above = 368-105-17 = 246, below = 892-402-17 = 473: down, list = 473 - (head + search + foot = 150)
    expect(placeMenu(home)).toEqual({ side: 'down', listMax: 323 });
  });
  it('opens downward whole when it fits there but not above', () => {
    expect(placeMenu({ ...home, boundsBottom: 960 })).toEqual({ side: 'down', listMax: null });
  });
  it('caps the list and scrolls it inside when neither side fits, keeping head and foot visible', () => {
    // 375x812-like: little room either way, the roomier side wins and the list keeps its floor
    expect(placeMenu({ ...home, anchorTop: 400, anchorBottom: 434, boundsTop: 330, boundsBottom: 600 }))
      .toEqual({ side: 'down', listMax: 110 });
  });
  it('never returns a list height below the floor', () => {
    expect(placeMenu({ ...home, anchorTop: 130, anchorBottom: 164, boundsBottom: 190 }).listMax).toBeGreaterThanOrEqual(110);
  });
});
