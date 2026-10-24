/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import {batchBytes, batchFiles, frozenDescriptor, sameIdentity, type SkillSource, SkillLoadError} from '../skills/loader';
import {readFrozenSkillFile, skillFileTool, type SkillFileBinding} from './skillFile';
import type {RequestTiming} from './timing';
export type ToolRpc = <T>(name: string, args: Record<string, unknown>) => Promise<T>;

/** The execution-owned tool claim precedes private reads; the SQL reader rechecks publication access. */
export function executionSkillFileTool(options: {
  executionId: string; moduleId: string; binding: SkillFileBinding;
  rpc: ToolRpc; assertCanStart: () => void; timing?: RequestTiming; onRefused?: () => void;
}) {
  const {binding} = options;
  const rpc: ToolRpc = async (name,args) => {
    try {return await options.rpc(name,args);} catch(error) {
      if(error instanceof Error&&error.message==='RUNTIME_SKILL_FILE_REFUSED')options.onRefused?.();
      throw error;
    }
  };
  const read = <T>(path: string | null, maxBytes = 2097152, paths?: readonly string[]) => rpc<T>('read_skill_package', {
    p_module_id: options.moduleId, p_skill_id: binding.packageId,
    p_revision_id: binding.revisionId, p_package_hash: binding.packageHash,
    p_path: path, p_max_bytes: maxBytes, ...(paths ? {p_paths: paths} : {}),
  });
  // DB-PERF PR-4: this source serves one execution request; after its state check passed (readFrozenSkillFile checks
  // first), a check-only readMany([]) in the same request reuses it. File reads always go to the package reader.
  let checked = false;
  const source: SkillSource = {
    // DB-PERF PR-4: the binding includes the packageHash, so its listing may come from the process cache;
    // readFrozenSkillFile still checks access (state, or the checked readMany) before returning any content.
    list: async () => [await frozenDescriptor(binding, () => read(null))],
    state: async identity => {
      if (!sameIdentity(identity, binding)) return 'denied';
      checked = false;
      checked = await read('') === true;
      return checked ? 'enabled' : 'denied';
    },
    read: async (identity, maxBytes) => {
      if (!sameIdentity(identity, binding)) throw new Error('RUNTIME_SKILL_FILE_DENIED');
      const value = await read<unknown>(identity.path, maxBytes);
      if (typeof value !== 'string') throw new Error('RUNTIME_SKILL_FILE_INVALID');
      return Buffer.from(value, 'base64');
    },
    readMany: async (identity, files) => {
      if (!sameIdentity(identity, binding)) throw new Error('RUNTIME_SKILL_FILE_DENIED');
      if (!files.length && checked) return new Map();
      const result = batchFiles(await read<unknown>(null, batchBytes(files), files.map(f => f.path)), files);
      checked = true;
      return result;
    },
  };
  return skillFileTool(async (arguments_, callId) => {
    options.assertCanStart();
    const args = {p_execution_id: options.executionId, p_call_id: callId,
      p_name: 'read_skill_file', p_arguments: arguments_};
    try {
    const saved = await rpc<{result: unknown | null}>('runtime_tool', {...args, p_action: 'claim'});
    const result = await readFrozenSkillFile({source, binding, arguments: arguments_, saved: saved.result});
    // Persisted JSONB key order is used both initially and on replay.
    if(saved.result!==null){
      options.timing?.tagSkillFileRead();
      return JSON.stringify(saved.result);
    }
    const committed = await rpc<{result: unknown}>('runtime_tool', {...args, p_action: 'complete', p_result: result});
    options.timing?.tagSkillFileRead();
    return JSON.stringify(committed.result);
    } catch(error) {
      if(error instanceof SkillLoadError&&error.code!=='SOURCE_FAILURE'||
        error instanceof Error&&/^RUNTIME_SKILL_FILE_(DENIED|TOO_LARGE|CONFLICT|INVALID)$/.test(error.message))options.onRefused?.();
      throw error;
    }
  });
}
