/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import mammoth from 'mammoth';
import { SandboxError } from '../errors';
import { SANDBOX_LIMITS } from '../limits';
import { documentText, type DocxDocument, type DocxExtraction } from './document-text';
import { headerFooterText } from './header-footer';
import { checkXmlPart } from './xml-guard';
import { inspectZip } from './zip-guard';
import { rebuildZip, unwrapSimpleFields } from './zip-rewrite';

/**
 * `.docx` → plain text inside the sandbox Worker (LIB_DOCS_PLAN §4.1). Order matters: size limits,
 * then the container and every XML part are checked and measured, and only then does mammoth
 * (JSZip + xmldom) read the same bytes. External files and images are never opened.
 */

const MACRO_PART = /(?:^|\/)vba(?:Project\.bin|Data\.xml)$/i;
const NESTED_ARCHIVE = /\.(?:zip|docx|docm|dotx|dotm|xlsx|xlsm|xlsb|pptx|pptm|odt|ods|odp|jar|7z|rar|gz|tgz|tar|cab)$/i;

function checkPackage(names: string[], parts: Map<string, string>) {
  if (names.some((name) => MACRO_PART.test(name))) throw new SandboxError('DOCX_MACRO');
  if (names.some((name) => NESTED_ARCHIVE.test(name))) throw new SandboxError('DOCX_NESTED_ARCHIVE');
  const contentTypes = parts.get('[Content_Types].xml');
  if (contentTypes === undefined) throw new SandboxError('DOCX_INVALID');
  if (/macroEnabled/i.test(contentTypes)) throw new SandboxError('DOCX_MACRO');
}

async function readDocument(input: Uint8Array): Promise<DocxDocument> {
  let captured: DocxDocument | null = null;
  const arrayBuffer = input.slice().buffer;
  // Browser build reads `arrayBuffer`; the Node build (unit tests) reads `buffer`. Both use JSZip.
  const source = { arrayBuffer, buffer: input } as unknown as { arrayBuffer: ArrayBuffer };
  try {
    await mammoth.convertToHtml(source, {
      externalFileAccess: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
      // Capture the element tree; hand back an empty body so no HTML is produced.
      transformDocument: (document: DocxDocument) => {
        captured = document;
        return { ...document, children: [] };
      },
    });
  } catch {
    throw new SandboxError('DOCX_INVALID');
  }
  if (!captured) throw new SandboxError('DOCX_INVALID');
  return captured;
}

export async function extractDocx(input: Uint8Array): Promise<DocxExtraction> {
  if (input.byteLength === 0) throw new SandboxError('INPUT_EMPTY');
  if (input.byteLength > SANDBOX_LIMITS.maxInputBytes) throw new SandboxError('INPUT_TOO_LARGE');
  const zip = await inspectZip(input);
  const parts = new Map<string, string>();
  for (const [name, bytes] of zip.xmlParts) parts.set(name, checkXmlPart(bytes));
  checkPackage(zip.names, parts);
  const fields = new Map<string, string>();
  for (const [name, xml] of parts) {
    if (name.startsWith('word/') && xml.includes('<w:fldSimple')) fields.set(name, unwrapSimpleFields(xml));
  }
  const document = await readDocument(fields.size ? rebuildZip(zip.members, fields) : input);
  return documentText(document, headerFooterText(parts));
}
