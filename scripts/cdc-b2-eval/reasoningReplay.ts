/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { readFileSync } from 'node:fs';
import type { fixture } from '../../packages/api/src/scripts/cdcB2Fixture';
import { readCaptureOutput } from '../../packages/api/src/shared/conversationCapture';

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Variant = { slot: string; effort: string; summary: string; finish: string };

/** Offline-only SQL replay. Every candidate starts at the SAME original before-state;
 * the transaction rolls back before the baseline conversation continues. */
export async function replayReasoning(f: Fixture, path: string, slot: string, draftId: string,
  executionId: string, raw: string) {
  if (!/^postgres:\/\/postgres@127\.0\.0\.1:\d+\/v3_disposable$/.test(process.env.V3_LOCAL_DB ?? '')) {
    throw new Error('REASONING_REPLAY_LOCAL_ONLY');
  }
  const variants: Variant[] = JSON.parse(readFileSync(path, 'utf8'));
  const input = JSON.parse(JSON.parse(raw).messages.at(-1).content.split('\n\nPrimary assistant reply:\n')[0]);
  const fields = Object.fromEntries(input.checklist.map((s: { id: string; fields: { id: string }[] }) =>
    [s.id, { schema: s.fields }]));
  const results = [];
  for (const variant of variants.filter(v => v.slot === slot)) {
    await f.db.query('begin');
    try {
      const receipt = await f.db.query("select 1 from artifact_requests where action='opc_capture' and payload->>'executionId'=$1", [executionId]);
      if (receipt.rowCount !== 0) throw new Error('REASONING_REPLAY_MUST_PRECEDE_CAPTURE');
      await f.db.query("update runtime_executions set result=jsonb_set(result,'{summary}',to_jsonb($2::text)) where id=$1",
        [executionId, variant.summary]);
      const capture = (await f.db.query('select opc_capture_apply($1,$2,$3) v', [f.actor, draftId, executionId])).rows[0].v;
      const after = (await f.db.query('select opc_query($1,$2) v', [f.actor, draftId])).rows[0].v;
      const parsed = readCaptureOutput(variant.summary, fields);
      const protectedChanges = input.checklist.flatMap((s: { id: string; fields: { id: string; protected: boolean; value: string }[] }) =>
        s.fields.filter(field => field.protected && (after.information[s.id]?.values?.[field.id]?.value ?? '') !== (field.value ?? '')));
      results.push({ slot, effort: variant.effort, summary: variant.summary, after, capture,
        formatError: variant.finish !== 'stop' || !parsed || parsed.discarded.length > 0 || parsed.invalidWithdrawals.length > 0,
        protectedDirectChanged: protectedChanges.length > 0 });
    } finally { await f.db.query('rollback'); }
  }
  return results;
}
