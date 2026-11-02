/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readTurnRouteEnv } from '../../lib/envValidator';
import { withPlatformSecretRequest } from '../platformSecrets/request';
import { withCatalogRequest } from '../turn/settings/catalogCache';
import { newWorkGate } from '../turn/admission/newWorkGate';
import type { ChatDeps } from '../turn/chat';
import { turnClients } from '../turn/db';
import { redisCounterStore } from '../turn/limiter';
import { runVoiceTurn } from '../turn/voice';
import { voiceRpc, type VoiceVersion } from './state';
import type { VoiceMaterial } from './profile';

export type VoiceGenerationDeps = { admin: SupabaseClient; actorId: string;
  /** Tests inject the turn's dependencies (transport, gates, counters); the host builds them from the environment. */
  chat?: ChatDeps };
type Begun = { replayed: boolean; version: VoiceVersion; material?: VoiceMaterial[] };
type Saved = VoiceVersion | { status: 'deleted' };
const ADMISSION_REFUSALS = new Set(['VOICE_MODEL_NOT_CONFIGURED', 'VOICE_MODEL_UNAVAILABLE']);

const hostDeps = (admin: SupabaseClient): ChatDeps => ({ admin, clients: turnClients(admin), slots: redisCounterStore(),
  newWork: newWorkGate(admin, readTurnRouteEnv().environment) });

/** 5.3 step 1–3: "学习我的文风". Freezes the corpus, makes one billed call on the summary model as a turn (kind=voice), parses the
 * answer by code and saves it as a draft (or stale, when the corpus changed meanwhile) in the turn's close. The user is charged what
 * the call cost, and only when a profile was saved; nothing is estimated or shown beforehand (Owner rule: no estimated charge on
 * the page). A turn that ends without a profile leaves the version failed, with the word the page shows for it. */
export async function generateVoiceProfile(deps: VoiceGenerationDeps, requestId: string, preferred: string[]): Promise<VoiceVersion> {
  const { admin, actorId } = deps;
  const begun = await voiceRpc<Begun>(admin, 'voice_generation_begin', { a: actorId, r: requestId, preferred });
  if (begun.replayed || !begun.material) return begun.version;
  const versionId = begun.version.id;
  // `settled` is a BILL2 column; the turn settles itself, so a version is always settled as far as the voice record goes.
  const finish = (failure: string | null) => voiceRpc<Saved>(admin, 'voice_generation_finish',
    { a: actorId, vid: versionId, result: null, failure_code: failure, settled: true });
  const outcome = await withPlatformSecretRequest(() => withCatalogRequest(() =>
    runVoiceTurn(deps.chat ?? hostDeps(admin), { actorId, requestId, versionId, material: begun.material! })));
  // A saved profile is read as the record has it; a failure is written (a no-op when the version was deleted or already finished).
  const saved = await finish(outcome.saved ? null : outcome.code);
  if (saved.status === 'deleted') throw new Error('VOICE_VERSION_GONE');
  // A model that is not configured or not admitted is a setting the user cannot change: refused, as the admission always did.
  if (!outcome.saved && ADMISSION_REFUSALS.has(outcome.code)) throw new Error(outcome.code);
  return saved as VoiceVersion;
}
