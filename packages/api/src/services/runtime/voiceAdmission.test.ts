/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { describe, expect, it } from 'vitest';
import { admitVoice, executionVoice, frozenVoiceProfile, withExecutionVoice } from './voiceAdmission';
import { VOICE_GUIDE, voiceAddendum, withPrimaryAddenda } from './primaryInstructions';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const profile = { tone: '口语', sentenceLength: '短', openings: '', stance: '', phrases: [], avoid: [], platforms: '',
  samples: ['第一段原文', '第二段原文'] };
function db(options: { flagged?: string[]; current?: unknown; read?: unknown; readError?: boolean } = {}) {
  const calls: string[] = [];
  return { calls, from: () => ({ select: () => ({ in: async (_: string, ids: string[]) => ({ error: null,
      data: ids.map(value => ({ id: value, uses_user_voice: (options.flagged ?? []).includes(value) })) }) }) }),
    rpc: async (name: string) => {
      calls.push(name);
      if (name === 'voice_profile_current') return { data: options.current ?? none, error: null };
      if (options.readError) return { data: null, error: { message: 'down' } };
      return { data: options.read ?? null, error: null };
    } };
}
const current = { enabled: true, versionId: id(9), version: 3 };
const none = { enabled: true, versionId: null, version: null };

describe('admitVoice', () => {
  it('freezes the confirmed version for flagged writing Skills only', async () => {
    const admitted = await admitVoice(db({ flagged: [id(1)], current, read: { profile } }) as never, id(5), [id(1), id(2)]);
    expect(admitted?.frozen).toEqual({ guide: VOICE_GUIDE, versionId: id(9), version: 3, modules: [id(1)] });
    expect(frozenVoiceProfile.safeParse(admitted?.frozen).success).toBe(true);
    expect(admitted?.profile?.samples).toHaveLength(2);
  });
  it('nothing when no module is flagged, no confirmed profile (or switched off), or the read fails', async () => {
    expect(await admitVoice(db({ current, read: { profile } }) as never, id(5), [id(1)])).toBeUndefined();
    const unflagged = db({ current, read: { profile } });
    await admitVoice(unflagged as never, id(5), [id(1)]);
    expect(unflagged.calls).toEqual([]);
    expect(await admitVoice(db({ flagged: [id(1)], current: { ...current, enabled: false, versionId: null, version: null } }) as never,
      id(5), [id(1)])).toBeUndefined();
    expect(await admitVoice(db({ flagged: [id(1)], current, readError: true }) as never, id(5), [id(1)])).toBeUndefined();
    expect(await admitVoice(db({ flagged: [id(1)], current, read: null }) as never, id(5), [id(1)])).toBeUndefined();
  });
});

describe('voice hint (Owner A)', () => {
  it('on but nothing confirmed: frozen without a version; the run gets the one-time hint with the library link', async () => {
    const admitted = await admitVoice(db({ flagged: [id(1)] }) as never, id(5), [id(1)]);
    expect(admitted).toEqual({ frozen: { guide: VOICE_GUIDE, modules: [id(1)] } });
    const voice = await executionVoice(db(), id(5), admitted!.frozen, id(1));
    expect(voice).toEqual({ guide: VOICE_GUIDE });
    expect(withPrimaryAddenda('SKILL', { voice })).toContain('(/app/library?tab=voice)');
  });
});

describe('executionVoice', () => {
  const frozen = frozenVoiceProfile.parse({ guide: VOICE_GUIDE, versionId: id(9), version: 3, modules: [id(1)] });
  it('reads the frozen version for the Skill that actually runs', async () => {
    expect(await executionVoice(db({ read: { profile } }), id(5), frozen, id(1))).toEqual({ guide: VOICE_GUIDE, profile });
    expect(await executionVoice(db({ read: { profile } }), id(5), frozen, id(2))).toBeUndefined();
    expect(await executionVoice(db({ read: { profile } }), id(5), undefined, id(1))).toBeUndefined();
  });
  it('a version deleted since admission is never read again: no voice text is produced', async () => {
    expect(await executionVoice(db({ read: null }), id(5), frozen, id(1))).toBeUndefined();
  });
  it('a run bound to a version that can no longer be read ends before any provider request (Owner: deleted means unusable)', async () => {
    const context = { voiceProfile: frozen };
    await expect(withExecutionVoice(db({ read: null }), id(5), 'SKILL', context, id(1))).rejects.toThrow('VOICE_SOURCE_DELETED');
    // Another Skill of the same run (not on the frozen list) is not bound to the version.
    expect(await withExecutionVoice(db({ read: null }), id(5), 'SKILL', context, id(2))).toBe('SKILL');
    expect(await withExecutionVoice(db({ read: { profile } }), id(5), 'SKILL', context, id(1))).toBe('SKILL' + voiceAddendum(profile));
  });
  it('the executor appends exactly the text admission sized', async () => {
    const voice = await executionVoice(db({ read: { profile } }), id(5), frozen, id(1));
    expect(withPrimaryAddenda('SKILL', { voice })).toBe('SKILL' + voiceAddendum(profile));
  });
});
