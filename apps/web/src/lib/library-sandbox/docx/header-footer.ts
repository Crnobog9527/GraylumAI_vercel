/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Page header and footer text. mammoth ignores headers and footers, so their already-checked XML
 * (see xml-guard) is read here: only `w:t` text, tabs and breaks; field codes, deleted text and
 * links are never followed.
 */

import { attribute, joinTarget, relationships, relsName } from './package-parts';
import { decodeXmlText } from './xml-text';

const PARAGRAPH = /<w:p[\s>][\s\S]*?<\/w:p>/g;
const TOKEN = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?:\s[^>]*)?\/>/g;

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

const SECTION = /<w:sectPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:sectPr>)/g;
const REFERENCE = /<w:(header|footer)Reference\b[^>]*>/g;
const ON = (tag: string) => new RegExp(`<w:${tag}\\b(?![^>]*w:val\\s*=\\s*["'](?:0|false|off)["'])[^>]*>`);

/** Header/footer parts actually used by the main document's sections, in section order. */
function activeParts(parts: Map<string, string>, main: string): { kind: string; name: string }[] {
  const base = main.includes('/') ? main.slice(0, main.lastIndexOf('/')) : '';
  const targets = new Map<string, string>();
  for (const rel of relationships(parts.get(relsName(main)))) {
    if (rel.id && rel.target && !rel.external) targets.set(rel.id, joinTarget(base, rel.target));
  }
  const evenPages = ON('evenAndOddHeaders').test(parts.get(joinTarget(base, 'settings.xml')) ?? '');
  const used: { kind: string; name: string }[] = [];
  for (const [section] of (parts.get(main) ?? '').matchAll(SECTION)) {
    const firstPage = ON('titlePg').test(section);
    for (const [tag, kind] of section.matchAll(REFERENCE)) {
      const type = attribute(tag, 'w:type') ?? 'default';
      if ((type === 'first' && !firstPage) || (type === 'even' && !evenPages)) continue;
      const name = targets.get(attribute(tag, 'r:id') ?? '');
      if (name && parts.has(name) && !used.some((item) => item.name === name)) used.push({ kind, name });
    }
  }
  return used;
}

/**
 * Lines of the header/footer parts referenced by the document's sections (first-page and even-page
 * ones only when the document turns them on), in section order; identical parts appear once.
 * Orphaned parts left in the package are ignored.
 */
export function headerFooterText(parts: Map<string, string>, main = 'word/document.xml'): HeaderFooterText {
  const result: HeaderFooterText = { headers: [], footers: [] };
  const seen = new Set<string>();
  for (const { kind, name } of activeParts(parts, main)) {
    const lines = partLines(parts.get(name) ?? '');
    const key = `${kind}:${lines.join('\n')}`;
    if (lines.length === 0 || seen.has(key)) continue;
    seen.add(key);
    (kind === 'header' ? result.headers : result.footers).push(...lines);
  }
  return result;
}
