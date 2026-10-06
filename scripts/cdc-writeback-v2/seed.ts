/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import type { fixture } from '../../packages/api/src/scripts/cdcB2Fixture';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Initial = { stepId: string; fieldId: string; value: string; protected: boolean;
  suggestion?: { value: string; nature: string; basis: string } };

/** Only the existing loopback disposable fixture can call this helper. Seed provenance
 * via actual capture, and protected values via the actual manual information operation. */
export async function seedCase(f: Fixture, draftId: string, stepId: string, questionId: string, initial: Initial[]) {
  async function capture(patches: unknown[]) {
    if (!patches.length) return;
    const prepared = await f.service.prepareStep({ draftId, requestId: randomUUID(),
      purpose: 'mentor', stepId, questionId, input: 'Synthetic prior-state fixture; no provider call.' });
    const cancelled = await f.admin.rpc('runtime_cancel', { p_actor_id: f.actor, p_execution_id: prepared.executionId });
    if (cancelled.error) throw new Error('V2_SEED_CANCEL');
    await f.db.query(`update runtime_executions set state='completed',unavailable_reason=null,result=$2,
      payload=payload || jsonb_build_object('attachedOrganizer',$3::jsonb) where id=$1`,
    [prepared.executionId, { body: 'Synthetic prior state', summary: JSON.stringify({ inputKind: 'answer', patches, notes: [] }) },
      { input: JSON.stringify({ captureFormat: 'v2' }) }]);
    const applied = (await f.db.query('select opc_capture_apply($1,$2,$3) v',
      [f.actor, draftId, prepared.executionId])).rows[0].v;
    if (!['applied', 'suggested'].includes(applied.result)) throw new Error('V2_SEED_CAPTURE');
  }
  const patch = (row: Initial, value: string, nature = 'fact', basis = 'user_statement') =>
    ({ stepId: row.stepId, fieldId: row.fieldId, value, nature, basis, status: 'provisional' });
  await capture(initial.filter(row => !row.protected).map(row => patch(row, row.value)));
  for (const row of initial.filter(row => row.protected)) {
    const before = await f.service.read(draftId);
    await f.service.information({ draftId, requestId: randomUUID(), stepId: row.stepId,
      expectedVersion: before.snapshot.steps[row.stepId]!.version,
      values: { ...Object.fromEntries(before.information[row.stepId]!.schema.map((field: { id: string }) =>
        [field.id, before.information[row.stepId]!.values?.[field.id] ?? { value: '', status: 'unknown', nature: 'unknown' }])),
        [row.fieldId]: { value: row.value, nature: 'fact', status: 'provisional' } } });
  }
  await capture(initial.filter(row => row.suggestion).map(row =>
    patch(row, row.suggestion!.value, row.suggestion!.nature, row.suggestion!.basis)));
  const state = await f.service.read(draftId);
  for (const row of initial) {
    const value = state.information[row.stepId]?.values?.[row.fieldId]?.value;
    const meta = state.information[row.stepId]?.meta?.[row.fieldId];
    if (value !== row.value || meta?.protected !== row.protected ||
        row.suggestion && meta?.suggestion?.value !== row.suggestion.value) throw new Error('V2_SEED_STATE_MISMATCH');
  }
}
