/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import { databaseSkillSource } from '../skills/databaseSource';
import { activateFreeChatSkill } from '../skills/stepGuide';
import { readWorkspaceCapability } from '../runtime/workspacePosts';
import { compareRpc } from './compareAdmission';
import { compareRequest, compareRequestBytes, type CompareParts } from './compareSnapshot';
import type { CompareChoice } from './compareStart';
import { FUSION_INPUT_CAP } from './request';

/** What the browser sends to estimate or start a compare: the same Skill selection field as an ordinary turn. */
export const compareSkillInput = z.object({ kind: z.literal('skill'), moduleId: z.string().uuid(), revisionId: z.string().uuid(),
  task: z.string().max(128).optional() }).strict();
export type CompareRequestInput = { sessionId: string; question: string; modelIds: string[]; skill?: z.infer<typeof compareSkillInput> };

/** Earlier turns read for a compare, newest kept first when the snapshot must shrink to the input cap. */
const HISTORY_ITEMS = 200;
/** A Skill may use at most this share of the per-call input cap, leaving room for history and the question. */
const SKILL_BYTES = Math.floor(FUSION_INPUT_CAP / 2);
/** Workspace kinds a compare freezes: the confirmed positioning and account strategies (the bodies a free turn reads most). */
const WORKSPACE_KINDS = new Set(['positioning', 'strategy']);

const contextSchema = z.object({ revision: z.number().int().nonnegative(), busy: z.boolean(),
  items: z.array(z.object({ revision: z.number(), item: z.unknown() })), scopeMaterial: z.unknown().optional(),
  materialRevision: z.string() }).passthrough();

/** Visible text of one stored history item; null for tool calls, results and anything else that is not a message. */
export function historyTurn(item: unknown): CompareParts['history'][number] | null {
  if (!item || typeof item !== 'object') return null;
  const { role, content } = item as { role?: unknown; content?: unknown };
  if (role !== 'user' && role !== 'assistant') return null;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      && ['input_text', 'output_text'].includes(String((part as { type?: unknown }).type)))
      .map(part => (part as { text: string }).text).join('') : '';
  return text ? { role, text } : null;
}

/** The oldest turns go first until the request fits the per-call cap (the question itself is never cut: an oversized
 * question is refused by the size check later). Same direction as an ordinary turn's history selection. */
export function fitHistory(parts: CompareParts): CompareParts {
  let history = parts.history;
  const bytes = (h: CompareParts['history']) => compareRequestBytes(compareRequest({ ...parts, history: h, positioningFallback: true }));
  while (history.length && bytes(history) > FUSION_INPUT_CAP) history = history.slice(1);
  return { ...parts, history };
}

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

async function loadSkill(admin: SupabaseClient, user: SupabaseClient, skill: NonNullable<CompareRequestInput['skill']>) {
  const module = await admin.from('modules').select('id,active,skill_id,social_media_related').eq('id', skill.moduleId).single();
  if (module.error || module.data?.active !== true) throw new Error('FUSION_COMPARE_SKILL_INVALID');
  try {
    // The user-scoped check of an ordinary turn: the module is visible to this user, the revision exists for it.
    const source = databaseSkillSource({ userClient: user, privateClient: admin, moduleId: skill.moduleId,
      skillId: String(module.data.skill_id), revisionId: skill.revisionId });
    const descriptor = (await source.list()).find(d => d.revisionId === skill.revisionId);
    if (!descriptor) throw new Error('FUSION_COMPARE_SKILL_INVALID');
    // The whole free-chat activation (guide and steps' files): a compare column has no tools to read them later.
    const activated = await activateFreeChatSkill(source, descriptor, { task: skill.task, maxContextBytes: SKILL_BYTES });
    return { moduleId: skill.moduleId, revisionId: skill.revisionId, skillId: String(module.data.skill_id), instructions: activated.instructions,
      resources: activated.loaded.resourceIdentities().map(r => ({ path: r.path, hash: sha(`${skill.revisionId}:${r.path}`) })),
      socialMedia: module.data.social_media_related === true };
  } catch { throw new Error('FUSION_COMPARE_SKILL_INVALID'); }
}

/** The confirmed workspace sources an ordinary free turn could read with read_source, read up front (a compare has no tools). */
async function loadWorkspace(admin: SupabaseClient, actorId: string, sessionId: string): Promise<CompareParts['workspace']> {
  if (!await readWorkspaceCapability(admin, actorId, sessionId)) return [];
  const read = (query: string) => compareRpc<{ kind?: string; entries?: Array<{ id: string; kind: string }>; body?: unknown;
    dependencies?: string[] }>(admin, 'runtime_workspace_source', { p_actor_id: actorId, p_session_id: sessionId, p_query: query });
  const index = await read('');
  const sources: CompareParts['workspace'] = [];
  for (const entry of (index.entries ?? []).filter(e => WORKSPACE_KINDS.has(e.kind))) {
    const source = await read(String(entry.id));
    const versionId = source.dependencies?.[0];
    if (source.kind !== 'workspace_source' || !versionId) continue; // withdrawn in between: not part of this snapshot
    sources.push({ sourceVersionId: versionId, kind: entry.kind,
      body: typeof source.body === 'string' ? source.body : JSON.stringify(source.body) });
  }
  return sources;
}

/** Reads everything a compare freezes (FUSION-COMPARE §3.2): the conversation history and work material from one
 * transaction (fusion_compare_context), the selected Skill through the ordinary user-scoped checks, and the confirmed
 * workspace sources. Library references are not offered in the first version (compareStart refuses them). */
export async function loadCompareChoice(deps: { admin: SupabaseClient; user: SupabaseClient; actorId: string },
  input: CompareRequestInput): Promise<CompareChoice> {
  const { admin, actorId } = deps;
  const context = contextSchema.parse(await compareRpc<unknown>(admin, 'fusion_compare_context',
    { p_actor_id: actorId, p_session_id: input.sessionId, p_limit: HISTORY_ITEMS }));
  // A turn is running in the main conversation: its answer is not in the history yet, so a compare now would answer
  // a different conversation than the user sees once it lands.
  if (context.busy) throw new Error('FUSION_COMPARE_SESSION_BUSY');
  const [skill, workspace] = await Promise.all([
    input.skill ? loadSkill(admin, deps.user, input.skill) : null,
    loadWorkspace(admin, actorId, input.sessionId)]);
  const history = context.items.map(row => historyTurn(row.item)).filter((turn): turn is NonNullable<typeof turn> => turn !== null);
  const parts = fitHistory({ skill, positioningFallback: false, history, scopeMaterial: context.scopeMaterial ?? undefined,
    workspace, references: [], question: input.question });
  return { sessionId: input.sessionId, historyRevision: context.revision, modelIds: input.modelIds, parts,
    materialRevision: context.materialRevision };
}
