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
