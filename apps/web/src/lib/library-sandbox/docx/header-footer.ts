/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/**
 * Page header and footer text. mammoth ignores headers and footers, so their already-checked XML
 * (see xml-guard) is read here: only `w:t` text, tabs and breaks; field codes, deleted text and
 * links are never followed.
 */

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

const RELATIONSHIP = /<Relationship\b[^>]*>/g;
const SECTION = /<w:sectPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:sectPr>)/g;
const REFERENCE = /<w:(header|footer)Reference\b[^>]*>/g;
const ON = (tag: string) => new RegExp(`<w:${tag}\\b(?![^>]*w:val\\s*=\\s*["'](?:0|false|off)["'])[^>]*>`);

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeXmlText(match[1] ?? match[2]) : undefined;
}

/** Joins a relationship target to the source part's folder; null for anything leaving the package. */
function resolveTarget(folder: string, target: string): string | null {
  const parts = target.startsWith('/') ? [] : folder.split('/').filter(Boolean);
  for (const piece of target.split('/')) {
    if (piece === '..') parts.pop();
    else if (piece && piece !== '.') parts.push(piece);
  }
  return parts.length ? parts.join('/') : null;
}

/** Header/footer parts actually used by the document's sections, in section order. */
function activeParts(parts: Map<string, string>): { kind: string; name: string }[] {
  const packageRels = parts.get('_rels/.rels') ?? '';
  const main = [...packageRels.matchAll(RELATIONSHIP)].map((match) => match[0])
    .find((tag) => attribute(tag, 'Type')?.endsWith('/officeDocument'));
  const mainName = (main && resolveTarget('', attribute(main, 'Target') ?? '')) || 'word/document.xml';
  const folder = mainName.includes('/') ? mainName.slice(0, mainName.lastIndexOf('/')) : '';
  const rels = parts.get(`${folder ? `${folder}/` : ''}_rels/${mainName.slice(folder.length ? folder.length + 1 : 0)}.rels`) ?? '';
  const targets = new Map<string, string>();
  for (const [tag] of rels.matchAll(RELATIONSHIP)) {
    const id = attribute(tag, 'Id');
    const target = attribute(tag, 'Target');
    if (!id || !target || attribute(tag, 'TargetMode') === 'External') continue;
    const resolved = resolveTarget(folder, target);
    if (resolved) targets.set(id, resolved);
  }
  const evenPages = ON('evenAndOddHeaders').test(parts.get(`${folder ? `${folder}/` : ''}settings.xml`) ?? '');
  const used: { kind: string; name: string }[] = [];
  for (const [section] of (parts.get(mainName) ?? '').matchAll(SECTION)) {
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
export function headerFooterText(parts: Map<string, string>): HeaderFooterText {
  const result: HeaderFooterText = { headers: [], footers: [] };
  const seen = new Set<string>();
  for (const { kind, name } of activeParts(parts)) {
    const lines = partLines(parts.get(name) ?? '');
    const key = `${kind}:${lines.join('\n')}`;
    if (lines.length === 0 || seen.has(key)) continue;
    seen.add(key);
    (kind === 'header' ? result.headers : result.footers).push(...lines);
  }
  return result;
}
