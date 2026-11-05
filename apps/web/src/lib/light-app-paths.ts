/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

// Signed-in routes whose finished page is light (WorkspaceFrame / the home page). Their first painted frame, in the server
// HTML, must already be light. Dark routes (profile, expert-consult, agent-first-preview, library/scan-check,
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

/*
 * The same decision as isLightAppPath, as an inline script for the document <head> (RootDocument). The marker in the body
 * (<LightFirstPaint/>) is not enough: the server flushes the document in chunks, and when the first chunk ends after <body> opens but before
 * the marker, the browser paints that empty body in the dark page colour before the marker arrives (positioning/[draftId], 2026-11-05, #1738).
 * The head is always in the first chunk and a classic inline script runs before the first paint, so it sets data-first-paint on <html>.
 * Built from the tables above; light-app-paths.test.tsx runs it against isLightAppPath for the same paths.
 */
export const LIGHT_FIRST_PAINT_SCRIPT = `(function(){var p=location.pathname;if(p.length>1)p=p.replace(/\\/+$/,'');`
  + `var u=function(x){return p===x||p.indexOf(x+'/')===0};`
  + `if(${JSON.stringify(DARK_UNDER_LIGHT)}.some(u))return;`
  + `if(${JSON.stringify(LIGHT_EXACT)}.indexOf(p)>=0||${JSON.stringify(LIGHT_PREFIXES)}.some(u))`
  + `document.documentElement.setAttribute('data-first-paint','light')})()`;

/** Keeps data-first-paint on <html> in step with the path after the first paint: a client navigation from a light page to a dark one
 *  (the root layout does not remount) must take the mark off again, or the dark page keeps the light body. */
export function syncLightFirstPaint(root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void },
  pathname: string | null): void {
  if (isLightAppPath(pathname)) root.setAttribute('data-first-paint', 'light');
  else root.removeAttribute('data-first-paint');
}
