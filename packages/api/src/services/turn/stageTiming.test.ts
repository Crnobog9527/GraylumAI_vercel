/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { afterEach, describe, expect, it, vi } from 'vitest';
const logged = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock('../../lib/logger', () => ({ logger: logged }));
import { markStage, noteStageTurn, reportStages, withStageTimer } from './stageTiming';

afterEach(() => { vi.restoreAllMocks(); logged.info.mockReset(); });

describe('the turn stage timing', () => {
  it('writes one line with the kind, outcome, turn number and millisecond numbers that add up to the total', async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    await withStageTimer('chat', async () => {
      now += 120; markStage('auth');
      now += 30; markStage('gate'); now += 20; markStage('gate');
      noteStageTurn(77);
      now += 400; reportStages('result');
      reportStages('again');
    });
    expect(logged.info).toHaveBeenCalledTimes(1);
    const [category, message, context] = logged.info.mock.calls[0]!;
    expect([category, message]).toEqual(['api', 'turn_stage_timing']);
    expect(context).toMatchObject({ kind: 'chat', outcome: 'result', turnId: 77, authMs: 120, gateMs: 50, endMs: 400, totalMs: 570 });
    // Only numbers and fixed words: no text, no account or session id.
    for (const [key, value] of Object.entries(context as Record<string, unknown>))
      expect(['kind', 'outcome'].includes(key) ? typeof value === 'string' : typeof value === 'number', key).toBe(true);
  });

  it('is silent outside a timer, and a later stage of the same async chain still finds its timer', async () => {
    markStage('auth'); noteStageTurn(1); reportStages('result');
    expect(logged.info).not.toHaveBeenCalled();
    await withStageTimer('mentor', async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      await Promise.resolve().then(() => markStage('open'));
      reportStages('TURN_RATE_LIMITED');
    });
    expect(logged.info.mock.calls[0]![2]).toMatchObject({ kind: 'mentor', outcome: 'TURN_RATE_LIMITED' });
    expect(logged.info.mock.calls[0]![2]).not.toHaveProperty('turnId');
  });
});
