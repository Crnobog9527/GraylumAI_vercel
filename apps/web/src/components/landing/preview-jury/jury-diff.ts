/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */

/** One run of a redline: kept text, text the revision deletes, or text it adds. */
export type DiffPart = { type: 'same' | 'del' | 'ins'; text: string };

/**
 * Character-level redline of two short passages (a chapter excerpt is a few hundred characters at most), so it works
 * for Chinese without a word splitter. Kept runs shorter than four characters between changes are folded into the
 * change on both sides, so the marks read as phrases instead of scattered characters; when less than half of the
 * passage survives, only the shared start and end stay and the middle reads as one deletion and one addition.
 */
export function diffText(before: string, after: string): DiffPart[] {
  const a = Array.from(before);
  const b = Array.from(after);
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const raw: DiffPart[] = [];
  const add = (type: DiffPart['type'], text: string) => {
    const last = raw[raw.length - 1];
    if (last?.type === type) last.text += text;
    else raw.push({ type, text });
  };
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { add('same', a[i]); i += 1; j += 1; }
    else if (j < b.length && (i >= a.length || table[i][j + 1] >= table[i + 1][j])) { add('ins', b[j]); j += 1; }
    else { add('del', a[i]); i += 1; }
  }
  const kept = raw.filter(part => part.type === 'same').reduce((sum, part) => sum + Array.from(part.text).length, 0);
  return kept * 2 < Math.max(a.length, b.length) ? rewrite(a, b) : fold(raw);
}

function rewrite(a: string[], b: string[]): DiffPart[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end += 1;
  const parts: DiffPart[] = [
    { type: 'same', text: a.slice(0, start).join('') },
    { type: 'del', text: a.slice(start, a.length - end).join('') },
    { type: 'ins', text: b.slice(start, b.length - end).join('') },
    { type: 'same', text: a.slice(a.length - end).join('') },
  ];
  return parts.filter(part => part.text);
}

function fold(parts: DiffPart[]): DiffPart[] {
  const out: { del: string; ins: string; same: string }[] = [];
  for (const [index, part] of parts.entries()) {
    const between = index > 0 && index < parts.length - 1;
    const tiny = part.type === 'same' && between && Array.from(part.text).length < 4;
    if (part.type === 'same' && !tiny) { out.push({ del: '', ins: '', same: part.text }); continue; }
    const last = out[out.length - 1];
    const change = last && !last.same ? last : (out.push({ del: '', ins: '', same: '' }), out[out.length - 1]);
    if (tiny) { change.del += part.text; change.ins += part.text; }
    else change[part.type as 'del' | 'ins'] += part.text;
  }
  return out.flatMap<DiffPart>(group => group.same
    ? [{ type: 'same' as const, text: group.same }]
    : [
      ...(group.del ? [{ type: 'del' as const, text: group.del }] : []),
      ...(group.ins ? [{ type: 'ins' as const, text: group.ins }] : []),
    ]);
}
