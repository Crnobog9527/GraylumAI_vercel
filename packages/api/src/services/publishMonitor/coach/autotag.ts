/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/**
 * REVIEW-COACH RC-3: the pillar of a post that has none, taken from its own title by code (no model): a title that carries one pillar's
 * name ("【读书笔记】 …", "#读书笔记", or the name inside the text) belongs to that pillar; a title that carries two, or none, is left
 * for the model. Pure and deterministic, so the same facts always give the same tags.
 */
import type { Pillar } from './rows';

const MIN_NAME_CHARACTERS = 2;
/** The most auto tags one review saves (the save function takes 40 tags in all, the model's among them). */
export const MAX_AUTO_TAGS = 40;

const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');

/** The pillar a title names: exactly one, or null. */
export function pillarOfTitle(title: string | null, pillars: readonly Pillar[]): string | null {
  if (!title) return null;
  const text = normalize(title);
  const named = pillars.filter(p => {
    const name = normalize(p.name);
    return Array.from(name).length >= MIN_NAME_CHARACTERS && text.includes(name);
  });
  return named.length === 1 ? named[0]!.key : null;
}

/** Facts and recent posts with the pillars their titles name filled in where they had none; the tags to save are the new ones. */
export function tagFromTitles<T extends { postId: string; pillarKey: string | null; title: string | null }>(
  items: readonly T[], pillars: readonly Pillar[]): { items: T[]; tags: Array<{ post_id: string; pillar_key: string }> } {
  const tags: Array<{ post_id: string; pillar_key: string }> = [];
  const tagged = items.map(item => {
    if (item.pillarKey !== null) return item;
    const key = pillarOfTitle(item.title, pillars);
    if (key === null) return item;
    tags.push({ post_id: item.postId, pillar_key: key });
    // Automatic like the model's tags (pillar_source 'model'): the user can change it, and a later review never overwrites a tag.
    return { ...item, pillarKey: key, ...('pillarSource' in item ? { pillarSource: 'model' } : {}) };
  });
  return { items: tagged, tags };
}
