/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

// The formal legal texts (privacy, terms, cookies, refund) are the Owner's own documents, generated with Termly and
// adjusted to the product. They live as HTML files in apps/web/content/legal and are read at build time: the pages that
// show them are fully static, so the files are never read at request time.
export type LegalDocName = 'privacy' | 'terms' | 'cookies' | 'refund-policy';

const DIRECTORIES = ['content/legal', 'apps/web/content/legal'];

export function readLegalDoc(name: LegalDocName): string {
  for (const directory of DIRECTORIES) {
    try {
      return readFileSync(path.join(process.cwd(), directory, `${name}.html`), 'utf8');
    } catch {
      // Try the next location: the working directory is the app folder in a build and the repository root in tests.
    }
  }
  throw new Error(`Legal document not found: ${name}`);
}
