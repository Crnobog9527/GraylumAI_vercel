/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Minimal PDF writer for tests: objects are numbered from 1 in the order given and a classic
// cross-reference table is computed, so fixtures are byte-exact and readable in source form.
// Fonts are never embedded (text extraction does not need glyphs), so no font files are shipped.
import { deflateSync } from 'node:zlib';

export type PdfObject = string | { dict: string; stream: Buffer | string; deflate?: boolean };

export type BuildOptions = {
  root?: number;
  /** Extra trailer entries, e.g. `/Encrypt 9 0 R`. */
  trailer?: string;
  header?: string;
  /** Writes nonsense offsets into the cross-reference table (pdf.js must rebuild it). */
  brokenXref?: boolean;
};

export function buildPdf(objects: PdfObject[], options: BuildOptions = {}): Buffer {
  const parts: Buffer[] = [Buffer.from(`${options.header ?? '%PDF-1.7'}\n%\xE2\xE3\xCF\xD3\n`, 'latin1')];
  let length = parts[0].length;
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(length);
    let body: Buffer;
    if (typeof object === 'string') body = Buffer.from(`${index + 1} 0 obj\n${object}\nendobj\n`, 'latin1');
    else {
      const raw = typeof object.stream === 'string' ? Buffer.from(object.stream, 'latin1') : object.stream;
      const data = object.deflate ? deflateSync(raw) : raw;
      const filter = object.deflate ? ' /Filter /FlateDecode' : '';
      body = Buffer.concat([
        Buffer.from(`${index + 1} 0 obj\n<< ${object.dict}${filter} /Length ${data.length} >>\nstream\n`, 'latin1'),
        data,
        Buffer.from('\nendstream\nendobj\n', 'latin1'),
      ]);
    }
    parts.push(body);
    length += body.length;
  });
  const entries = offsets.map((offset) => `${String(options.brokenXref ? 999_999 : offset).padStart(10, '0')} 00000 n \n`);
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${entries.join('')}`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root ${options.root ?? 1} 0 R ${options.trailer ?? ''}>>\n`;
  parts.push(Buffer.from(`${xref}${trailer}startxref\n${options.brokenXref ? 7 : length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

/** Literal string for a simple (WinAnsi) font. */
export function latin(text: string): string {
  return `(${text.replace(/[\\()]/g, (char) => `\\${char}`)})`;
}

/** Big-endian UTF-16 hex string, for UCS2/UTF16 CMaps and Identity-H with matching ToUnicode. */
export function utf16Hex(text: string): string {
  let hex = '';
  for (let index = 0; index < text.length; index += 1) hex += text.charCodeAt(index).toString(16).padStart(4, '0');
  return `<${hex.toUpperCase()}>`;
}

let gbkTable: Map<string, number> | null = null;
/** GBK bytes as a hex string, for the GBK-EUC-H CMap (table built from the platform GBK decoder). */
export function gbkHex(text: string): string {
  if (!gbkTable) {
    gbkTable = new Map();
    const decoder = new TextDecoder('gbk');
    for (let lead = 0x81; lead <= 0xfe; lead += 1) {
      for (let trail = 0x40; trail <= 0xfe; trail += 1) {
        if (trail === 0x7f) continue;
        const char = decoder.decode(new Uint8Array([lead, trail]));
        if (char.length === 1 && char !== '�' && !gbkTable.has(char)) gbkTable.set(char, (lead << 8) | trail);
      }
    }
  }
  let hex = '';
  for (const char of text) {
    const code = char.charCodeAt(0) < 0x80 ? char.charCodeAt(0) : gbkTable.get(char);
    if (code === undefined) throw new Error(`no GBK code for ${char}`);
    hex += code.toString(16).padStart(code < 0x80 ? 2 : 4, '0');
  }
  return `<${hex.toUpperCase()}>`;
}

const CID_FONT = (base: string, registry: string, ordering: string, supplement: number) =>
  `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /${base} /CIDSystemInfo << /Registry (${registry}) /Ordering (${ordering}) `
  + `/Supplement ${supplement} >> /FontDescriptor << /Type /FontDescriptor /FontName /${base} /Flags 6 /FontBBox [0 -200 1000 900] `
  + '/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >> /DW 1000 >>';

/** Fonts available to `textDocument` pages, keyed by resource name. */
export const FONTS = {
  F1: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  F2: '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding /WinAnsiEncoding >>',
  SC: `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${CID_FONT('STSong-Light',
    'Adobe', 'GB1', 4)}] >>`,
  SU: `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UTF16-H /DescendantFonts [${CID_FONT('STSong-Light',
    'Adobe', 'GB1', 5)}] >>`,
  GB: `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /GBK-EUC-H /DescendantFonts [${CID_FONT('STSong-Light',
    'Adobe', 'GB1', 2)}] >>`,
  TC: `<< /Type /Font /Subtype /Type0 /BaseFont /MSung-Light /Encoding /UniCNS-UCS2-H /DescendantFonts [${CID_FONT('MSung-Light',
    'Adobe', 'CNS1', 3)}] >>`,
} as const;

export type FontName = keyof typeof FONTS;

/** A ToUnicode-mapped Identity-H font (the usual shape of subset-embedded CJK fonts): CID = UTF-16 code unit. */
export function identityFont(toUnicodeObject: number): string {
  return `<< /Type /Font /Subtype /Type0 /BaseFont /GraylumTestCJK /Encoding /Identity-H /ToUnicode ${toUnicodeObject} 0 R `
    + `/DescendantFonts [${CID_FONT('GraylumTestCJK', 'Adobe', 'Identity', 0)}] >>`;
}

export const IDENTITY_TO_UNICODE = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Graylum-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
1 beginbfrange
<0000> <FFFF> <0000>
endbfrange
endcmap
CMapName currentdict /CMapResource defineresource pop
end
end`;

export type PageSpec = {
  content: string;
  /** Extra page dictionary entries, e.g. `/Rotate 90` or `/Annots [...]`. */
  extra?: string;
  /** Extra resources entries, e.g. `/XObject << /Im1 12 0 R >>`. */
  resources?: string;
  mediaBox?: [number, number, number, number];
};

export type DocumentSpec = {
  pages: PageSpec[];
  /** Extra catalog entries, e.g. `/OpenAction 9 0 R`. */
  catalog?: string;
  /** Objects appended after the pages; refer to them as `extraBase + i`. */
  extraObjects?: (base: number) => PdfObject[];
  deflate?: boolean;
  build?: BuildOptions;
};

const FONT_BASE = 3;
const PAGE_BASE = FONT_BASE + Object.keys(FONTS).length + 2;

/** Object number of the first `extraObjects` entry in a `textDocument` with `pageCount` pages. */
export function firstExtraObject(pageCount: number): number {
  return PAGE_BASE + pageCount * 2;
}

/**
 * Catalog (1), page tree (2), every font in FONTS plus an Identity-H font and its ToUnicode map (3…),
 * then each page and its content stream, then `extraObjects` (numbered from `firstExtraObject`).
 */
export function textDocument(spec: DocumentSpec): Buffer {
  const fontNames = Object.keys(FONTS) as FontName[];
  const fontBase = FONT_BASE;
  const toUnicode = fontBase + fontNames.length + 1;
  const pageBase = PAGE_BASE;
  const extraBase = firstExtraObject(spec.pages.length);
  const fontRefs = [...fontNames.map((name, index) => `/${name} ${fontBase + index} 0 R`), `/ID ${fontBase + fontNames.length} 0 R`];
  const objects: PdfObject[] = [
    `<< /Type /Catalog /Pages 2 0 R ${spec.catalog ?? ''}>>`,
    `<< /Type /Pages /Kids [${spec.pages.map((_, index) => `${pageBase + index * 2} 0 R`).join(' ')}] /Count ${spec.pages.length} >>`,
    ...fontNames.map((name) => FONTS[name]),
    identityFont(toUnicode),
    { dict: '', stream: IDENTITY_TO_UNICODE },
  ];
  spec.pages.forEach((page, index) => {
    const box = page.mediaBox ?? [0, 0, 595, 842];
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [${box.join(' ')}] /Contents ${pageBase + index * 2 + 1} 0 R `
      + `/Resources << /Font << ${fontRefs.join(' ')} >> ${page.resources ?? ''}>> ${page.extra ?? ''}>>`);
    objects.push({ dict: '', stream: Buffer.from(page.content, 'latin1'), deflate: spec.deflate });
  });
  objects.push(...(spec.extraObjects?.(extraBase) ?? []));
  return buildPdf(objects, spec.build);
}

/** One line of text at (x, y) in `font` at `size` points; `encoded` is an already encoded PDF string. */
export function textLine(font: FontName | 'ID', size: number, x: number, y: number, encoded: string): string {
  return `BT /${font} ${size} Tf ${x} ${y} Td ${encoded} Tj ET\n`;
}

/** Encodes `text` for the given font resource. */
export function encodeFor(font: FontName | 'ID', text: string): string {
  if (font === 'F1' || font === 'F2') return latin(text);
  if (font === 'GB') return gbkHex(text);
  return utf16Hex(text);
}
