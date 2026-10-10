// Minimal two-column reading order for PaddleOCR boxes: full-width items on top, then left column, then right.
export function orderColumns(items) {
  const right = Math.max(...items.map((i) => i.box.x + i.box.width)),
    left0 = Math.min(...items.map((i) => i.box.x));
  const mid = (left0 + right) / 2,
    tol = (right - left0) * 0.02;
  const L = [],
    R = [],
    S = [];
  for (const i of items) {
    if (i.box.x + i.box.width < mid + tol) L.push(i);
    else if (i.box.x > mid - tol) R.push(i);
    else S.push(i);
  }
  if (L.length < 5 || R.length < 5 || S.length > (L.length + R.length) * 0.3) return null; // not a two-column page
  const med = (a) => a.map((i) => i.box.width).sort((x, y) => x - y)[a.length >> 1];
  if (med(L) < (right - left0) * 0.3 || med(R) < (right - left0) * 0.3) return null; // narrow cells = table, not text columns
  const byY = (a, b) => a.box.y - b.box.y || a.box.x - b.box.x;
  const top = Math.min(...[...L, ...R].map((i) => i.box.y));
  const head = S.filter((i) => i.box.y < top).sort(byY),
    tail = S.filter((i) => i.box.y >= top).sort(byY);
  return [...head, ...L.sort(byY), ...R.sort(byY), ...tail].map((i) => i.text).join('\n');
}
// Single-column fallback: group boxes into rows by vertical overlap, rows top-to-bottom, boxes left-to-right.
export function orderRows(items) {
  const rows = [];
  for (const i of [...items].sort((a, b) => a.box.y - b.box.y)) {
    const cy = i.box.y + i.box.height / 2;
    const row = rows.find((r) => Math.abs(r.cy - cy) < Math.min(r.h, i.box.height) * 0.5);
    if (row) row.items.push(i);
    else rows.push({ cy, h: i.box.height, items: [i] });
  }
  return rows
    .sort((a, b) => a.cy - b.cy)
    .map((r) =>
      r.items
        .sort((a, b) => a.box.x - b.box.x)
        .map((i) => i.text)
        .join(' '),
    )
    .join('\n');
}
