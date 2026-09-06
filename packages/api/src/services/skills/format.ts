import { parseDocument } from 'yaml';

export type FormatIssue =
  | 'FRONTMATTER_REQUIRED' | 'INVALID_YAML' | 'NAME_REQUIRED' | 'INVALID_NAME'
  | 'DIRECTORY_NAME_MISMATCH' | 'INVALID_DESCRIPTION' | 'INVALID_OPTIONAL_FIELD';
export type CompatibilityIssue = 'YAML_FEATURE_UNSUPPORTED' | 'TOOLS_UNSUPPORTED' | 'ENVIRONMENT_REVIEW_REQUIRED';
export interface SkillFormatReport {
  standard: { valid: boolean | null; issues: FormatIssue[] };
  compatibility: { supported: boolean; issues: CompatibilityIssue[] };
}

/** Diagnostics never include YAML values, parser exceptions, or rewritten source. */
export function inspectSkillFormat(source: string, directoryName: string): SkillFormatReport {
  return parseSkillEntry(source, directoryName).report;
}

export function parseSkillEntry(source: string, directoryName: string): {
  report: SkillFormatReport;
  metadata?: { name: string; description: string };
} {
  const issues: FormatIssue[] = [];
  const compatibility: CompatibilityIssue[] = [];
  const result = (metadata?: { name: string; description: string }) => ({
    report: {
      standard: { valid: issues.length ? false : metadata ? true : null, issues },
      compatibility: { supported: compatibility.length === 0, issues: compatibility },
    },
    metadata,
  });
  // Delimiter extraction only; YAML semantics belong to the maintained parser.
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) { issues.push('FRONTMATTER_REQUIRED'); return result(); }
  try {
    const doc = parseDocument(match[1], { uniqueKeys: true, prettyErrors: false, logLevel: 'silent' });
    if (doc.errors.length) { issues.push('INVALID_YAML'); return result(); }
    if (doc.warnings.length) compatibility.push('YAML_FEATURE_UNSUPPORTED');
    // No alias expansion, custom tags, repair, or serialization of the input.
    let value: unknown;
    try { value = doc.toJS({ maxAliasCount: 0 }); }
    catch { compatibility.push('YAML_FEATURE_UNSUPPORTED'); return result(); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push('INVALID_YAML'); return result();
    }
    const fields = value as Record<string, unknown>;
    const { name, description } = fields;
    if (typeof name !== 'string' || !name) issues.push('NAME_REQUIRED');
    else {
      if ([...name].length > 64 || !/^[\p{Ll}\p{Lo}\p{Nd}]+(?:-[\p{Ll}\p{Lo}\p{Nd}]+)*$/u.test(name)) issues.push('INVALID_NAME');
      if (name !== directoryName) issues.push('DIRECTORY_NAME_MISMATCH');
    }
    if (typeof description !== 'string' || !description.trim() || [...description].length > 1024) issues.push('INVALID_DESCRIPTION');
    if (fields.license !== undefined && typeof fields.license !== 'string') issues.push('INVALID_OPTIONAL_FIELD');
    if (fields.compatibility !== undefined) {
      if (typeof fields.compatibility !== 'string' || !fields.compatibility.trim() || [...fields.compatibility].length > 500) issues.push('INVALID_OPTIONAL_FIELD');
      // Free prose cannot automatically grant an environment capability.
      compatibility.push('ENVIRONMENT_REVIEW_REQUIRED');
    }
    if (fields.metadata !== undefined && (!fields.metadata || typeof fields.metadata !== 'object' || Array.isArray(fields.metadata) || Object.values(fields.metadata).some(v => typeof v !== 'string'))) issues.push('INVALID_OPTIONAL_FIELD');
    if (fields['allowed-tools'] !== undefined) {
      if (typeof fields['allowed-tools'] !== 'string') issues.push('INVALID_OPTIONAL_FIELD');
      else if (fields['allowed-tools'].trim()) compatibility.push('TOOLS_UNSUPPORTED');
    }
    // Unknown optional fields stay in the original bytes. They grant no capabilities.
    return result(typeof name === 'string' && typeof description === 'string' ? { name, description } : undefined);
  } catch {
    issues.push('INVALID_YAML');
    return result();
  }
}
