/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
// PDF samples for the LIB-2c sandbox acceptance (must-test 18): hostile files that try to run
// script, open links, reach the network or exhaust the parser, plus the page classifications
// (text / scanned / blank) that LIB-2d builds on. `outside` is the URL of a listener that must never
// receive a request.
import { deflateSync } from 'node:zlib';
import { buildPdf, encodeFor, firstExtraObject, latin, textDocument, textLine, type PageSpec, type PdfObject } from './pdf-fixture';

const line = (text: string, y = 760) => textLine('F1', 12, 72, y, encodeFor('F1', text));
const cnLine = (text: string, y = 700) => textLine('SC', 12, 72, y, encodeFor('SC', text));

/** An image XObject that is never decoded (the sandbox records images, it does not decode them). */
const image = (width = 1700, height = 2200, filter = '/DCTDecode'): PdfObject => ({
  dict: `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter ${filter}`,
  stream: 'not really image data',
});
const draw = (name: string, w: number, h: number, x = 0, y = 0) => `q ${w} 0 0 ${h} ${x} ${y} cm /${name} Do Q\n`;

/** One page; `Im1` is an image XObject and `Fm1` a form that draws `Im1` over the whole page. */
function imagePage(content: string, extra: Partial<PageSpec> = {}, picture: PdfObject = image()): Buffer {
  const first = firstExtraObject(1);
  const form: PdfObject = { dict: `/Type /XObject /Subtype /Form /BBox [0 0 1 1] /Matrix [595 0 0 842 0 0] /Resources << /XObject << /Im1 ${first} 0 R >> >>`,
    stream: '/Im1 Do' };
  return textDocument({
    pages: [{ content, ...extra, resources: `/XObject << /Im1 ${first} 0 R /Fm1 ${first + 1} 0 R >>` }],
    extraObjects: () => [picture, form],
  });
}

export type ClassificationSample = { name: string; bytes: Buffer; statuses: string[]; text?: RegExp };

export function classificationSamples(): ClassificationSample[] {
  const tiles = Array.from({ length: 16 }, (_, index) => draw('Im1', 148.75, 210.5, (index % 4) * 148.75, Math.floor(index / 4) * 210.5)).join('');
  const mixedImage = firstExtraObject(4);
  return [
    { name: 'scanned page (full-page image, no text)', bytes: imagePage(draw('Im1', 595, 842)), statuses: ['scanned'] },
    { name: 'scanned page, rotated 90°', bytes: imagePage(draw('Im1', 595, 842), { extra: '/Rotate 90' }), statuses: ['scanned'] },
    { name: 'scanned page built from 16 tiles', bytes: imagePage(tiles), statuses: ['scanned'] },
    { name: 'scanned page inside a form XObject', bytes: imagePage('/Fm1 Do'), statuses: ['scanned'] },
    { name: 'scanned page as an inline image', bytes: textDocument({ pages: [{
      content: 'q 595 0 0 842 0 0 cm BI /W 4 /H 4 /CS /G /BPC 8 ID 0123456789abcdef EI Q\n' }] }), statuses: ['scanned'] },
    { name: 'image covering 60% of the page', bytes: imagePage(draw('Im1', 595, 505.2)), statuses: ['scanned'] },
    { name: 'image covering 40% of the page', bytes: imagePage(draw('Im1', 595, 336.8)), statuses: ['blank'] },
    { name: 'cover: full-page picture with a selectable title', bytes: imagePage(draw('Im1', 595, 842) + line('Annual Review', 420)),
      statuses: ['text'], text: /^Annual Review$/ },
    { name: 'section page with three characters', bytes: textDocument({ pages: [{ content: cnLine('第二章', 420) }] }),
      statuses: ['text'], text: /^第二章$/ },
    { name: 'full-page image drawn through a tiny clipping rectangle', bytes: imagePage(`q 10 10 20 20 re W n ${draw('Im1', 595, 842)}Q\n`),
      statuses: ['blank'] },
    { name: 'small logo, no text', bytes: imagePage(draw('Im1', 120, 60, 40, 760)), statuses: ['blank'] },
    { name: 'empty page', bytes: textDocument({ pages: [{ content: '' }] }), statuses: ['blank'] },
    { name: 'scan with an invisible OCR text layer', bytes: imagePage(`${draw('Im1', 595, 842)}BT 3 Tr /F1 12 Tf 72 760 Td `
      + `${latin('recognised words')} Tj ET\n`), statuses: ['text'], text: /^recognised words$/ },
    { name: 'mixed document keeps one slot per page', statuses: ['text', 'scanned', 'blank', 'text'], bytes: textDocument({
      pages: [
        { content: line('First page') },
        { content: draw('Im1', 595, 842), resources: `/XObject << /Im1 ${mixedImage} 0 R >>` },
        { content: '' },
        { content: cnLine('最后一页') },
      ],
      extraObjects: () => [image()],
    }), text: /^First page\f\f\f最后一页$/ },
  ];
}

export type HostileSample = {
  name: string;
  bytes: Buffer;
  /** Extracted normally (`ok`), a stable error `code`, or either of the listed outcomes (`settles`). */
  expect: { ok: true; text?: RegExp } | { code: string } | { settles: string[] };
};

const bomb = (bytes: number) => deflateSync(Buffer.alloc(bytes, 0x20), { level: 9 });
const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
const PAGE = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842]';

/** `pages` pages that all share one content stream (object 4). */
function sharedContent(pages: number, stream: Buffer): Buffer {
  return buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, index) => `${index + 5} 0 R`).join(' ')}] /Count ${pages} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    { dict: '/Filter /FlateDecode', stream },
    ...Array.from({ length: pages }, () => `${PAGE} /Contents 4 0 R /Resources << /Font << /F1 3 0 R >> >> >>`),
  ]);
}

function linksFormsAndAttachments(outside: string): Buffer {
  const url = (path: string) => latin(`${outside}/${path}`);
  const js = (path: string) => `<< /S /JavaScript /JS (app.launchURL\\("${outside}/${path}"\\); this.submitForm\\("${outside}/${path}-form"\\);) >>`;
  const first = firstExtraObject(1);
  const ref = (offset: number) => `${first + offset} 0 R`;
  const attachment = `<< /Type /Filespec /F (b.pdf) /EF << /F ${ref(5)} >> >>`;
  return textDocument({
    pages: [{ content: line('Links, forms and attachments'), extra: `/Annots [${[0, 1, 2, 3, 4].map(ref).join(' ')}] /AA << /O ${js('page-open')} >>` }],
    catalog: `/OpenAction ${js('open-action')} /AcroForm << /Fields [${ref(2)}] /XFA ${ref(6)} >> `
      + `/Names << /JavaScript << /Names [(a) ${js('names-js')}] >> /EmbeddedFiles << /Names [(b.pdf) ${attachment}] >> >>`,
    extraObjects: () => [
      `<< /Type /Annot /Subtype /Link /Rect [72 700 300 720] /A << /S /URI /URI ${url('uri')} >> >>`,
      `<< /Type /Annot /Subtype /Link /Rect [72 680 300 700] /A << /S /GoToR /F ${url('remote.pdf')} /D [0 /Fit] >> >>`,
      `<< /Type /Annot /Subtype /Widget /FT /Btn /T (send) /Rect [72 650 200 670] /A << /S /SubmitForm /F ${url('submit')} >> >>`,
      `<< /Type /Annot /Subtype /FileAttachment /Rect [72 620 92 640] /FS ${attachment} >>`,
      `<< /Type /Annot /Subtype /Link /Rect [72 600 300 620] /A ${js('annot-js')} >>`,
      { dict: '/Type /EmbeddedFile', stream: `%PDF-1.4 embedded ${outside}/embedded` },
      { dict: '', stream: '<xdp:xdp><template><subform><field><event activity="initialize"><script>'
        + `xfa.host.gotoURL("${outside}/xfa")</script></event></field></subform></template></xdp:xdp>` },
    ],
  });
}

/**
 * Objects 1..n written in order, then a cross-reference *stream* (object n + 1) declaring `size`
 * entries: real offsets for 1..n, `compressed[num] = [objectStream, index]` entries, the rest free.
 */
function xrefStreamPdf(objects: string[], size: number, compressed: Record<number, [number, number]> = {}): Buffer {
  const parts = [Buffer.from('%PDF-1.7\n', 'latin1')];
  const offsets = [0];
  let length = parts[0].length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`, 'latin1');
    parts.push(chunk);
    length += chunk.length;
  });
  const xrefNum = objects.length + 1;
  offsets.push(length);
  const rows = Buffer.alloc(size * 7);
  for (let num = 0; num < size; num += 1) {
    const at = num * 7;
    if (num >= 1 && num <= xrefNum) {
      rows[at] = 1;
      rows.writeUInt32BE(offsets[num], at + 1);
    } else if (compressed[num]) {
      rows[at] = 2;
      rows.writeUInt32BE(compressed[num][0], at + 1);
      rows.writeUInt16BE(compressed[num][1], at + 5);
    } else rows.writeUInt16BE(num === 0 ? 0xffff : 0, at + 5);
  }
  const data = deflateSync(rows);
  parts.push(Buffer.from(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /Length ${data.length} >>\nstream\n`,
    'latin1'), data, Buffer.from(`\nendstream\nendobj\nstartxref\n${length}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

export function hostileSamples(outside: string): HostileSample[] {
  const valid = textDocument({ pages: [{ content: line('Valid text survives') }] });
  // ~21 KB of visible text per page (300 short lines inside the page box; pdf.js skips text drawn off the page).
  const longText = `BT /F1 2 Tf 20 830 Td 2.6 TL ${Array.from({ length: 300 }, () => `${latin('x'.repeat(70))} '`).join(' ')} ET`;
  const many = (count: number) => textDocument({ pages: Array.from({ length: count }, (_, index) => ({ content: line(`page ${index + 1}`) })) });
  const onePage = (content: string, page = '') => buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `${PAGE} /Contents 4 0 R ${page}>>`, { dict: '', stream: content }]);
  return [
    { name: 'JavaScript, launch, URI, GoToR, SubmitForm, XFA and attachments', bytes: linksFormsAndAttachments(outside),
      expect: { ok: true, text: /^Links, forms and attachments$/ } },
    { name: 'launch action on open', bytes: textDocument({ pages: [{ content: line('Launch') }],
      catalog: `/OpenAction << /S /Launch /F ${latin(`${outside}/launch`)} /Win << /F (cmd.exe) /P (/c start ${outside}/win) >> >>` }),
    expect: { ok: true, text: /^Launch$/ } },
    { name: 'content stream stored in an external file (URL)', bytes: buildPdf(['<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `${PAGE} /Contents 4 0 R >>`,
      { dict: `/F << /FS /URL /F ${latin(`${outside}/external-stream`)} >>`, stream: '' }]), expect: { settles: ['ok', 'PDF_INVALID'] } },
    { name: '501 pages', bytes: many(501), expect: { code: 'PDF_PAGE_COUNT' } },
    { name: '500 pages (the limit) are accepted', bytes: many(500), expect: { ok: true, text: /^page 1\f[^]*\fpage 500$/ } },
    // pdf.js counts the real pages instead of trusting /Count, so this is a one-page document.
    { name: 'page tree claiming 2,000,000 pages', bytes: buildPdf(['<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 2000000 >>', `${PAGE} >>`]), expect: { ok: true, text: /^$/ } },
    { name: 'page tree that contains itself', bytes: buildPdf(['<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [2 0 R 3 0 R] /Count 2 >>', `${PAGE} >>`]), expect: { settles: ['ok', 'PDF_INVALID'] } },
    { name: 'page content that refers to itself', bytes: buildPdf(['<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `${PAGE} /Contents 4 0 R >>`, '[4 0 R 4 0 R]']), expect: { settles: ['ok', 'PDF_INVALID'] } },
    { name: '100,000 nested arrays in the content stream', bytes: onePage(`${nested(100_000)} pop\n`),
      expect: { settles: ['ok', 'PDF_INVALID'] } },
    { name: '100,000 nested arrays in the catalog', bytes: buildPdf([`<< /Type /Catalog /Pages 2 0 R /Deep ${nested(100_000)} >>`,
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `${PAGE} >>`]), expect: { settles: ['ok', 'PDF_INVALID'] } },
    { name: 'broken cross-reference table (rebuilt by the parser)', bytes: textDocument({ pages: [{ content: line('Rebuilt xref') }],
      build: { brokenXref: true } }), expect: { ok: true, text: /^Rebuilt xref$/ } },
    { name: 'cross-reference chain that loops', bytes: Buffer.from(valid.toString('latin1')
      .replace('trailer\n<< ', `trailer\n<< /Prev ${valid.toString('latin1').lastIndexOf('xref\n0 ')} `), 'latin1'),
    expect: { settles: ['ok', 'PDF_INVALID'] } },
    { name: 'truncated file', bytes: valid.subarray(0, Math.floor(valid.length / 2)), expect: { settles: ['ok', 'PDF_INVALID'] } },
    { name: 'not a PDF (web page renamed)', bytes: Buffer.from('<!doctype html><script>alert(1)</script>'), expect: { code: 'PDF_INVALID' } },
    { name: 'compression bomb in page content (60 MB inflated)', bytes: sharedContent(1, bomb(60_000_000)), expect: { code: 'PDF_STREAM_TOO_LARGE' } },
    { name: 'compression bomb in an object nobody reads', bytes: textDocument({ pages: [{ content: line('Unused bomb is ignored') }],
      extraObjects: () => [{ dict: '/Filter /FlateDecode', stream: bomb(60_000_000) }] }), expect: { ok: true, text: /^Unused bomb is ignored$/ } },
    { name: 'more than 10 MB of extracted text', bytes: sharedContent(500, deflateSync(Buffer.from(longText))), expect: { code: 'TEXT_TOO_LARGE' } },
    { name: 'Brotli-compressed content', bytes: buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `${PAGE} /Contents 4 0 R >>`, { dict: '/Filter /BrotliDecode', stream: 'xxxx' }]), expect: { code: 'PDF_UNSUPPORTED' } },
    { name: 'gigantic image dimensions (never decoded)', bytes: imagePage(draw('Im1', 595, 842), {}, image(1_000_000_000, 1_000_000_000)),
      expect: { ok: true } },
    { name: 'JBIG2 image (never decoded)', bytes: imagePage(draw('Im1', 595, 842), {}, image(800, 800, '/JBIG2Decode')), expect: { ok: true } },
    { name: '600,000 cross-reference entries', bytes: xrefStreamPdf(['<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `${PAGE} >>`], 600_000), expect: { code: 'PDF_OBJECT_COUNT' } },
    { name: 'object stream claiming 600,000 members', bytes: xrefStreamPdf(['<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', `${PAGE} /Contents 6 0 R >>`,
      '<< /Type /ObjStm /N 600000 /First 4 /Length 8 >>\nstream\n6 0 [ ]\n\nendstream'], 8, { 6: [4, 0] }),
    expect: { code: 'PDF_OBJECT_COUNT' } },
    { name: 'ordinary PDF whose text mentions /Encrypt 12 0 R', bytes: textDocument({ pages: [{ content: `${line('About encryption')}`
      + '% /Encrypt 12 0 R\n' }], extraObjects: () => ['(/Encrypt 12 0 R)'] }), expect: { ok: true, text: /^About encryption$/ } },
    { name: 'encryption dictionary in the trailer', bytes: textDocument({ pages: [{ content: line('locked') }],
      build: { trailer: '/Encrypt << /Filter /Standard /V 2 /R 3 /Length 128 /P -4 /O <00> /U <00> >>' } }), expect: { code: 'PDF_ENCRYPTED' } },
  ];
}

/** 500 pages sharing ~35 MB of path operators: far slower than any time budget used in tests. */
export function slowPdf(): Buffer {
  return sharedContent(500, deflateSync(Buffer.from('0 0 m 1 1 l S\n'.repeat(2_500_000)), { level: 9 }));
}

export function oversizedPdf(): Buffer {
  const pdf = textDocument({ pages: [{ content: line('big') }] });
  return Buffer.concat([pdf, Buffer.alloc(10_000_001 - pdf.length, 0x20)]);
}
