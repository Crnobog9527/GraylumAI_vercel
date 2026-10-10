/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { crc32 as nodeCrc32, deflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import { crc32, inflateRaw, inspectZip, isSafeMemberName } from '../docx/zip-guard';
import { checkXmlPart } from '../docx/xml-guard';
import { headerFooterText } from '../docx/header-footer';
import { maliciousSamples } from './malicious-samples';
import { zipFixture } from './docx-fixture';

async function zipCode(bytes: Buffer): Promise<string> {
  try {
    await inspectZip(new Uint8Array(bytes));
  } catch (error) {
    return (error as SandboxError).code;
  }
  return 'ACCEPTED';
}

function xmlCode(xml: string | Uint8Array): string {
  try {
    checkXmlPart(typeof xml === 'string' ? new TextEncoder().encode(xml) : xml);
    return 'ACCEPTED';
  } catch (error) {
    return (error as SandboxError).code;
  }
}

describe('ZIP guard (#549 samples)', () => {
  it.each(maliciousSamples().filter((sample) => sample.stage === 'zip'))('$name → $code', async ({ bytes, code }) => {
    expect(await zipCode(bytes)).toBe(code);
  });

  it('accepts a benign member, measures its actual size and keeps XML parts', async () => {
    const zip = await inspectZip(new Uint8Array(zipFixture([
      { name: 'word/document.xml', body: '<w:document xmlns:w="urn:test"><w:t>中文</w:t></w:document>', deflate: true },
      { name: 'word/media/a.png', body: Buffer.from([1, 2, 3]) },
    ])));
    expect(zip.names).toEqual(['word/document.xml', 'word/media/a.png']);
    expect([...zip.xmlParts.keys()]).toEqual(['word/document.xml']);
    expect(zip.totalInflatedBytes).toBeGreaterThan(0);
  });

  it('refuses non-ASCII member names unless the UTF-8 flag is set', async () => {
    expect(await zipCode(zipFixture([{ name: 'word/wörd.xml', body: '<x/>' }]))).toBe('ZIP_PATH');
    expect(await zipCode(zipFixture([{ name: 'word/wörd.xml', body: '<x/>', flags: 0x800 }]))).toBe('ACCEPTED');
  });

  it('stops inflating as soon as the cap is passed', async () => {
    const bomb = deflateRawSync(Buffer.alloc(5_000_000));
    await expect(inflateRaw(new Uint8Array(bomb), 1_000)).rejects.toMatchObject({ code: 'ZIP_SIZE_MISMATCH' });
    const chunks = await inflateRaw(new Uint8Array(deflateRawSync(Buffer.from('hello'))), 5);
    expect(Buffer.concat(chunks).toString()).toBe('hello');
  });

  it('matches the Node CRC-32 and the safe path rules', () => {
    const data = randomBytes(10_000);
    expect(crc32([data.subarray(0, 3), data.subarray(3)])).toBe(nodeCrc32(data));
    expect(['word/document.xml', '[Content_Types].xml', 'word/'].every(isSafeMemberName)).toBe(true);
    expect(['', '../x', '/x', 'C:/x', 'a\\b', 'a/./b', 'a//b', 'a/../b', 'a\u0000b'].some(isSafeMemberName)).toBe(false);
  });
});

describe('XML guard', () => {
  it.each(maliciousSamples().filter((sample) => sample.stage === 'xml'))('$name → $code', ({ xml, code }) => {
    expect(xmlCode(xml!)).toBe(code);
  });

  it('accepts namespaced OOXML with quoted ">" in attributes, comments, PIs and CDATA', () => {
    expect(xmlCode('<?xml version="1.0" encoding="UTF-8"?><!-- c --><w:a b="1>2"><![CDATA[<x>]]><w:b/></w:a>')).toBe('ACCEPTED');
    expect(xmlCode('<x>'.repeat(64) + '</x>'.repeat(64))).toBe('ACCEPTED');
  });

  it('rejects non UTF-8 encodings and unbalanced markup', () => {
    expect(xmlCode('<?xml version="1.0" encoding="GBK"?><x/>')).toBe('XML_ENCODING');
    expect(xmlCode(new Uint8Array([0xff, 0xfe, 0x3c, 0x00]))).toBe('XML_ENCODING');
    expect(xmlCode(new Uint8Array([0x3c, 0x78, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x78, 0x3e]))).toBe('XML_ENCODING');
    expect(xmlCode('<x></y></x>')).toBe('XML_MALFORMED');
    expect(xmlCode('<x><y>')).toBe('XML_MALFORMED');
    expect(xmlCode('<x a="unterminated>')).toBe('XML_MALFORMED');
  });
});

describe('header and footer text', () => {
  const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const rels = (ids: string[]) => `<Relationships>${ids.map((id) =>
    `<Relationship Id="${id}" Type="${REL}/${id.startsWith('f') ? 'footer' : 'header'}" Target="${id}.xml"/>`).join('')}</Relationships>`;
  const packageRels = `<Relationships><Relationship Id="r1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const part = (text: string) => `<w:hdr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:hdr>`;

  it('reads w:t, tabs and breaks, decodes entities, skips deleted text and field codes, dedupes', () => {
    const header = '<w:hdr><w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>&#x4E2D;</w:t></w:r>'
      + '<w:r><w:delText>gone</w:delText><w:instrText>PAGE</w:instrText></w:r></w:p></w:hdr>';
    const parts = new Map([
      ['_rels/.rels', packageRels], ['word/_rels/document.xml.rels', rels(['h1', 'h2', 'f1'])],
      ['word/document.xml', '<w:body><w:sectPr><w:headerReference w:type="default" r:id="h1"/>'
        + '<w:footerReference w:type="default" r:id="f1"/></w:sectPr><w:sectPr><w:headerReference w:type="default" r:id="h2"/></w:sectPr></w:body>'],
      ['word/h1.xml', header], ['word/h2.xml', header],
      ['word/f1.xml', '<w:ftr><w:p><w:r><w:t>页脚</w:t><w:br/><w:t>2</w:t></w:r></w:p></w:ftr>'],
    ]);
    expect(headerFooterText(parts)).toEqual({ headers: ['A&B\t中'], footers: ['页脚\n2'] });
  });

  it('ignores orphaned parts and first/even-page parts the document does not turn on', () => {
    const document = (titlePg: string) => '<w:body><w:sectPr><w:headerReference w:type="default" r:id="h1"/>'
      + `<w:headerReference w:type="first" r:id="h2"/><w:headerReference w:type="even" r:id="h3"/>${titlePg}</w:sectPr></w:body>`;
    const base = (doc: string, settings = '') => new Map([
      ['_rels/.rels', packageRels], ['word/_rels/document.xml.rels', rels(['h1', 'h2', 'h3'])], ['word/document.xml', doc],
      ['word/settings.xml', settings], ['word/h1.xml', part('默认')], ['word/h2.xml', part('首页')], ['word/h3.xml', part('偶数页')],
      ['word/header9.xml', part('旧的已删除页眉')],
    ]);
    expect(headerFooterText(base(document(''))).headers).toEqual(['默认']);
    expect(headerFooterText(base(document('<w:titlePg w:val="0"/>'))).headers).toEqual(['默认']);
    expect(headerFooterText(base(document('<w:titlePg/>'), '<w:settings><w:evenAndOddHeaders/></w:settings>')).headers)
      .toEqual(['默认', '首页', '偶数页']);
  });
});

describe('SandboxError', () => {
  it('carries only a stable code', () => {
    expect(new SandboxError('ZIP_CRC').message).toBe('ZIP_CRC');
  });
});
