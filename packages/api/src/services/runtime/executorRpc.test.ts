/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
import { expect, it, vi } from 'vitest';
import { executorRpc } from './executorRpc';
import { logger } from '../../lib/logger';

it.each(['57014', 'PGRST202', 'private-unknown-code'])('logs safe RPC identity/code, never error text or payload (%s)', async code => {
  const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
  const id = '10000000-0000-4000-8000-000000000001';
  try {
    const rpc = executorRpc({ actor: async () => id,
      database: { rpc: async () => ({ data: null, error: { code, message: 'PRIVATE_DATABASE_TEXT', details: 'PRIVATE_DETAIL' } }) } });
    await expect(rpc('runtime_execution', { p_execution_id: id, p_action: 'complete', p_result: 'PRIVATE_BODY' }))
      .rejects.toThrow('RUNTIME_DATABASE_UNAVAILABLE');
    expect(error).toHaveBeenCalledWith('api', 'runtime_rpc_failed', {
      rpc: 'runtime_execution', action: 'complete', executionId: id,
      databaseCode: code === 'private-unknown-code' ? 'UNKNOWN' : code,
    });
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/PRIVATE_|private-unknown/);
  } finally { error.mockRestore(); }
});

// CONTENT-CONVERSATION-DRIVEN: load_skill's permanent refusals are told apart from uncertain failures, which stay retryable.
const execution = '10000000-0000-4000-8000-000000000001';
const refusing = (message: string) => executorRpc({ actor: async () => execution,
  database: { rpc: async () => ({ data: null, error: { code: '42501', message } }) } });
it.each(['RUNTIME_TOOL_DENIED', 'RUNTIME_TOOL_LIMIT', 'RUNTIME_TOOL_CONFLICT', 'RUNTIME_TOOL_RESULT_CONFLICT', 'RUNTIME_SKILL_LOAD_CONFLICT'])(
  'a database refusal of load_skill (%s) is a permanent load refusal', async message => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    try {
      await expect(refusing(message)('runtime_tool', { p_execution_id: execution, p_name: 'load_skill', p_action: 'claim' }))
        .rejects.toThrow('RUNTIME_SKILL_LOAD_REFUSED');
    } finally { error.mockRestore(); }
  });
it('keeps load_skill failures retryable when they are not a refusal, and a closed run is never answered with a refusal', async () => {
  const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
  try {
    for (const message of ['canceling statement due to statement timeout', 'RUNTIME_TOOL_CLOSED', 'connection reset'])
      await expect(refusing(message)('runtime_tool', { p_execution_id: execution, p_name: 'load_skill', p_action: 'complete' }))
        .rejects.toThrow('RUNTIME_DATABASE_UNAVAILABLE');
  } finally { error.mockRestore(); }
});
it('other tools keep their own mapping: a load_skill refusal message from another tool is not a load refusal', async () => {
  const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
  try {
    await expect(refusing('RUNTIME_TOOL_DENIED')('runtime_tool', { p_execution_id: execution, p_name: 'read_source', p_action: 'claim' }))
      .rejects.toThrow('RUNTIME_DATABASE_UNAVAILABLE');
  } finally { error.mockRestore(); }
});
