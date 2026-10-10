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
  it('reads w:t, tabs and breaks, decodes entities, skips deleted text and field codes, dedupes', () => {
    const header = '<w:hdr><w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>&#x4E2D;</w:t></w:r>'
      + '<w:r><w:delText>gone</w:delText><w:instrText>PAGE</w:instrText></w:r></w:p></w:hdr>';
    const parts = new Map([
      ['word/header2.xml', header], ['word/header1.xml', header],
      ['word/footer1.xml', '<w:ftr><w:p><w:r><w:t>页脚</w:t><w:br/><w:t>2</w:t></w:r></w:p></w:ftr>'],
      ['word/document.xml', '<w:p><w:r><w:t>body</w:t></w:r></w:p>'],
    ]);
    expect(headerFooterText(parts)).toEqual({ headers: ['A&B\t中'], footers: ['页脚\n2'] });
  });
});

describe('SandboxError', () => {
  it('carries only a stable code', () => {
    expect(new SandboxError('ZIP_CRC').message).toBe('ZIP_CRC');
  });
});
