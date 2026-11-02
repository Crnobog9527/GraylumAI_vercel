/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import type {HostTurnContext} from './hostTurn';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Model-input projection only. The complete immutable material and its hash remain frozen for authorization/replay. */
export function checklistMaterial(material: unknown, host: HostTurnContext): unknown {
  if (host.materialProjection !== 'checklist-dedup-v1') return material;
  const scope = object(material), content = object(scope?.content), work = object(content?.work), steps = object(work?.steps);
  if (!scope || !content || !work || !steps) return material;
  const projected = Object.fromEntries(Object.entries(steps).map(([id, value]) => {
    const step = object(value), checklist = host.checklist.find(item => item.id === id);
    if (!step || !checklist) return [id, value];
    const information = object(step.information), metadata = object(step.fieldMeta);
    if (!information) return [id, value];
    const keptInformation = {...information}, keptMetadata = {...metadata};
    let changed = false;
    for (const field of checklist.fields) {
      const entry = object(information[field.id]), meta = object(metadata?.[field.id]);
      // Unknown properties, omitted values and differences remain complete data, never guessed equivalents.
      if (!entry || field.valueOmitted || Object.keys(entry).some(key => !['value', 'status', 'nature', 'basis'].includes(key)) ||
          (entry.status !== undefined && !['confirmed', 'deferred', 'provisional'].includes(String(entry.status))) ||
          entry.value !== field.value || (entry.nature ?? 'unknown') !== field.nature ||
          (entry.basis !== undefined && entry.basis !== field.basis)) continue;
      const status = entry.status === 'confirmed' || entry.status === 'deferred' ? entry.status
        : typeof entry.value === 'string' && entry.value.trim() ? 'draft' : 'missing';
      if (status !== field.status) continue;
      delete keptInformation[field.id];
      changed = true;
      // Only the known reconstructable field-state metadata. Pending proposal bodies/unknown keys stay intact.
      if (meta && Object.keys(meta).every(key =>
        ['source', 'basis', 'protected', 'hasPendingSuggestion', 'createdAt', 'executionId', 'origin'].includes(key)) &&
          meta.source === field.source && (meta.source === 'user' ? 'user_statement' : meta.basis ?? 'unknown') === field.basis &&
          meta.protected === field.protected && Boolean(meta.hasPendingSuggestion) === Boolean(field.hasPendingSuggestion))
        delete keptMetadata[field.id];
    }
    return [id, changed ? {...step, information: keptInformation, ...(metadata ? {fieldMeta: keptMetadata} : {}),
      informationFrom: 'Matching fields are in the current hostTurnContext.checklist; omitted values are not missing answers.'} : value];
  }));
  return {...scope, content: {...content, work: {...work, steps: projected}}};
}
