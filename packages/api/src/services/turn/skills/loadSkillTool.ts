/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { z } from 'zod';
import type { RuntimeTool } from '../agent/runner';

/*
 * CONTENT-CONVERSATION-DRIVEN: the free-chat model loads one Skill from the catalog frozen at admission. The result is
 * read from the frozen immutable package and journaled in runtime_tool_calls; a replay or a resumed execution returns
 * the journaled result and never reads again. The Skill runs on the current dialogue model.
 */
export const LOAD_SKILL_TOOL = 'load_skill';
export const loadSkillParameters = z.object({ name: z.string().min(1).max(80) }).strict();
// What the model is told when a load is permanently refused (unknown name, limit reached, package changed or revoked).
export const SKILL_LOAD_REFUSED = 'This Skill cannot be loaded for this reply. Answer without it.';
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
