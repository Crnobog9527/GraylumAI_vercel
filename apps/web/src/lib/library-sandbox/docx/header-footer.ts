/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Page header and footer text. mammoth ignores headers and footers, so their already-checked XML
 * (see xml-guard) is read here: only `w:t` text, tabs and breaks; field codes, deleted text and
 * links are never followed.
 */

const PART = /^word\/(header|footer)(\d*)\.xml$/;
const PARAGRAPH = /<w:p[\s>][\s\S]*?<\/w:p>/g;
const TOKEN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;
const ENTITY = /&(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;
const NAMED: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" };

export function decodeXmlText(text: string): string {
  return text.replace(ENTITY, (entity) => {
    if (NAMED[entity]) return NAMED[entity];
    const code = entity[2] === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function paragraphText(xml: string): string {
  let text = '';
  for (const match of xml.matchAll(TOKEN)) {
    if (match[1] !== undefined) text += decodeXmlText(match[1]);
    else text += match[0].startsWith('<w:tab') ? '\t' : '\n';
  }
  return text.trim();
}

export function partLines(xml: string): string[] {
  return [...xml.matchAll(PARAGRAPH)].map((match) => paragraphText(match[0])).filter(Boolean);
}

export type HeaderFooterText = { headers: string[]; footers: string[] };

/** Lines from every header/footer part in numeric order; identical parts (first/even/default) appear once. */
export function headerFooterText(parts: Map<string, string>): HeaderFooterText {
  const found = [...parts.keys()]
    .map((name) => ({ name, match: PART.exec(name) }))
    .filter((item): item is { name: string; match: RegExpExecArray } => item.match !== null)
    .sort((a, b) => Number(a.match[2] || 0) - Number(b.match[2] || 0));
  const result: HeaderFooterText = { headers: [], footers: [] };
  const seen = new Set<string>();
  for (const { name, match } of found) {
    const lines = partLines(parts.get(name) ?? '');
    const key = `${match[1]}:${lines.join('\n')}`;
    if (lines.length === 0 || seen.has(key)) continue;
    seen.add(key);
    (match[1] === 'header' ? result.headers : result.footers).push(...lines);
  }
  return result;
}
