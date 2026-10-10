/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// Test-only builder of small, hand-written OOXML packages. Reuses the #549 ZIP writer so the
// malicious samples and the benign ones come from the same deterministic tool.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type ZipEntry = {
  name?: string; body?: string | Buffer; deflate?: boolean; declaredSize?: number;
  flags?: number; symlink?: boolean; badCrc?: boolean;
};
export const { zipFixture } = require('../../../../../../packages/api/src/services/__tests__/lib1/zip-fixture.cjs') as {
  zipFixture: (entries: ZipEntry[]) => Buffer;
};

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

export const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const run = (text: string) => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
export const para = (text: string, style?: string) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${run(text)}</w:p>`;

const STYLES = `${XML_HEAD}<w:styles xmlns:w="${W_NS}">${[1, 2, 3].map((level) =>
  `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/></w:style>`).join('')}
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style></w:styles>`;

export type DocxParts = {
  body: string;
  header?: string;
  footer?: string;
  footnotes?: string[];
  images?: Buffer[];
  hyperlinks?: string[];
  extra?: ZipEntry[];
  contentTypesExtra?: string;
  numbering?: string;
};

export function docxParts(parts: DocxParts): ZipEntry[] {
  const rels: string[] = [`<Relationship Id="rStyles" Type="${REL}/styles" Target="styles.xml"/>`];
  const sect: string[] = [];
  const entries: ZipEntry[] = [];
  if (parts.header !== undefined) {
    rels.push(`<Relationship Id="rH1" Type="${REL}/header" Target="header1.xml"/>`);
    sect.push('<w:headerReference w:type="default" r:id="rH1"/>');
    entries.push({ name: 'word/header1.xml', body: `${XML_HEAD}<w:hdr xmlns:w="${W_NS}">${para(parts.header)}</w:hdr>` });
  }
  if (parts.footer !== undefined) {
    rels.push(`<Relationship Id="rF1" Type="${REL}/footer" Target="footer1.xml"/>`);
    sect.push('<w:footerReference w:type="default" r:id="rF1"/>');
    entries.push({ name: 'word/footer1.xml', body: `${XML_HEAD}<w:ftr xmlns:w="${W_NS}">${para(parts.footer)}</w:ftr>` });
  }
  if (parts.footnotes?.length) {
    rels.push(`<Relationship Id="rFn" Type="${REL}/footnotes" Target="footnotes.xml"/>`);
    const notes = parts.footnotes.map((text, i) => `<w:footnote w:id="${i + 1}">${para(text)}</w:footnote>`).join('');
    entries.push({ name: 'word/footnotes.xml', body: `${XML_HEAD}<w:footnotes xmlns:w="${W_NS}">${notes}</w:footnotes>` });
  }
  if (parts.numbering !== undefined) {
    rels.push(`<Relationship Id="rNum" Type="${REL}/numbering" Target="numbering.xml"/>`);
    entries.push({ name: 'word/numbering.xml', body: `${XML_HEAD}<w:numbering xmlns:w="${W_NS}">${parts.numbering}</w:numbering>` });
  }
  (parts.images ?? []).forEach((image, i) => {
    rels.push(`<Relationship Id="rImg${i + 1}" Type="${REL}/image" Target="media/image${i + 1}.png"/>`);
    entries.push({ name: `word/media/image${i + 1}.png`, body: image });
  });
  (parts.hyperlinks ?? []).forEach((target, i) => {
    rels.push(`<Relationship Id="rLink${i + 1}" Type="${REL}/hyperlink" Target="${esc(target)}" TargetMode="External"/>`);
  });
  const document = `${XML_HEAD}<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" ${DRAWING_NS}><w:body>${parts.body}`
    + `<w:sectPr>${sect.join('')}</w:sectPr></w:body></w:document>`;
  return [
    { name: '[Content_Types].xml', body: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>'
      + '<Override PartName="/word/document.xml" '
      + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + `${parts.contentTypesExtra ?? ''}</Types>` },
    { name: '_rels/.rels', body: `${XML_HEAD}<Relationships xmlns="${PKG_REL}">`
      + `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', body: document, deflate: true },
    { name: 'word/_rels/document.xml.rels', body: `${XML_HEAD}<Relationships xmlns="${PKG_REL}">${rels.join('')}</Relationships>` },
    { name: 'word/styles.xml', body: STYLES },
    ...entries,
    ...(parts.extra ?? []),
  ];
}

export const buildDocx = (parts: DocxParts): Buffer => zipFixture(docxParts(parts));

const DRAWING_NS = [
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

/** An inline picture referencing `rImg<n>`. */
export const picture = (n: number) => `<w:r><w:drawing><wp:inline><wp:docPr id="${n}" name="p${n}"/>`
  + '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>'
  + `<pic:blipFill><a:blip r:embed="rImg${n}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

export const footnoteRef = (id: number) => `<w:r><w:footnoteReference w:id="${id}"/></w:r>`;
export const hyperlink = (n: number, text: string) => `<w:hyperlink r:id="rLink${n}">${run(text)}</w:hyperlink>`;
export const table = (rows: string[][]) => `<w:tbl>${rows.map((cells) =>
  `<w:tr>${cells.map((cell) => `<w:tc>${para(cell)}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;

/** A 1x1 transparent PNG. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
