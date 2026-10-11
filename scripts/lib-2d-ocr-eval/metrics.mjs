export function norm(s, { dropPunct = false } = {}) {
  let t = s
    .normalize('NFKC')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[—–－]/g, '-')
    .replace(/\s+/g, '');
  if (dropPunct) t = t.replace(/[\p{P}\p{S}]/gu, '');
  return [...t];
}
export function lev(a, b) {
  const n = b.length;
  let prev = new Uint32Array(n + 1),
    cur = new Uint32Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const c = prev[j - 1] + (ai === b[j - 1] ? 0 : 1);
      const d = prev[j] + 1,
        e = cur[j - 1] + 1;
      cur[j] = c < d ? (c < e ? c : e) : d < e ? d : e;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
export function bag(ref, hyp) {
  const m = new Map();
  for (const c of ref) m.set(c, (m.get(c) || 0) + 1);
  let common = 0;
  for (const c of hyp) {
    const k = m.get(c);
    if (k) {
      common++;
      m.set(c, k - 1);
    }
  }
  return common;
}
export function score(refText, hypText) {
  const r = norm(refText),
    h = norm(hypText),
    rp = norm(refText, { dropPunct: true }),
    hp = norm(hypText, { dropPunct: true });
  return { refLen: r.length, edits: lev(r, h), refLenNP: rp.length, editsNP: lev(rp, hp), bagCommon: bag(r, h), hypLen: h.length };
}
