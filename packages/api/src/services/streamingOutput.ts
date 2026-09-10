/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { filterAIOutput } from './aiOutputFilter';

// Only checked, complete text boundaries leave the server. Retain a lookbehind
// for spaced numeric PII and incomplete tokens; never cut an email/key/JWT at
// an ASCII punctuation boundary. Private method output stays buffered in full.
export function createStreamingOutput(enabled: boolean, emit: (content: string) => void) {
  let sent = '', held = !enabled, checkedLength = 0;
  return (content: string) => {
    if (held || content.length - checkedLength < 64) return;
    checkedLength = content.length;
    // Assignment values may span whitespace or contain arbitrary punctuation.
    // An assignment opener switches this result to full-output checking.
    if (/\b(?:password|secret|api[_-]?key)\s*[:=]/i.test(content)) { held = true; return; }
    const checked = filterAIOutput(content);
    if (checked.blocked || checked.sanitized) { held = true; return; }
    const limit = content.length - 128;
    let end = 0;
    for (let i = Math.max(sent.length, 0); i < limit; i++) {
      if (/[\s。！？；]/u.test(content[i])) end = i + 1;
    }
    if (end <= sent.length) return;
    const candidate = content.slice(0, end);
    if (candidate.startsWith(sent)) { sent = candidate; emit(sent); }
  };
}
