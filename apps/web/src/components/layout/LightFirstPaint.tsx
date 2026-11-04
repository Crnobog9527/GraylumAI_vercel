/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// Marker for signed-in routes whose finished page is light (isLightAppPath). The Provider renders it outside the
// shell/page swap, so it is in the server HTML.
// globals.css turns the body light for any document that contains it, so the first painted frame, before
// the page's JavaScript runs, is already light instead of the global dark --bg-primary.
export function LightFirstPaint() {
  return <div data-first-paint="light" hidden />;
}
