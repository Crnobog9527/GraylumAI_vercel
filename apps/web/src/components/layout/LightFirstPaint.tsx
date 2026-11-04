/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// Server-rendered marker for routes whose finished page is light (WorkspaceFrame, .workspace #f7f7f7).
// globals.css turns the body light for any document that contains it, so the first painted frame, before
// the page's JavaScript runs, is already light instead of the global dark --bg-primary.
export function LightFirstPaint() {
  return <div data-first-paint="light" hidden />;
}
