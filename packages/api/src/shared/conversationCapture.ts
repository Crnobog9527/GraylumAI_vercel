/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
/** Read-only projection of B1 output; SQL remains the write/permission authority. */
export type CaptureFields = Record<string, {schema: ReadonlyArray<{id: string}>}>;
export type CapturePatch = {stepId: string; fieldId: string; value: string;
  status: 'provisional'|'unclear'; nature: 'fact'|'decision'|'hypothesis'|'unknown';
  basis: 'user_statement'|'agent_proposal'};
export type CaptureInputKind = 'answer'|'acknowledgement'|'uncertainty'|'request'|'revision_request';
export type CaptureOutput = {inputKind: CaptureInputKind; patches: CapturePatch[]; discarded: number[]};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
export function readCaptureOutput(raw: string | null | undefined, fields: CaptureFields): CaptureOutput | null {
  let output: unknown;
  try { output = JSON.parse(raw ?? 'null'); } catch { return null; }
  if (!object(output) || typeof output.inputKind !== 'string' ||
      !['answer','acknowledgement','uncertainty','request','revision_request'].includes(output.inputKind) ||
      !Array.isArray(output.patches) || output.patches.length > 12 || !Array.isArray(output.notes)) return null;
  const patches: CapturePatch[] = [], discarded: number[] = [];
  output.patches.forEach((patch: unknown, index: number) => {
    // PostgreSQL char_length counts code points; btrim without a character set removes ASCII spaces only.
    if (!object(patch) || typeof patch.value !== 'string' || !patch.value.replace(/^ +| +$/g, '') ||
        Array.from(patch.value).length > 400 || typeof patch.status !== 'string' || !['provisional','unclear'].includes(patch.status) ||
        typeof patch.nature !== 'string' || !['fact','decision','hypothesis','unknown'].includes(patch.nature) ||
        typeof patch.basis !== 'string' || !['user_statement','agent_proposal'].includes(patch.basis) ||
        typeof patch.stepId !== 'string' || typeof patch.fieldId !== 'string' ||
        !Object.hasOwn(fields, patch.stepId) || !fields[patch.stepId]!.schema.some(field => field.id === patch.fieldId)) {
      discarded.push(index + 1); return;
    }
    patches.push({stepId: patch.stepId, fieldId: patch.fieldId, value: patch.value,
      status: patch.status as CapturePatch['status'], nature: patch.nature as CapturePatch['nature'],
      basis: patch.basis as CapturePatch['basis']});
  });
  return {inputKind: output.inputKind as CaptureInputKind, patches, discarded};
}
