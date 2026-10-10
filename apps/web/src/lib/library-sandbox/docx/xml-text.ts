/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** The five predefined XML entities and numeric character references (no DTD entities exist here). */
const ENTITY = /&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const NAMED: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };

export function decodeXmlText(text: string): string {
  return text.replace(ENTITY, (entity) => {
    if (NAMED[entity]) return NAMED[entity];
    const code = entity[2] === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}
