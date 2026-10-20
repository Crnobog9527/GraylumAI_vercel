/** Three-way merge of user edits. The edit baseline is never replaced by a read. */
export type InformationValue = { value: string; status: string; nature: string };
export type InformationValues = Record<string, InformationValue>;
const empty: InformationValue = { value: "", status: "unknown", nature: "unknown" };
function equal(a: InformationValue | undefined, b: InformationValue | undefined) {
  a ??= empty; b ??= empty;
  return a.value === b.value && a.status === b.status && a.nature === b.nature;
}
export function mergeInformation(base: InformationValues, edited: InformationValues, current: InformationValues) {
  const values = { ...Object.fromEntries(Object.keys(edited).map(key => [key, current[key] ?? { ...empty }])), ...current };
  const conflicts: string[] = [];
  for (const key of Object.keys(edited)) {
    if (equal(base[key], edited[key])) continue;
    if (!equal(current[key], base[key]) && !equal(current[key], edited[key])) {
      conflicts.push(key);
    } else values[key] = edited[key];
  }
  return { values, conflicts };
}
