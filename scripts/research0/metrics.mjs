// Field extraction for RESEARCH-0. A field the vendor did not provide stays
// `undefined` and is reported as "未提供"; it is never coerced to zero.

export const FIELDS = {
  profile: ['id', 'name', 'handle', 'followers', 'following', 'postsCount', 'likesTotal', 'bio', 'verified'],
  posts: ['id', 'url', 'title', 'author', 'publishedAt', 'views', 'likes', 'comments', 'shares'],
  keyword: ['id', 'url', 'title', 'author', 'publishedAt', 'views', 'likes', 'comments', 'shares'],
  web: ['url', 'title', 'snippet', 'publishedAt'],
};

export const NOT_PROVIDED = '未提供';

/** Read a dotted path; returns undefined for absent, null or empty-string values. */
export function get(value, dotted) {
  let current = value;
  for (const part of dotted.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current) && /^\d+$/.test(part) ? current[Number(part)] : current[part];
  }
  if (current === null || current === undefined || current === '') return undefined;
  return current;
}

export function first(value, paths) {
  for (const dotted of paths) {
    const found = get(value, dotted);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Counts must be real numbers (or numeric strings); anything else is missing. */
export function count(value, paths) {
  const found = first(value, paths);
  if (typeof found === 'number' && Number.isFinite(found)) return found;
  if (typeof found === 'string' && /^\d+(\.\d+)?$/.test(found.trim())) return Number(found);
  return undefined;
}

/** Epoch seconds, epoch milliseconds or a parseable date string → ISO. */
export function timestamp(value, paths) {
  const found = first(value, paths);
  if (found === undefined) return undefined;
  let ms;
  if (typeof found === 'number' || (typeof found === 'string' && /^\d{9,13}$/.test(found))) {
    const numeric = Number(found);
    ms = numeric < 1e11 ? numeric * 1000 : numeric;
  } else if (typeof found === 'string') {
    ms = Date.parse(found);
  }
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

export function text(value, paths) {
  const found = first(value, paths);
  if (typeof found === 'string') return found;
  if (typeof found === 'number' || typeof found === 'boolean') return String(found);
  return undefined;
}

export function bool(value, paths) {
  const found = first(value, paths);
  return typeof found === 'boolean' ? found : undefined;
}

export function list(value, paths) {
  const found = first(value, paths);
  return Array.isArray(found) ? found : [];
}

/**
 * Per-field completeness over the normalized items. `present` counts items
 * where the vendor supplied a value; zero supplied by the vendor counts as
 * present, a missing value does not.
 */
export function completeness(kind, items) {
  const fields = FIELDS[kind] ?? [];
  const byField = {};
  for (const field of fields) {
    const present = items.filter(item => item[field] !== undefined && item[field] !== null).length;
    byField[field] = { present, total: items.length };
  }
  const provided = fields.filter(field => byField[field].present > 0);
  const missing = fields.filter(field => byField[field].present === 0);
  return { byField, provided, missing };
}

export function newest(items) {
  const times = items.map(item => item.publishedAt).filter(value => typeof value === 'string');
  if (times.length === 0) return NOT_PROVIDED;
  return times.sort().at(-1);
}

export function summarize(kind, items) {
  const { byField, provided, missing } = completeness(kind, items);
  return { itemCount: items.length, newestPublishedAt: newest(items), provided, missing, byField };
}
