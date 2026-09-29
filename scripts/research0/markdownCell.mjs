/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Plain text inside a Markdown table: preserve text without creating markup. */
export function markdownCell(value) {
  return String(value ?? '')
    .replace(/[\r\n\u2028\u2029]/gu, ' ')
    .replace(/[&<>\\|`*_\[\]~]/gu, character => `&#${character.codePointAt(0)};`);
}
