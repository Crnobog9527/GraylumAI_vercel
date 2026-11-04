/* Copyright (c) 2026 Grayscale Luminary LLC. All rights reserved. */
import { GENERAL_RESEARCH_TOOLS } from '../../research/tools/names';
import { COACH_REVIEW_ID } from './coachReview';
import type { ToolStageEvent } from '../sse';

/*
 * What the page is told when the model's reply turns into a tool call (the reply has no text until the tool answers and the next
 * model call starts). Only the kind of tool, and for load_skill the Skill's public catalog name when the model named one of this
 * turn's Skills; no argument, query or result text ever goes into it.
 */
export function toolStage(name: string, args: Record<string, unknown>, skillNames: ReadonlySet<string>): ToolStageEvent {
  if (name === 'load_skill') {
    const asked = typeof args.name === 'string' ? args.name : '';
    return skillNames.has(asked) ? { type: 'tool', tool: 'load_skill', label: asked } : { type: 'tool', tool: 'load_skill' };
  }
  if ((GENERAL_RESEARCH_TOOLS as readonly string[]).includes(name)) return { type: 'tool', tool: 'research' };
  if (name === 'read_source') {
    return { type: 'tool', tool: typeof args.query === 'string' && COACH_REVIEW_ID.test(args.query) ? 'coach_review' : 'read_source' };
  }
  return { type: 'tool', tool: 'other' };
}
