/*
 * Copyright (c) 2026 Grayscale Luminary LLC.
 * All rights reserved.
 * This code is proprietary and confidential.
 */
/** Safe display-only summaries on the existing Agent turn stream; SQL remains recovery authority. */
export type AgentWorkKind = 'positioning' | 'library_search' | 'library_read' | 'my_benchmarks';
export type AgentToolEvent = {
  type: 'agent_tool'; callId: string; tool: 'read_source'; kind: AgentWorkKind;
  state: 'running' | 'done' | 'missing' | 'pending'; label: string; detail?: string;
};
