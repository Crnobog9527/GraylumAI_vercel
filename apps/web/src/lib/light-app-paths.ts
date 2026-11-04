/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// Signed-in routes whose finished page is light (WorkspaceFrame / the home page). Their first painted frame, in the server
// HTML, must already be light. Dark routes (profile, marketplace, expert-consult, agent-first-preview, library/scan-check,
// publish-monitor/connect and /publish) are deliberately not listed.
const LIGHT_PREFIXES = ['/app/positioning', '/app/runtime', '/app/library', '/app/workbench/marketplace', '/app/workbench/search'];
const LIGHT_EXACT = ['/app', '/app/publish-monitor'];
const DARK_UNDER_LIGHT = ['/app/library/scan-check'];

const under = (pathname: string, prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export function isLightAppPath(pathname: string | null): boolean {
  if (!pathname) return false;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  if (DARK_UNDER_LIGHT.some(prefix => under(path, prefix))) return false;
  return LIGHT_EXACT.includes(path) || LIGHT_PREFIXES.some(prefix => under(path, prefix));
}
