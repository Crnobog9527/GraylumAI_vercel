/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * PUBLISH-MONITOR (Owner 2026-11-04, "B 存下截图里的数字"): the numbers the coach reads from the user's back-office screenshots in a free
 * chat are kept as per-post diagnoses for the weekly review. The coach ends its reply with a ```coach_diag block (JSON). The block is
 * never shown (the stream holds it back, the saved message drops it); the host checks it here and hands the checked items to turn_close,
 * which writes them in the close transaction (turn_chat_screenshots_apply, 9999). The image is never kept: numbers, the label as read and
 * the screenshot's number in the message only.
 */
import { z } from 'zod';
import { COUNT_KEYS, RATE_KEYS } from './funnel';

export const DIAG_MARK = '```coach_diag';
const BLOCK = /```coach_diag\s*\n([\s\S]*?)\n```/;
export const MAX_SCREENSHOT_POSTS = 6;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const SECONDS = new Set<string>(['avg_watch_seconds']);
const COUNTS = new Set<string>(COUNT_KEYS);
const KEYS = new Set<string>([...RATE_KEYS, ...COUNT_KEYS]);

const itemSchema = z.object({
  post_id: uuid, image: z.number().int().min(1).max(20).default(1),
  rates: z.record(z.string(), z.unknown()),
  // Over-long text is cut, not a reason to lose the item's good numbers; a value that is neither text nor a number is dropped.
  raw: z.record(z.string(), z.unknown()).default({}),
  video_seconds: z.number().int().min(1).max(86400).nullable().default(null), drop_second: z.number().int().min(0).max(86400).nullable().default(null),
  opening_text: z.string().transform(text => text.slice(0, 2000)).nullable().default(null),
});
const blockSchema = z.object({ items: z.array(z.unknown()) });

/** What turn_close takes (camelCase, one entry per post): rates are normalized keys only, fractions 0..1, counts whole numbers. */
export type ScreenshotItem = { postId: string; rates: Record<string, number>; raw: Record<string, { value: string | number; image: number }>;
  videoSeconds?: number; dropSecond?: number; openingText?: string };

function cleanRates(rates: Record<string, unknown>) {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(rates)) {
    if (!KEYS.has(key) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    const fine = COUNTS.has(key) ? Number.isInteger(value) && value >= 0 && value <= 1e12
      : SECONDS.has(key) ? value >= 0 && value <= 86400 : value >= 0 && value <= 1;
    if (fine) out[key] = value;
  }
  return out;
}

/** How much of the reply so far may be shown: nothing from the block's start on, and not a tail that could still become the block's start. */
export function visibleLength(reply: string): number {
  const at = reply.indexOf(DIAG_MARK);
  if (at >= 0) return at;
  for (let keep = Math.min(DIAG_MARK.length - 1, reply.length); keep > 0; keep--) {
    if (DIAG_MARK.startsWith(reply.slice(reply.length - keep))) return reply.length - keep;
  }
  return reply.length;
}

/**
 * The reply without its block, and the checked items. A block that never closed (the answer ran out of room) is dropped with its text;
 * an item that fails a check is dropped on its own; two items for one post are merged (the later one's values win).
 */
export function extractScreenshots(reply: string): { body: string; items: ScreenshotItem[] } {
  const match = BLOCK.exec(reply);
  const opened = reply.indexOf(DIAG_MARK);
  const cut = match ? match.index : opened >= 0 ? opened : reply.length;
  // Text after a closed block is kept (the model sometimes closes with a sentence); an unclosed block takes the rest with it.
  const after = match ? reply.slice(match.index + match[0].length).trim() : '';
  const body = reply.slice(0, cut).trimEnd() + (after ? '\n' + after : '');
  if (!match) return { body, items: [] };
  let raw: unknown;
  try { raw = JSON.parse(match[1]!); } catch { return { body, items: [] }; }
  const block = blockSchema.safeParse(raw);
  if (!block.success) return { body, items: [] };
  const merged = new Map<string, ScreenshotItem>();
  for (const entry of block.data.items.slice(0, 20)) {
    const item = itemSchema.safeParse(entry);
    if (!item.success) continue;
    const rates = cleanRates(item.data.rates);
    if (!Object.keys(rates).length) continue;
    const labels = Object.fromEntries(Object.entries(item.data.raw).slice(0, 30).flatMap(([label, value]) =>
      label.length <= 60 && (typeof value === 'number' || typeof value === 'string')
        ? [[label, { value: typeof value === 'string' ? value.slice(0, 40) : value, image: item.data.image }]] : []));
    const before = merged.get(item.data.post_id);
    if (!before && merged.size >= MAX_SCREENSHOT_POSTS) continue;
    merged.set(item.data.post_id, { postId: item.data.post_id, rates: { ...before?.rates, ...rates }, raw: { ...before?.raw, ...labels },
      ...(item.data.video_seconds !== null ? { videoSeconds: item.data.video_seconds } : before?.videoSeconds ? { videoSeconds: before.videoSeconds } : {}),
      ...(item.data.drop_second !== null ? { dropSecond: item.data.drop_second } : before?.dropSecond !== undefined ? { dropSecond: before.dropSecond } : {}),
      ...(item.data.opening_text !== null ? { openingText: item.data.opening_text } : before?.openingText ? { openingText: before.openingText } : {}) });
  }
  return { body, items: [...merged.values()] };
}

/** Added after the chat review instructions while the member can use the chat review (the block above is the only thing the chat saves). */
export const COACH_CAPTURE_INSTRUCTIONS = '\nThe numbers you read from a screenshot are the one exception to "nothing is saved": they are kept for the weekly '
  + 'review. Always list them in the reply for the user to check (the kept copy never replaces the list), and say they are from the user\'s screenshot. '
  + 'Match each screenshot to one post of the pack (posts_index, this_period, diagnostics; title, opening, publish date); '
  + 'when it is not clear or several posts could fit, ask the user which '
  + 'one and keep nothing for it; a post that is not in the pack at all (for example one published today) cannot be kept: say so, '
  + 'still analyse its screenshot, and write no block for it. '
  + 'After all your text, only when you read numbers of a post you matched (and again, with the corrected value, when the user '
  + 'corrects a number: the latest wins), end the reply with one block the user never sees: ' + DIAG_MARK + ' newline, one line of JSON '
  + '{"items":[{"post_id":"<id from the pack>","image":<which screenshot of the message, 1 first>,"rates":{"<normalized key>":<number>},'
  + '"raw":{"<label as read>":"<value as read>"}}]}, newline, ```. Normalized keys: ' + [...RATE_KEYS, ...COUNT_KEYS].join(', ') + ' (fractions 0 to 1; '
  + 'avg_watch_seconds in seconds; counts are whole numbers). Only numbers you can read: a missing one is left out, never 0. At most ' + MAX_SCREENSHOT_POSTS
  + ' posts per reply.';
