/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { SandboxError } from '../errors';
import { XML_LIMITS } from '../limits';

/**
 * Checks one OOXML part before the parser library reads it (#549): strict UTF-8, no DTD or entity
 * declarations, bounded nesting depth and bounded markup tokens. Returns the decoded text.
 */

const DECODER = new TextDecoder('utf-8', { fatal: true });
const GT = 62;
const SLASH = 47;
const QUOTE = 34;
const APOSTROPHE = 39;

function decode(bytes: Uint8Array): string {
  if ((bytes[0] === 0xfe && bytes[1] === 0xff) || (bytes[0] === 0xff && bytes[1] === 0xfe)) {
    throw new SandboxError('XML_ENCODING');
  }
  try {
    return DECODER.decode(bytes);
  } catch {
    throw new SandboxError('XML_ENCODING');
  }
}

function skipTo(text: string, from: number, terminator: string): number {
  const end = text.indexOf(terminator, from);
  if (end < 0) throw new SandboxError('XML_MALFORMED');
  if (end - from > XML_LIMITS.maxTokenChars) throw new SandboxError('XML_TOKEN');
  return end + terminator.length;
}

/** Index just past the `>` closing the tag that starts at `start`, honouring quoted attribute values. */
function tagEnd(text: string, start: number): number {
  let quote = 0;
  const limit = Math.min(text.length, start + XML_LIMITS.maxTokenChars + 1);
  for (let j = start + 1; j < limit; j += 1) {
    const c = text.charCodeAt(j);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === QUOTE || c === APOSTROPHE) {
      quote = c;
    } else if (c === GT) {
      return j + 1;
    }
  }
  throw new SandboxError(limit < text.length ? 'XML_TOKEN' : 'XML_MALFORMED');
}

const DECLARED_ENCODING = /^<\?xml[^>]*\bencoding\s*=\s*["']([^"']+)["']/;

export function checkXmlPart(bytes: Uint8Array): string {
  const text = decode(bytes).replace(/^﻿/, '');
  const encoding = DECLARED_ENCODING.exec(text)?.[1];
  if (encoding && encoding.toLowerCase() !== 'utf-8' && encoding.toLowerCase() !== 'utf8') {
    throw new SandboxError('XML_ENCODING');
  }
  let depth = 0;
  let index = 0;
  for (;;) {
    const lt = text.indexOf('<', index);
    if (lt < 0) break;
    if (text.startsWith('<?', lt)) {
      index = skipTo(text, lt + 2, '?>');
    } else if (text.startsWith('<!--', lt)) {
      index = skipTo(text, lt + 4, '-->');
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new SandboxError('XML_MALFORMED');
      index = end + 3;
    } else if (text.startsWith('<!', lt)) {
      throw new SandboxError('XML_DTD');
    } else {
      const end = tagEnd(text, lt);
      if (text.charCodeAt(lt + 1) === SLASH) {
        depth -= 1;
        if (depth < 0) throw new SandboxError('XML_MALFORMED');
      } else if (text.charCodeAt(end - 2) !== SLASH) {
        depth += 1;
        if (depth > XML_LIMITS.maxDepth) throw new SandboxError('XML_DEPTH');
      }
      index = end;
    }
  }
  if (depth !== 0) throw new SandboxError('XML_MALFORMED');
  return text;
}
