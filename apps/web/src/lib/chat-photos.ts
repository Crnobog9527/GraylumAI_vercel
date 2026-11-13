/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/*
 * Chat photos (Owner 2026-11-13: "用户上传的照片在聊天记录里面，应该要做到常驻长期保存呀"): the images a user sent are kept with their
 * message and shown with it when the conversation is read again. A message sent with images begins with this mark (the server's
 * imageMark), so the page only asks for photos when one does.
 */
export const PHOTO_MARK = '[截图';

/** The view route's cache: this user's browser only, and briefly. A photo deleted with its conversation must stop showing soon after
 * (Owner: "删对话即删"), so it is never kept for long even though its bytes never change. */
export const PHOTO_CACHE = 'private, max-age=300';

/** The photo addresses of each turn, in the order they were sent. */
export function photosOfTurns(photos: ReadonlyArray<{ turnId: number; index: number; src: string }>): Map<number, string[]> {
  const byTurn = new Map<number, Array<{ index: number; src: string }>>();
  for (const photo of photos) byTurn.set(photo.turnId, [...(byTurn.get(photo.turnId) ?? []), photo]);
  return new Map([...byTurn].map(([turn, list]) => [turn, list.sort((a, b) => a.index - b.index).map(photo => photo.src)]));
}
