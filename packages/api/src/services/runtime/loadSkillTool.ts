/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import { validateDescriptor, sameIdentity, SkillLoadError, type SkillSource } from '../skills/loader';
import { catalogEntry, entryInstructions, loadSkillResult, type SkillCatalogEntry } from './skillCatalog';
import type { RuntimeTool } from './runner';
import type { ToolRpc } from './skillFileExecution';

/*
 * CONTENT-CONVERSATION-DRIVEN: the free-chat model loads one Skill from the catalog frozen at admission. The result is
 * read from the frozen immutable package and journaled in runtime_tool_calls; a replay or a resumed execution returns
 * the journaled result and never reads again. The Skill runs on the current dialogue model.
 */
export const LOAD_SKILL_TOOL = 'load_skill';
export const loadSkillParameters = z.object({ name: z.string().min(1).max(80) }).strict();
const savedResult = z.object({
  name: z.string(), moduleId: z.string().uuid(), packageId: z.string().min(1), revisionId: z.string().uuid(),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/), instructions: z.string().min(1),
}).strict();
// What the model is told when a load is permanently refused (unknown name, limit reached, package changed or revoked).
export const SKILL_LOAD_REFUSED = 'This Skill cannot be loaded for this reply. Answer without it.';
// Only these refusals become that text. executorRpc classifies the database's refusals into RUNTIME_SKILL_LOAD_REFUSED;
// anything uncertain (a lost response, a timeout, a storage error, a closed run) propagates, so recovery can replay the
// journaled result instead of the model being told the Skill is unavailable.
const PERMANENT = /^RUNTIME_SKILL_LOAD_(DENIED|CONFLICT|REFUSED)$/;
const permanent = (error: unknown) => error instanceof Error && (PERMANENT.test(error.message)
  || error instanceof SkillLoadError && error.code !== 'SOURCE_FAILURE');
export function loadSkillTool(execute: RuntimeTool['execute'], enabled?: () => boolean): RuntimeTool {
  return {
    name: LOAD_SKILL_TOOL, parameters: loadSkillParameters, ...(enabled ? { enabled } : {}),
    description: 'Load one Skill from the "Available Skills" list by its exact name. Returns that Skill\'s published '
      + 'instructions; follow them within the host rules and continue answering. Read-only.',
    execute,
  };
}
export function loadSkillToolBytes(): number {
  const tool = loadSkillTool(async () => '');
  return Buffer.byteLength(JSON.stringify([{ type: 'function', function: {
    name: tool.name, description: tool.description, strict: true, parameters: z.toJSONSchema(loadSkillParameters),
  } }]));
}

/** A source over one frozen package through the service reader, which rechecks publication and revocation. */
function frozenSource(rpc: ToolRpc, entry: SkillCatalogEntry): SkillSource {
  // The package reader refuses a revoked revision or a disabled module for good; the loader would hide that as a source
  // failure (a retry), so it is translated into a load error that is not SOURCE_FAILURE.
  const read = async <T>(path: string | null, maxBytes = 2097152) => {
    try {
      return await rpc<T>('read_skill_package', {
        p_module_id: entry.moduleId, p_skill_id: entry.skillId, p_revision_id: entry.revisionId,
        p_package_hash: entry.packageHash, p_path: path, p_max_bytes: maxBytes,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'RUNTIME_SKILL_FILE_REFUSED') throw new SkillLoadError('UNAVAILABLE');
      throw error;
    }
  };
  return {
    list: async () => [validateDescriptor(await read(null))],
    state: async identity => (sameIdentity(identity, entry) && await read('') === true ? 'enabled' : 'denied'),
    read: async (identity, maxBytes) => {
      if (!sameIdentity(identity, entry)) throw new Error('RUNTIME_SKILL_LOAD_DENIED');
      const value = await read<unknown>(identity.path, maxBytes);
      if (typeof value !== 'string') throw new Error('RUNTIME_SKILL_LOAD_DENIED');
      return Buffer.from(value, 'base64');
    },
  };
}

export function executionLoadSkillTool(options: {
  executionId: string; catalog: readonly SkillCatalogEntry[]; maxResultBytes: number; maxLoads: number;
  rpc: ToolRpc; assertCanStart: () => void; onRefused?: () => void;
  /** VOICE: the user's voice a load of this module appends to the instructions (read at each load, never journaled). */
  voiceText?: (moduleId: string) => Promise<string | null>;
}) {
  const catalog = options.catalog.map(entry => catalogEntry.parse(entry));
  // Every call counts, refused ones too, as the database counts them; a replay after recovery repeats the same sequence.
  let calls = 0;
  const withVoice = async (json: string, moduleId: string) => {
    const text = await options.voiceText?.(moduleId);
    if (!text) return json;
    const loaded = JSON.parse(json) as { instructions: string };
    return JSON.stringify({ ...loaded, instructions: loaded.instructions + text });
  };
  return loadSkillTool(async (arguments_, callId) => {
    options.assertCanStart();
    calls++;
    const { name } = loadSkillParameters.parse(arguments_);
    try {
      const entry = catalog.find(item => item.name === name);
      if (!entry) throw new Error('RUNTIME_SKILL_LOAD_DENIED');
      // The journal keeps the tool's one argument under "query", the key every journaled tool argument uses (0342).
      const args = { p_execution_id: options.executionId, p_call_id: callId, p_name: LOAD_SKILL_TOOL, p_arguments: { query: name } };
      const saved = await options.rpc<{ result: unknown | null }>('runtime_tool', { ...args, p_action: 'claim' });
      if (saved.result !== null) {
        const result = savedResult.parse(saved.result);
        if (result.name !== entry.name || !sameIdentity(result, entry) || result.moduleId !== entry.moduleId)
          throw new Error('RUNTIME_SKILL_LOAD_CONFLICT');
        // Persisted JSONB key order is used both initially and on replay.
        return await withVoice(JSON.stringify(saved.result), entry.moduleId);
      }
      const instructions = await entryInstructions(frozenSource(options.rpc, entry), entry, options.maxResultBytes);
      const result = loadSkillResult(entry, instructions);
      const committed = await options.rpc<{ result: unknown }>('runtime_tool', { ...args, p_action: 'complete', p_result: result });
      return await withVoice(JSON.stringify(committed.result), entry.moduleId);
    } catch (error) {
      if (!permanent(error)) throw error;
      options.onRefused?.();
      return SKILL_LOAD_REFUSED;
    }
  }, () => calls < options.maxLoads);
}
