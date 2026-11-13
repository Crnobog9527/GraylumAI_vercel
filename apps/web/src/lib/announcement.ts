/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * What the bar under the signed-in pages' top bar says (AnnouncementBar): a line and a button that leads somewhere.
 * Owner 2026-11-12: "这个位置我肯定会……长期挂一个促销的公告". Until there is a promotion it carries the line it always
 * has. To put a promotion up, change the words and the link here and give it a new `id`: whoever closed the last
 * announcement is shown the new one, because closing is remembered by id.
 */
export const ANNOUNCEMENT = {
  id: 'explore',
  text: '让好想法，继续向前。',
  cta: '探索创作功能',
  href: '/app/workbench/marketplace',
} as const;

/** Where a browser remembers which announcement its person closed (the announcement's id). */
export const ANNOUNCEMENT_CLOSED_KEY = 'graylum-announcement-closed';
/** Set on <html> while the announcement now showing is one this browser closed (workspace-frame.module.css hides the bar by it). */
export const ANNOUNCEMENT_CLOSED_MARK = 'data-announcement-closed';

/**
 * The same decision as an inline script for the document <head> (RootDocument), as light-app-paths.ts does for the page
 * colour: the server cannot know what a browser closed, so its HTML always has the bar, and without this a closed bar
 * would show until the page's scripts had taken over and then drop out, moving the page. It runs before the first paint.
 */
export const ANNOUNCEMENT_FIRST_PAINT_SCRIPT = '(function(){try{'
  + `if(localStorage.getItem(${JSON.stringify(ANNOUNCEMENT_CLOSED_KEY)})===${JSON.stringify(ANNOUNCEMENT.id)})`
  + `document.documentElement.setAttribute(${JSON.stringify(ANNOUNCEMENT_CLOSED_MARK)},'')`
  + '}catch(e){}})()';
