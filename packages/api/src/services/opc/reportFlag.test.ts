/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { withReportFlag } from './reportFlag';

const projectId = randomUUID(), roundId = randomUUID();
const manifest = { resources: ['SKILL.md'], sections: ['Secret section'], maxCharacters: 12000 };
const draft = () => ({ draftId: 'd', snapshot: { projectId, roundId, state: 'draft', workflow: { id: 'w', version: 8, steps: [] } as Record<string, unknown> } });

it.each([
  ['a configured frozen workflow', { workflow: { reportGeneration: manifest } }, true],
  ['a workflow without a report', { workflow: { steps: [] } }, false],
  ['a null manifest', { workflow: { reportGeneration: null } }, false],
  ['an empty answer', null, false],
])('reads the flag from the round of the read for %s', async (_, resolved, expected) => {
  const rpc = vi.fn(async () => resolved);
  const result = await withReportFlag(draft(), rpc);
  expect(rpc).toHaveBeenCalledWith('artifact_query', { p_action: 'resolve', p_project_id: projectId, p_round_id: roundId });
  expect(result.snapshot.workflow.reportGeneration).toBe(expected);
  // Only the flag leaves the server, never the manifest.
  expect(JSON.stringify(result)).not.toMatch(/Secret section|maxCharacters|SKILL\.md/);
  expect(result.snapshot.workflow).toMatchObject({ id: 'w', version: 8, steps: [] });
});

it('keeps the read and the old answer when the flag cannot be read', async () => {
  const result = await withReportFlag(draft(), async () => { throw new Error('artifact denied'); });
  expect(result.snapshot.workflow.reportGeneration).toBe(false);
  expect(result.snapshot.state).toBe('draft');
});

it('leaves a read without a snapshot untouched and makes no extra call', async () => {
  const rpc = vi.fn();
  const empty = { draftId: 'd', snapshot: null };
  expect(await withReportFlag(empty, rpc)).toBe(empty);
  const noIds = { snapshot: { workflow: { id: 'w' } } };
  expect(await withReportFlag(noIds, rpc)).toBe(noIds);
  expect(rpc).not.toHaveBeenCalled();
});
