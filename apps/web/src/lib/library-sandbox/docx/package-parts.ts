/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { decodeXmlText } from './xml-text';

/** OOXML relationship helpers over already-checked `.rels` text. */

export const RELATIONSHIP = /<Relationship\b[^>]*>/g;

export function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? decodeXmlText(match[1] ?? match[2]) : undefined;
}

export type Relationship = { id?: string; type: string; target: string; external: boolean };

export function relationships(xml: string | undefined): Relationship[] {
  return [...(xml ?? '').matchAll(RELATIONSHIP)].map(([tag]) => ({
    id: attribute(tag, 'Id'),
    type: attribute(tag, 'Type') ?? '',
    target: attribute(tag, 'Target') ?? '',
    external: attribute(tag, 'TargetMode') === 'External',
  }));
}

const dirname = (name: string) => (name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '');
export const relsName = (name: string) => `${dirname(name) ? `${dirname(name)}/` : ''}_rels/${name.slice(name.lastIndexOf('/') + 1)}.rels`;

/** mammoth's own join: a leading "/" is package-absolute, otherwise relative to `base`, no normalising. */
export function joinTarget(base: string, target: string): string {
  return target.startsWith('/') ? target.slice(1) : `${base ? `${base}/` : ''}${target}`;
}

const BODY_PARTS = ['comments', 'endnotes', 'footnotes', 'numbering', 'styles'];

/**
 * Every part mammoth reads as XML, found the way mammoth finds them (package relationships, the main
 * document's relationships, fixed fallbacks), whatever their file extension. A part named, say,
 * `word/styles.dat` is still parsed as XML, so it must pass the same XML guard.
 */
export function parserXmlParts(parts: Map<string, string>, names: Set<string>): { main: string; xml: string[] } {
  const mains = relationships(parts.get('_rels/.rels'))
    .filter((rel) => !rel.external && rel.type.endsWith('/officeDocument'))
    .map((rel) => joinTarget('', rel.target));
  const main = mains.find((name) => names.has(name)) ?? 'word/document.xml';
  const base = dirname(main);
  const related = relationships(parts.get(relsName(main)))
    .filter((rel) => !rel.external && BODY_PARTS.some((kind) => rel.type.endsWith(`/${kind}`)))
    .map((rel) => joinTarget(base, rel.target));
  const bodies = [...related, ...BODY_PARTS.map((kind) => `word/${kind}.xml`)];
  const xml = ['[Content_Types].xml', '_rels/.rels', ...mains, main, relsName(main), ...bodies, ...bodies.map(relsName)];
  return { main, xml: [...new Set(xml)].filter((name) => names.has(name)) };
}
